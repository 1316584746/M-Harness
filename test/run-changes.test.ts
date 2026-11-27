import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { langOf, parsePatch, sumChanges } from "../desktop/renderer/src/lib/diffView";
import { diffSnapshots, parseNameStatus, parseNumstat, snapshotWorkTree, trimPatch } from "../src/tools/run-changes";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "run-changes-"));
afterAll(() => {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* Windows 临时目录偶发 EPERM */
  }
});
const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: dir, stdio: "pipe" }).toString();

describe("解析 git 输出", () => {
  it("numstat：增删行数和二进制", () => {
    expect(parseNumstat("3\t1\ta.ts\0-\t-\timg.png\0")).toEqual([
      { path: "a.ts", added: 3, removed: 1, binary: false },
      { path: "img.png", added: 0, removed: 0, binary: true },
    ]);
  });
  it("name-status：新增 / 修改 / 删除", () => {
    const m = parseNameStatus("A\0new.txt\0M\0a.ts\0D\0old.txt\0");
    expect([m.get("new.txt"), m.get("a.ts"), m.get("old.txt")]).toEqual(["A", "M", "D"]);
  });
  it("trimPatch 去掉文件头、保留从 @@ 开始", () => {
    expect(trimPatch("diff --git a/x b/x\nindex 1..2\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n")).toBe("@@ -1 +1 @@\n-a\n+b\n");
  });
});

describe("界面上的 diff 解析", () => {
  it("行号、增删、块头", () => {
    const lines = parsePatch("@@ -10,3 +10,3 @@ foo\n ctx\n-old\n+new\n tail\n");
    expect(lines.map(l => l.kind)).toEqual(["hunk", "ctx", "del", "add", "ctx"]);
    expect(lines[1]).toMatchObject({ old: 10, new: 10 });
    expect(lines[2]).toMatchObject({ old: 11, text: "old" });
    expect(lines[3]).toMatchObject({ new: 11, text: "new" });
    expect(lines[4]).toMatchObject({ old: 12, new: 12 });
  });
  it("新文件整篇新增：不画块头，行号从 1 起", () => {
    const lines = parsePatch("@@ -0,0 +1,2 @@\n+a\n+b\n");
    expect(lines.map(l => [l.kind, l.new])).toEqual([["add", 1], ["add", 2]]);
  });
  it("语言按扩展名、合计", () => {
    expect(langOf("src/Foo.JAVA")).toBe("java");
    expect(sumChanges([{ added: 2, removed: 1 }, { added: 3, removed: 0 }])).toEqual({ added: 5, removed: 1 });
  });
});

describe("工作区快照对比", () => {
  it("新增、修改、删除、未跟踪文件都能比出来；不碰真正的 index", async () => {
    git("init", "-q");
    fs.writeFileSync(path.join(dir, "keep.txt"), "1\n2\n3\n");
    fs.writeFileSync(path.join(dir, "gone.txt"), "bye\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    const before = await snapshotWorkTree(dir);
    expect(before).toBeTruthy();

    fs.writeFileSync(path.join(dir, "keep.txt"), "1\nTWO\n3\n4\n");
    fs.rmSync(path.join(dir, "gone.txt"));
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "新文件.json"), '{"a":1}\n{"b":2}\n');
    const after = await snapshotWorkTree(dir);
    const { files, patches } = await diffSnapshots(before!, after!);

    const by = Object.fromEntries(files.map(f => [f.path, f]));
    expect(by["keep.txt"]).toMatchObject({ status: "M", added: 2, removed: 1 });
    expect(by["gone.txt"]).toMatchObject({ status: "D", added: 0, removed: 1 });
    expect(by["sub/新文件.json"]).toMatchObject({ status: "A", added: 2, removed: 0 });
    expect(patches["sub/新文件.json"]).toContain("+{\"a\":1}");
    expect(patches["keep.txt"]!.startsWith("@@")).toBe(true);
    // 仓库真正的暂存区没被动过：新文件仍是未跟踪
    expect(git("status", "--porcelain")).toContain("?? sub/");
  });

  it("没改动 → 空；不是 git 仓库 → undefined", async () => {
    const s = await snapshotWorkTree(dir);
    expect((await diffSnapshots(s!, s!)).files).toEqual([]);
    const plain = fs.mkdtempSync(path.join(os.tmpdir(), "not-git-"));
    expect(await snapshotWorkTree(plain)).toBeUndefined();
    fs.rmSync(plain, { recursive: true, force: true });
  });
});

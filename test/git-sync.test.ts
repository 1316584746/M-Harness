import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { detectBaseBranch, syncBaseBranch } from "../src/tools/git";

const roots: string[] = [];
const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "protocol.file.allow=always", ...a], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const commit = (dir: string, file: string, text: string) => {
  fs.writeFileSync(path.join(dir, file), text);
  git(dir, "add", ".");
  git(dir, "commit", "-m", `edit ${file}`);
};

let origin: string;
let work: string; // 被同步的克隆
let other: string; // 另一个人的克隆，用来往远端推新提交

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gitsync-"));
  roots.push(root);
  origin = path.join(root, "origin.git");
  git(root, "init", "--bare", "-b", "release", origin);
  other = path.join(root, "other");
  git(root, "clone", origin, other);
  commit(other, "a.txt", "1\n");
  git(other, "push", "origin", "HEAD:release");
  work = path.join(root, "work");
  git(root, "clone", origin, work);
});
afterAll(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

describe("基线分支同步", () => {
  it("探测：配置优先，其次远端默认分支", async () => {
    expect(await detectBaseBranch(work, "dev")).toBe("dev");
    expect(await detectBaseBranch(work)).toBe("release");
  });

  it("在 feature 分支上、工作区干净：切到基线分支并拉到最新", async () => {
    git(work, "switch", "-c", "feature/x");
    commit(other, "b.txt", "new\n");
    git(other, "push", "origin", "HEAD:release");
    const r = await syncBaseBranch(work, "release");
    expect(r).toMatchObject({ ok: true, base: "release", branch: "release", switched: true, pulled: true });
    expect(fs.readFileSync(path.join(work, "b.txt"), "utf8").trim()).toBe("new");
  });

  it("已经在基线分支：只拉取最新", async () => {
    commit(other, "c.txt", "c\n");
    git(other, "push", "origin", "HEAD:release");
    const r = await syncBaseBranch(work);
    expect(r).toMatchObject({ ok: true, branch: "release", switched: false, pulled: true });
    expect(fs.existsSync(path.join(work, "c.txt"))).toBe(true);
  });

  it("有未提交的改动：先 stash 暂存（含新文件）再切到基线分支，原分支上 stash pop 能恢复", async () => {
    git(work, "switch", "-c", "feature/x");
    fs.writeFileSync(path.join(work, "a.txt"), "dirty\n");
    fs.writeFileSync(path.join(work, "new.txt"), "untracked\n");
    commit(other, "b.txt", "new\n");
    git(other, "push", "origin", "HEAD:release");
    const r = await syncBaseBranch(work, "release");
    expect(r).toMatchObject({ ok: true, branch: "release", switched: true, pulled: true, stashed: 2 });
    expect(r.skipped).toContain("git stash pop");
    expect(git(work, "branch", "--show-current")).toBe("release");
    expect(git(work, "status", "--porcelain")).toBe("");
    expect(fs.existsSync(path.join(work, "new.txt"))).toBe(false);
    expect(git(work, "stash", "list")).toContain("关联仓库前自动暂存（feature/x）");
    git(work, "switch", "feature/x");
    git(work, "stash", "pop");
    expect(fs.readFileSync(path.join(work, "a.txt"), "utf8").trim()).toBe("dirty");
    expect(fs.readFileSync(path.join(work, "new.txt"), "utf8").trim()).toBe("untracked");
  });

  it("有未提交的改动、基线分支又切不过去：改动放回原处，不留在 stash 里", async () => {
    git(work, "switch", "-c", "feature/x");
    fs.writeFileSync(path.join(work, "a.txt"), "dirty\n");
    const r = await syncBaseBranch(work, "nope");
    expect(r.error).toContain("切换到 nope 失败");
    expect(git(work, "branch", "--show-current")).toBe("feature/x");
    expect(fs.readFileSync(path.join(work, "a.txt"), "utf8").trim()).toBe("dirty");
    expect(git(work, "stash", "list")).toBe("");
  });

  it("基线分支和远端分叉：不合并，报错", async () => {
    commit(work, "local.txt", "l\n");
    commit(other, "remote.txt", "r\n");
    git(other, "push", "origin", "HEAD:release");
    const r = await syncBaseBranch(work);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("拉取最新代码失败");
    expect(fs.existsSync(path.join(work, "remote.txt"))).toBe(false);
  });

  it("远端连不上：仍然切到本地的基线分支，说明没拉到最新", async () => {
    git(work, "switch", "-c", "feature/x");
    git(work, "remote", "set-url", "origin", path.join(path.dirname(work), "nope.git"));
    const r = await syncBaseBranch(work, "release");
    expect(r).toMatchObject({ ok: true, branch: "release", switched: true, pulled: false });
    expect(r.skipped).toContain("没能拉取远端");
  });

  it("基线分支不存在 / 目录不是仓库：报错", async () => {
    expect((await syncBaseBranch(work, "nope")).error).toContain("切换到 nope 失败");
    expect((await syncBaseBranch(path.join(path.dirname(work), "missing"))).error).toBe("目录不存在");
  });
});

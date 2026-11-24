import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { diffStat } from "../src/tools/git";

const git = (cwd: string, ...a: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const put = (dir: string, f: string, s: string) => fs.writeFileSync(path.join(dir, f), s);

describe("任务页「改动」统计", () => {
  it("功能分支上：已提交的也算（相对基线分支），不会因为提交了就变成 0", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-diff-"));
    git(dir, "init", "-b", "main");
    put(dir, "a.txt", "1\n2\n3\n");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "init");
    expect(await diffStat(dir)).toMatchObject({ files: 0, added: 0, deleted: 0 });

    git(dir, "checkout", "-b", "feature-x");
    put(dir, "a.txt", "1\n2\n3\n4\n5\n"); // +2
    put(dir, "b.txt", "x\ny\n"); // 新文件 +2
    git(dir, "add", ".");
    git(dir, "commit", "-m", "feat");

    // 全部已提交：旧算法（相对 HEAD）是 0，现在相对基线分支
    const s = await diffStat(dir, "main");
    expect(s).toMatchObject({ files: 2, added: 4, deleted: 0, base: "main" });

    // 再加一处未提交的修改 + 一个没 git add 的新文件
    put(dir, "a.txt", "1\n2\n3\n4\n"); // 相对 main：+1（比提交时少一行）
    put(dir, "c.txt", "new1\nnew2\nnew3\n");
    const s2 = await diffStat(dir, "main");
    expect(s2.files).toBe(3);
    expect(s2.added).toBe(1 + 2 + 3);
  });

  it("基线分支没配 / 配错：自动找 main 等，提交了也不是 0", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-diff-"));
    git(dir, "init", "-b", "main");
    put(dir, "a.txt", "1\n");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "init");
    git(dir, "checkout", "-b", "feat");
    put(dir, "a.txt", "1\n2\n3\n");
    git(dir, "commit", "-am", "x");
    expect(await diffStat(dir)).toMatchObject({ files: 1, added: 2, base: "main" });
    expect(await diffStat(dir, "no-such-branch")).toMatchObject({ files: 1, added: 2, base: "main" });
  });

  it("直接在基线分支上提交、还没推送：相对远端基线算", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mh-diff-"));
    const remote = path.join(root, "r.git");
    const dir = path.join(root, "w");
    fs.mkdirSync(remote);
    git(remote, "init", "--bare", "-b", "main");
    git(root, "clone", remote, dir);
    put(dir, "a.txt", "1\n");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "init");
    git(dir, "push", "-u", "origin", "main");
    put(dir, "a.txt", "1\n2\n3\n4\n");
    git(dir, "commit", "-am", "local only");
    expect(await diffStat(dir, "main")).toMatchObject({ files: 1, added: 3 });
  });

  it("就在基线分支上：只看未提交的改动", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mh-diff-"));
    git(dir, "init", "-b", "main");
    put(dir, "a.txt", "1\n");
    git(dir, "add", ".");
    git(dir, "commit", "-m", "init");
    put(dir, "a.txt", "1\n2\n");
    const s = await diffStat(dir, "main");
    expect(s).toMatchObject({ files: 1, added: 1, deleted: 0 });
    expect(s.base).toBe("main");
  });
});

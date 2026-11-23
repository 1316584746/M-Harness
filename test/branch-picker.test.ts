import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { branchInfo, switchBranch, validBranchName } from "../src/tools/git";

let base: string;
let work: string;
const git = (cwd: string, ...a: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd, encoding: "utf8" });

beforeAll(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "branchpick-"));
  const bare = path.join(base, "remote.git");
  fs.mkdirSync(bare);
  git(bare, "init", "--bare", "-b", "main");
  const seed = path.join(base, "seed");
  fs.mkdirSync(seed);
  git(seed, "init", "-b", "main");
  fs.writeFileSync(path.join(seed, "a.txt"), "one\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "init");
  git(seed, "remote", "add", "origin", bare);
  git(seed, "push", "origin", "main");
  git(seed, "switch", "-c", "feature/x");
  fs.writeFileSync(path.join(seed, "a.txt"), "two\n");
  git(seed, "commit", "-am", "x");
  git(seed, "push", "origin", "feature/x");
  work = path.join(base, "work");
  git(base, "clone", bare, work);
  git(work, "switch", "-c", "dev");
  git(work, "switch", "main");
});
afterAll(() => fs.rmSync(base, { recursive: true, force: true }));

describe("聊天输入框的分支选择", () => {
  it("branchInfo：当前分支、本地分支、只在远端有的分支", async () => {
    const i = await branchInfo(work);
    expect(i).toMatchObject({ isRepo: true, current: "main", dirty: false });
    expect(i.local).toEqual(["dev", "main"]);
    expect(i.remote).toEqual(["feature/x"]);
  });

  it("不是仓库 / 目录不存在 → isRepo=false", async () => {
    expect((await branchInfo(os.tmpdir())).isRepo).toBe(false);
    expect((await branchInfo(path.join(base, "nope"))).isRepo).toBe(false);
  });

  it("切到本地分支、再切到只在远端有的分支（自动建本地分支）", async () => {
    expect(await switchBranch(work, "dev")).toEqual({ ok: true, current: "dev" });
    const r = await switchBranch(work, "feature/x");
    expect(r).toEqual({ ok: true, current: "feature/x" });
    expect(fs.readFileSync(path.join(work, "a.txt"), "utf8").replace(/\r/g, "")).toBe("two\n");
    expect((await branchInfo(work)).remote).toEqual([]);
  });

  it("未提交的改动和目标分支冲突 → 拒绝并带回 git 的原因，不丢改动", async () => {
    await switchBranch(work, "main");
    fs.writeFileSync(path.join(work, "a.txt"), "local edit\n");
    const r = await switchBranch(work, "feature/x");
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/overwritten|local changes|覆盖|未提交/i);
    expect(fs.readFileSync(path.join(work, "a.txt"), "utf8").replace(/\r/g, "")).toBe("local edit\n");
    expect((await branchInfo(work)).dirty).toBe(true);
    git(work, "checkout", "--", "a.txt");
  });

  it("不存在的分支、不合法的名字都拒绝", async () => {
    expect((await switchBranch(work, "no-such-branch")).ok).toBe(false);
    for (const bad of ["--detach", "a b", "x;rm", "-f", "a..b", ""]) expect((await switchBranch(work, bad)).ok).toBe(false);
    expect(validBranchName("feature/x-1.2")).toBe(true);
  });
});

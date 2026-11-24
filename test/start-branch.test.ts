import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { branchSlug, featureBranchName, startFeatureBranch, validBranchName } from "../src/tools/git";
import { branchNote } from "../desktop/renderer/src/lib/actionSteps";

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

const DAY = new Date(2026, 10, 23, 13, 0, 0); // 2026-11-23

describe("开发分支名：feature-需求名称-日期", () => {
  it("格式 feature-需求名称-20261123", () => {
    expect(featureBranchName("导出报表", DAY)).toBe("feature-导出报表-20261123");
    expect(featureBranchName("导出报表", new Date(2026, 0, 5))).toBe("feature-导出报表-20260105");
  });
  it("空白和 git 不接受的符号换成 -，不会连着出现", () => {
    expect(branchSlug("【飞书】导出报表：支持 Excel / CSV？")).toBe("飞书-导出报表-支持-Excel-CSV");
    expect(branchSlug("a..b  c~d^e:f[g]")).toBe("a-b-c-d-e-f-g");
    expect(branchSlug("  --abc--  ")).toBe("abc");
  });
  it("太长的名字截断，空名字有兜底", () => {
    expect(Array.from(branchSlug("很".repeat(100))).length).toBe(40);
    expect(featureBranchName("???", DAY)).toBe("feature-dev-20261123");
  });
  it("生成的分支名是合法的（中文也行）", () => {
    for (const t of ["导出报表", "【需求】a b/c", "fix: x.lock"]) expect(validBranchName(featureBranchName(t, DAY))).toBe(true);
    expect(validBranchName("a b")).toBe(false);
  });
});

describe("startFeatureBranch：基于基线分支的最新代码新建开发分支", () => {
  let origin: string;
  let work: string;
  let other: string;
  beforeEach(() => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "startbr-"));
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

  it("在基线分支上：新建 feature-需求名称-日期 并切过去", async () => {
    const r = await startFeatureBranch(work, "release", "导出报表", { now: DAY });
    expect(r).toMatchObject({ ok: true, branch: "feature-导出报表-20261123", base: "release", created: true });
    expect(git(work, "branch", "--show-current")).toBe("feature-导出报表-20261123");
  });

  it("起点是远端最新的基线分支，哪怕本地基线分支落后；新分支不跟踪远端基线分支", async () => {
    commit(other, "b.txt", "new\n");
    git(other, "push", "origin", "HEAD:release");
    const r = await startFeatureBranch(work, "release", "导出报表", { now: DAY });
    expect(r.created).toBe(true);
    expect(fs.existsSync(path.join(work, "b.txt"))).toBe(true);
    expect(spawnSync("git", ["rev-parse", "--abbrev-ref", "@{upstream}"], { cwd: work, encoding: "utf8" }).status).not.toBe(0);
  });

  it("人在别的分支上：开发分支也是从基线分支起，不带别的分支的提交", async () => {
    git(work, "switch", "-c", "other-work");
    commit(work, "x.txt", "x\n");
    const r = await startFeatureBranch(work, "release", "导出报表", { now: DAY });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(fs.existsSync(path.join(work, "x.txt"))).toBe(false);
  });

  it("有未提交的改动：原样带到新分支，并提醒", async () => {
    fs.writeFileSync(path.join(work, "wip.txt"), "wip\n");
    const r = await startFeatureBranch(work, "release", "导出报表", { now: DAY });
    expect(r.ok).toBe(true);
    expect(r.skipped).toContain("未提交");
    expect(fs.readFileSync(path.join(work, "wip.txt"), "utf8").trim()).toBe("wip");
  });

  it("已经在这个需求的开发分支上（哪怕是前几天建的）：不再新建", async () => {
    await startFeatureBranch(work, "release", "导出报表", { now: new Date(2026, 10, 20) });
    const r = await startFeatureBranch(work, "release", "导出报表", { now: DAY });
    expect(r).toMatchObject({ ok: true, reused: true, branch: "feature-导出报表-20261120" });
    expect(git(work, "branch", "--list", "feature-*").split("\n").length).toBe(1);
  });

  it("同名分支已存在、人在别处：直接切过去，不重建", async () => {
    await startFeatureBranch(work, "release", "导出报表", { now: DAY });
    git(work, "switch", "release");
    const r = await startFeatureBranch(work, "release", "导出报表", { now: DAY });
    expect(r).toMatchObject({ ok: true, reused: true, branch: "feature-导出报表-20261123" });
  });

  it("基线分支没配时用远端默认分支", async () => {
    const r = await startFeatureBranch(work, undefined, "导出报表", { now: DAY });
    expect(r).toMatchObject({ ok: true, base: "release", created: true });
  });

  it("基线分支不存在：报错，不乱建", async () => {
    const r = await startFeatureBranch(work, "nope", "导出报表", { now: DAY });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("nope");
    expect(git(work, "branch", "--list", "feature-*")).toBe("");
  });

  it("没有远端的本地仓库：用本地基线分支", async () => {
    const solo = path.join(path.dirname(origin), "solo");
    fs.mkdirSync(solo);
    git(solo, "init", "-b", "main");
    commit(solo, "a.txt", "1\n");
    const r = await startFeatureBranch(solo, "main", "导出报表", { now: DAY });
    expect(r).toMatchObject({ ok: true, created: true, branch: "feature-导出报表-20261123" });
  });

  it("不是 git 目录：报错", async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), "nogit-"));
    roots.push(d);
    expect((await startFeatureBranch(d, "main", "x")).ok).toBe(false);
  });
});

describe("给 AI 的开发分支说明", () => {
  it("新建 / 沿用 / 失败 / 只读，各写一句", () => {
    const t = branchNote([
      { name: "web", ok: true, branch: "feature-a-20261123", base: "release", created: true },
      { name: "api", ok: true, branch: "feature-a-20261120", reused: true },
      { name: "lib", ok: false, error: "有冲突" },
      { name: "ro", ok: true, skipped: "只读" },
    ]);
    expect(t).toContain("## 开发分支");
    expect(t).toContain("web：已基于基线分支 release 的最新代码新建并切到 feature-a-20261123");
    expect(t).toContain("api：当前就在这个需求的开发分支 feature-a-20261120");
    expect(t).toContain("lib：新建开发分支失败（有冲突）");
    expect(t).toContain("ro：只读");
    expect(branchNote([])).toBe("");
  });
});

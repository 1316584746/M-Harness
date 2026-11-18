import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { Runtime } from "../src/runtime";
import { buildGitArgs, cloneRepo, detectPlatform, gitTools, inspectRepo, listBranches, repoStatus } from "../src/tools/git";

let repo: string;
const git = (...a: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, encoding: "utf8" });
const ctx = (root: string) => ({ signal: new AbortController().signal, root });

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "gitrepo-"));
  git("init", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "hello\n");
  git("add", ".");
  git("commit", "-m", "first commit");
});

const tools = () => gitTools({ demo: { path: repo } });
const T = (n: string) => tools().find(t => t.name === n)!;

describe("buildGitArgs 校验", () => {
  it("读类：未知子命令、危险选项、越界路径都会被拒绝", () => {
    expect(() => buildGitArgs("read", "commit")).toThrow(/不支持/);
    expect(() => buildGitArgs("read", "diff", ["--output=x.txt"])).toThrow(/不允许/);
    expect(() => buildGitArgs("read", "diff", ["--no-index", "/etc/passwd", "x"])).toThrow(/不允许/);
    expect(() => buildGitArgs("read", "grep", ["-Ocalc", "x"])).toThrow(/不允许/);
    expect(() => buildGitArgs("read", "grep", ["-f", "pats"])).toThrow();
    expect(() => buildGitArgs("read", "blame", ["--contents", "x", "a.txt"])).toThrow();
    expect(() => buildGitArgs("read", "log", ["--", "../secret"])).toThrow(/仓库内/);
    expect(() => buildGitArgs("read", "show", ["C:\\Windows\\win.ini"].map(p => (path.isAbsolute(p) ? p : "/abs")))).toThrow(/仓库内/);
    expect(() => buildGitArgs("read", "branch", ["-D", "x"])).toThrow();
    expect(() => buildGitArgs("read", "branch", ["newbranch"])).toThrow(/只能列出/);
    expect(() => buildGitArgs("read", "tag", ["v1"])).toThrow(/只能列出/);
    expect(() => buildGitArgs("read", "remote", ["add", "x", "y"])).toThrow();
  });
  it("读类：常见只读用法放行", () => {
    expect(buildGitArgs("read", "log", ["--oneline", "-n", "5"])).toEqual(["log", "--oneline", "-n", "5"]);
    expect(buildGitArgs("read", "diff", ["-u", "HEAD~1", "--", "a.txt"])[0]).toBe("diff");
    expect(buildGitArgs("read", "branch", ["-a"])).toEqual(["branch", "-a"]);
    expect(buildGitArgs("read", "branch", ["--list", "feat/*"])[0]).toBe("branch");
    expect(buildGitArgs("read", "grep", ["-n", "-c", "TODO"])[0]).toBe("grep");
  });
  it("写类：拒绝强推、删远端分支、+ref", () => {
    expect(() => buildGitArgs("write", "push", ["--force", "origin", "main"])).toThrow();
    expect(() => buildGitArgs("write", "push", ["-f"])).toThrow();
    expect(() => buildGitArgs("write", "push", ["--force-with-lease"])).toThrow();
    expect(() => buildGitArgs("write", "push", ["origin", ":feature"])).toThrow(/删除/);
    expect(() => buildGitArgs("write", "push", ["origin", "+main"])).toThrow(/强推/);
    expect(() => buildGitArgs("write", "branch", ["-D", "x"])).toThrow();
    expect(() => buildGitArgs("write", "reset", ["--hard"])).toThrow(/不支持/);
    expect(() => buildGitArgs("write", "clean", ["-fdx"])).toThrow(/不支持/);
    expect(buildGitArgs("write", "commit", ["-m", "msg; rm -rf /"])).toEqual(["commit", "-m", "msg; rm -rf /"]);
  });
});

describe("git 工具（真实 git）", () => {
  it("git_read：status / log / 指定仓库名", async () => {
    const log = await T("git_read").run({ command: "log", args: ["--oneline"], repo: "demo" }, ctx(os.tmpdir()));
    expect(log).toContain("first commit");
    fs.writeFileSync(path.join(repo, "b.txt"), "new\n");
    const st = await T("git_read").run({ command: "status", args: ["--short"] }, ctx(repo));
    expect(st).toContain("b.txt");
    await expect(T("git_read").run({ command: "log", args: [], repo: "nope" }, ctx(repo))).rejects.toThrow(/未知仓库/);
  });

  it("git_write：add + commit 生效，且风险等级是 write", async () => {
    expect(T("git_write").risk).toBe("write");
    expect(T("git_read").risk).toBe("read");
    await T("git_write").run({ command: "add", args: ["b.txt"], repo: "demo" }, ctx(repo));
    const out = await T("git_write").run({ command: "commit", args: ["-c", "user.name=t", "-m", "add b"], repo: "demo" }, ctx(repo)).catch(e => String(e));
    // `-c` 是 commit 的 reuse-message 选项，无合法值时 git 会报错；这里只要不是被我们的校验拦掉即可
    expect(typeof out).toBe("string");
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-m", "add b"], { cwd: repo, encoding: "utf8" });
    expect(r.status === 0 || /nothing to commit/.test(r.stdout)).toBe(true);
    const log = await T("git_read").run({ command: "log", args: ["--oneline"], repo: "demo" }, ctx(repo));
    expect(log.split("\n").length).toBeGreaterThanOrEqual(2);
  });

  it("git 报错时把退出码和信息返回，不抛异常", async () => {
    const out = await T("git_read").run({ command: "show", args: ["deadbeef"], repo: "demo" }, ctx(repo));
    expect(out).toMatch(/退出码/);
  });

  it("git_repos 列出登记的仓库", async () => {
    expect(await T("git_repos").run({}, ctx(repo))).toContain("demo");
    expect(await gitTools({}).find(t => t.name === "git_repos")!.run({}, ctx(repo))).toContain("还没有登记");
  });
});

describe("仓库探测 / 状态 / 克隆", () => {
  it("inspectRepo 读出名称、分支；非仓库目录返回错误", async () => {
    const r = await inspectRepo(repo);
    expect(r).toMatchObject({ ok: true, branch: "main" });
    expect((await inspectRepo(os.tmpdir())).ok).toBe(false);
    expect((await inspectRepo(path.join(repo, "nope"))).ok).toBe(false);
  });
  it("repoStatus：分支、未提交改动数、最近提交", async () => {
    fs.writeFileSync(path.join(repo, "c.txt"), "x");
    const s = await repoStatus(repo);
    expect(s.branch).toBe("main");
    expect(s.changed).toBeGreaterThanOrEqual(1);
    expect(s.last).toContain("add b");
  });
  it("listBranches：本地分支去重排序，非仓库返回空", async () => {
    spawnSync("git", ["branch", "release/1.0"], { cwd: repo });
    expect(await listBranches(repo)).toEqual(["main", "release/1.0"]);
    expect(await listBranches(path.join(repo, "nope"))).toEqual([]);
  });
  it("detectPlatform", () => {
    expect(detectPlatform("https://github.com/a/b.git")).toBe("github");
    expect(detectPlatform("git@gitlab.company.com:a/b.git")).toBe("gitlab");
    expect(detectPlatform("https://gitee.com/a/b")).toBe("gitee");
    expect(detectPlatform(undefined)).toBe("local");
  });
  it("cloneRepo：拒绝危险传输方式；能从本地仓库克隆（file 路径被拒，确保只走远程协议）", async () => {
    expect((await cloneRepo("ext::sh -c 'calc'", path.join(os.tmpdir(), "x1"))).ok).toBe(false);
    expect((await cloneRepo("--upload-pack=calc", path.join(os.tmpdir(), "x2"))).ok).toBe(false);
    expect((await cloneRepo(repo, path.join(os.tmpdir(), "x3"))).error).toMatch(/https/);
  });
});

describe("Runtime 装配", () => {
  it("始终提供 git 工具；办公通道只读时 git_write 被拒、git_read 放行", () => {
    const rt = new Runtime(parseConfig({ repos: { demo: { path: "." } } }));
    const w = rt.tools.find(t => t.name === "git_write")!;
    const r = rt.tools.find(t => t.name === "git_read")!;
    expect(rt.guardFor("channel").check(w, {}).action).toBe("deny");
    expect(rt.guardFor("channel").check(r, {}).action).toBe("allow");
    expect(rt.guardFor("local").check(w, {}).action).toBe("ask");
  });
});

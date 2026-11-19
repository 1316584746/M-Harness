import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { gitTools, repoByDir } from "../src/tools/git";

let repo: string;
const ctx = (root: string) => ({ signal: new AbortController().signal, root });

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), "gitro-"));
  const g = (...a: string[]) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: repo, encoding: "utf8" });
  g("init", "-b", "main");
  fs.writeFileSync(path.join(repo, "a.txt"), "hi\n");
  g("add", ".");
  g("commit", "-m", "first");
});

describe("仓库登记的新字段", () => {
  it("配置里的 readOnly / scriptRepo / branchTemplate / previewCmd / installCmd 不会被 schema 丢掉", () => {
    const c = parseConfig({ repos: { a: { path: "x", readOnly: true, scriptRepo: true, branchTemplate: "feature/{slug}", previewCmd: "npm run dev", installCmd: "yarn install" } } });
    expect(c.repos.a).toMatchObject({ readOnly: true, scriptRepo: true, branchTemplate: "feature/{slug}", previewCmd: "npm run dev", installCmd: "yarn install" });
  });

  it("git_repos 把这些字段原样给模型", async () => {
    const t = gitTools({ demo: { path: repo, readOnly: true, installCmd: "yarn install" } }).find(x => x.name === "git_repos")!;
    const out = JSON.parse(await t.run({}, ctx(repo)));
    expect(out[0]).toMatchObject({ name: "demo", readOnly: true, installCmd: "yarn install" });
  });

  it("只读仓库：git_write 拒绝（按名字、按当前目录都拦），git_read 照常", async () => {
    const tools = gitTools({ demo: { path: repo, readOnly: true } });
    const w = tools.find(x => x.name === "git_write")!;
    const r = tools.find(x => x.name === "git_read")!;
    await expect(w.run({ command: "add", args: ["."], repo: "demo" }, ctx("/elsewhere"))).rejects.toThrow(/只读/);
    await expect(w.run({ command: "add", args: ["."] }, ctx(repo))).rejects.toThrow(/只读/);
    expect(await r.run({ command: "status", args: [], repo: "demo" }, ctx(repo))).toContain("main");
  });

  it("没设只读的仓库照常能写", async () => {
    const w = gitTools({ demo: { path: repo } }).find(x => x.name === "git_write")!;
    await expect(w.run({ command: "add", args: ["."], repo: "demo" }, ctx(repo))).resolves.toBeTypeOf("string");
  });

  it("repoByDir 忽略大小写和末尾分隔符", () => {
    expect(repoByDir({ a: { path: repo } }, repo.toUpperCase() + path.sep)?.[0]).toBe("a");
    expect(repoByDir({ a: { path: repo } }, path.join(repo, "sub"))).toBeUndefined();
  });
});

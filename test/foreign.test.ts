import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Backend } from "../desktop/main/backend";
import { DbxBridge } from "../desktop/main/dbx";
import { loadForeignRepo } from "../desktop/main/foreign";
import { parseGithubUrl } from "../desktop/main/repo-import";
import { detectCatalogFormat, parseDshIndex } from "../desktop/shared/plugins";
import { pickVersion, satisfies } from "../desktop/shared/semver";

function fakeGithub(repos: Record<string, Record<string, string>>): typeof fetch {
  return (async (input: any) => {
    const url = String(input);
    const tree = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/git\/trees\//.exec(url);
    if (tree) {
      const files = repos[tree[1]];
      if (!files) return new Response("{}", { status: 404 });
      return new Response(JSON.stringify({ tree: Object.keys(files).map(p => ({ path: p, type: "blob" })) }), { status: 200 });
    }
    const raw = /^https:\/\/raw\.githubusercontent\.com\/([^/]+\/[^/]+)\/[^/]+\/(.+)$/.exec(url);
    if (raw) {
      const body = repos[raw[1]]?.[decodeURIComponent(raw[2])];
      return body === undefined ? new Response("", { status: 404 }) : new Response(body, { status: 200 });
    }
    return new Response("", { status: 404 });
  }) as typeof fetch;
}

const j = (v: unknown) => JSON.stringify(v);

const CODEX: Record<string, string> = {
  ".agents/plugins/marketplace.json": j({
    name: "cx",
    plugins: [
      { name: "demo", source: { source: "local", path: "./plugins/demo" }, policy: { installation: "AVAILABLE" }, category: "Productivity" },
      { name: "appsonly", source: { source: "local", path: "./plugins/appsonly" }, category: "Other" },
    ],
  }),
  "plugins/demo/.codex-plugin/plugin.json": j({ name: "demo", version: "1.0.0", description: "演示插件的说明", interface: { displayName: "演示插件" } }),
  "plugins/demo/skills/hello/SKILL.md": "---\nname: hello\ndescription: 打招呼\n---\n# Hello\n第一步",
  "plugins/demo/skills/hello/scripts/run.sh": "echo hi",
  "plugins/demo/.mcp.json": j({ mcpServers: { "demo-srv": { command: "npx", args: ["-y", "demo"] } } }),
  "plugins/demo/commands/ship.md": "---\ndescription: 发布\n---\n发布 $ARGUMENTS",
  "plugins/demo/hooks/hooks.json": "{}",
  "plugins/appsonly/.codex-plugin/plugin.json": j({ name: "appsonly", description: "只有应用连接器" }),
  "plugins/appsonly/.app.json": "{}",
};

describe("semver", () => {
  it("范围匹配和挑版本", () => {
    expect(satisfies("1.2.3", "^1.0.0")).toBe(true);
    expect(satisfies("2.0.0", "^1.0.0")).toBe(false);
    expect(satisfies("0.3.5", "~0.3.1")).toBe(true);
    expect(satisfies("1.5.0", ">=1.2 <2")).toBe(true);
    expect(satisfies("1.0.0-beta.1", "^1.0.0")).toBe(false);
    expect(pickVersion(["1.0.0", "1.4.2", "2.0.0", "1.9.0-rc.1"], "^1.0.0")).toBe("1.4.2");
    expect(pickVersion(["1.0.0", "2.0.0"], "latest", { latest: "1.0.0" })).toBe("1.0.0");
    expect(pickVersion(["1.0.0"], "^3.0.0")).toBeUndefined();
  });
});

describe("DSH 市场索引", () => {
  const index = {
    format: 1,
    plugins: [
      {
        name: "dsh-foo",
        title: "Foo",
        description: { zh: "中文说明", en: "english" },
        author: "someone",
        repository: { url: "https://github.com/a/foo" },
        metadata: { category: "tools", keywords: ["k1", "k2"] },
        versions: [
          { version: "1.0.0", publishTimestamp: 1_700_000_000_000, source: { type: "npm" } },
          { version: "1.1.0", publishTimestamp: 1_710_000_000_000, source: { type: "npm", registry: "https://r.example" } },
        ],
      },
      { name: "dsh-git", versions: [{ version: "0.1.0", source: { type: "git", url: "https://github.com/a/git", commit: "a".repeat(40) } }] },
      { name: "dsh-none", versions: [] },
    ],
  };
  it("认格式、取最新版本、npm / git 来源都带上", () => {
    expect(detectCatalogFormat(index)).toBe("dsh");
    const es = parseDshIndex(index, "DSH");
    expect(es.map(e => e.id)).toEqual(["dsh:dsh-foo", "dsh:dsh-git"]);
    expect(es[0]).toMatchObject({ kind: "dsh", ecosystem: "dsh", name: "Foo", description: "中文说明", version: "1.1.0", install: { kind: "dsh", pkg: "dsh-foo", version: "1.1.0", source: { type: "npm", registry: "https://r.example" } } });
    expect(es[0].note).toContain("AI 工具");
    expect(es[1].install).toMatchObject({ source: { type: "git", commit: "a".repeat(40) } });
  });
});

describe("读 Codex / Claude / DSH 的仓库", () => {
  it("Codex 市场：商店里只数内容，不下载；要装时才下载；只有应用连接器的插件说明原因", async () => {
    let rawHits = 0;
    const inner = fakeGithub({ "me/cx": CODEX });
    const f = (async (u: any, init: any) => {
      if (String(u).includes("raw.githubusercontent.com")) rawHits++;
      return inner(u, init);
    }) as typeof fetch;
    const got = (await loadForeignRepo(f, parseGithubUrl("me/cx")!, "cx"))!;
    expect(got.entries.map(e => e.id)).toEqual(["codex:demo"]);
    const e = got.entries[0];
    expect(e).toMatchObject({ kind: "bundle", ecosystem: "codex", name: "演示插件", version: "1.0.0", install: { kind: "bundle", parts: { skills: 1, mcp: 1, actions: 1, rules: 0 } } });
    expect(e.note).toContain("hooks");
    expect(got.skipped.join("\n")).toMatch(/appsonly.*没有本软件能用的内容.*apps/);
    const before = rawHits;
    const items = await got.items.get("codex:demo")!();
    expect(rawHits).toBeGreaterThan(before); // 内容到这时才下载
    expect(items.items.map(i => `${i.kind}:${i.name}`).sort()).toEqual(["action:ship", "mcp:demo-srv", "skill:hello"]);
    const skill = items.items.find(i => i.kind === "skill")!;
    expect((skill.install as any).files).toEqual([{ path: "scripts/run.sh", url: expect.stringContaining("run.sh") }]);
    const act = items.items.find(i => i.kind === "action")!;
    expect((act.install as any).prompt).toBe("发布 {{input}}");
  });

  it("Claude 市场和单个插件仓库", async () => {
    const claude = fakeGithub({
      "me/cl": {
        ".claude-plugin/marketplace.json": j({ name: "cl", plugins: [{ name: "tool", description: "d", source: "./tool" }] }),
        "tool/.claude-plugin/plugin.json": j({ name: "tool", version: "2.0.0" }),
        "tool/commands/run.md": "跑一下 $ARGUMENTS",
      },
      "me/single": { ".codex-plugin/plugin.json": j({ name: "single", description: "单个插件" }), "skills/s/SKILL.md": "---\nname: s\ndescription: x\n---\nbody" },
    });
    const cl = (await loadForeignRepo(claude, parseGithubUrl("me/cl")!, "cl"))!;
    expect(cl.entries).toMatchObject([{ id: "claude:tool", ecosystem: "claude", version: "2.0.0", install: { parts: { actions: 1 } } }]);
    const one = (await loadForeignRepo(claude, parseGithubUrl("me/single")!, "s"))!;
    expect(one.entries).toMatchObject([{ id: "codex:single", install: { parts: { skills: 1 } } }]);
  });

  it("DSH 的 GitHub 仓库：有编译好的入口才收（dist/ 不能被过滤掉）；没编译的说明原因", async () => {
    const pkg = j({ name: "dsh-repo-plugin", version: "0.2.0", main: "dist/index.js", dsh: {}, description: "d" });
    const f = fakeGithub({ "me/built": { "package.json": pkg, "dist/index.js": "x" }, "me/src": { "package.json": pkg, "src/index.ts": "x" } });
    const built = (await loadForeignRepo(f, parseGithubUrl("me/built")!, "g"))!;
    expect(built.entries).toMatchObject([{ id: "dsh:dsh-repo-plugin", kind: "dsh", install: { kind: "dsh", pkg: "dsh-repo-plugin", version: "0.2.0", source: { type: "git", url: expect.stringContaining("me/built") } } }]);
    // 没有 dist/ 时：不当作可装的插件
    const src = await loadForeignRepo(f, parseGithubUrl("me/src")!, "g");
    expect(src?.entries ?? []).toEqual([]);
  });
});

describe("插件仓库里的别家插件，进商店、装进本软件", () => {
  let home = "";
  let dshDir = "";
  const real = globalThis.fetch;
  const cfgFile = () => path.join(home, "harness.config.json");
  const cfg = () => JSON.parse(fs.readFileSync(cfgFile(), "utf8"));

  beforeAll(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "foreign-"));
    dshDir = path.join(home, "dsh");
    process.env.HARNESS_DBX_CATALOG = "https://dbx.test/c.json";
    process.env.HARNESS_OFFICIAL_REPO = "none";
    process.env.HARNESS_DSH_DIR = dshDir;
    fs.writeFileSync(cfgFile(), j({ providers: {} }));
  });
  afterEach(() => {
    globalThis.fetch = real;
  });
  afterAll(() => {
    delete process.env.HARNESS_DBX_CATALOG;
    delete process.env.HARNESS_OFFICIAL_REPO;
    delete process.env.HARNESS_DSH_DIR;
    fs.rmSync(home, { recursive: true, force: true });
  });

  const stub = (extra: Record<string, Record<string, string>> = {}) => {
    const gh = fakeGithub({ "me/cx": CODEX, ...extra });
    globalThis.fetch = (async (u: any, init: any) => (String(u) === "https://dbx.test/c.json" ? new Response(j({ plugins: [] })) : gh(u, init))) as typeof fetch;
  };

  it("Codex 插件包：装 → 技能 / MCP / 动作进配置 → 已安装里能看到 → 卸载干净", async () => {
    stub();
    const b = new Backend(home, { send() {} });
    expect(await b.pluginRepoAdd({ name: "cx", url: "https://github.com/me/cx" })).toEqual({ ok: true });
    const m = await b.pluginMarket(true);
    const e = m.entries.find(x => x.id === "codex:demo")!;
    expect(e.kind).toBe("bundle");
    expect(m.errors.some(x => /appsonly/.test(x.error))).toBe(true);

    // 用户本地已经有一个同名技能：不覆盖，并说明
    fs.mkdirSync(path.join(home, "skills", "hello"), { recursive: true });
    fs.writeFileSync(path.join(home, "skills", "hello", "SKILL.md"), "我自己的");
    const r = await b.pluginInstall("codex:demo");
    expect(r.error ?? "").toBe("");
    expect(r.note).toContain("hello");
    expect(fs.readFileSync(path.join(home, "skills", "hello", "SKILL.md"), "utf8")).toBe("我自己的");
    expect(cfg().mcpServers["demo-srv"]).toMatchObject({ command: "npx", enabled: true });
    expect(cfg().actions.find((a: any) => a.prompt === "发布 {{input}}")).toBeTruthy();
    const rec = cfg().plugins.installed["codex:demo"];
    expect(rec).toMatchObject({ kind: "bundle", ecosystem: "codex", version: "1.0.0" });
    expect(rec.members).toHaveLength(2);

    const after = await b.pluginMarket();
    expect(after.dbx!.local["codex:demo"]).toMatchObject({ ecosystem: "codex", version: "1.0.0" });
    expect(after.dbx!.local["codex:demo"].summary).toContain("1 个 MCP");

    // 重复安装不会多出一份
    expect((await b.pluginInstall("codex:demo")).ok).toBe(true);
    expect(cfg().actions.filter((a: any) => a.prompt === "发布 {{input}}")).toHaveLength(1);
    expect(Object.keys(cfg().mcpServers)).toEqual(["demo-srv"]);

    expect(await b.pluginUninstall("codex:demo")).toEqual({ ok: true });
    expect(cfg().mcpServers ?? {}).toEqual({});
    expect((cfg().actions ?? []).length).toBe(0);
    expect(cfg().plugins.installed["codex:demo"]).toBeUndefined();
    expect(fs.readFileSync(path.join(home, "skills", "hello", "SKILL.md"), "utf8")).toBe("我自己的"); // 不是它装的，不删
    expect((await b.pluginUninstall("codex:demo")).ok).toBe(false);
  });

  it("没有同名冲突时，技能和它的附带文件都装上，卸载时一起删", async () => {
    const home2 = fs.mkdtempSync(path.join(os.tmpdir(), "foreign2-"));
    fs.writeFileSync(path.join(home2, "harness.config.json"), j({ providers: {} }));
    stub();
    const b = new Backend(home2, { send() {} });
    await b.pluginRepoAdd({ name: "cx", url: "https://github.com/me/cx" });
    await b.pluginMarket(true);
    expect((await b.pluginInstall("codex:demo")).ok).toBe(true);
    expect(fs.readFileSync(path.join(home2, "skills", "hello", "SKILL.md"), "utf8")).toContain("第一步");
    expect(fs.readFileSync(path.join(home2, "skills", "hello", "scripts", "run.sh"), "utf8")).toBe("echo hi");
    expect((await b.pluginUninstall("codex:demo")).ok).toBe(true);
    expect(fs.existsSync(path.join(home2, "skills", "hello"))).toBe(false);
    fs.rmSync(home2, { recursive: true, force: true });
  });

  it("DbxBridge 读 DSH 索引直链，条目的已安装状态按 id 对上", async () => {
    const index = { format: 1, plugins: [{ name: "dsh-x", versions: [{ version: "1.0.0", source: { type: "npm" } }] }] };
    const f = (async (u: any) => (String(u) === "https://dsh.test/i.json" ? new Response(j(index)) : new Response("", { status: 404 }))) as typeof fetch;
    const b = new DbxBridge(f, { repos: () => [{ id: "d", name: "DSH", url: "https://dsh.test/i.json", enabled: true }], localDir: path.join(home, "p") });
    const rep = await b.catalogReport(true);
    expect(rep.errors).toEqual([]);
    expect(rep.entries.map(e => [e.id, e.kind, e.ecosystem])).toEqual([["dsh:dsh-x", "dsh", "dsh"]]);
  });

  it("填 DSH 市场的 GitHub 源码仓库链接：直接读它发布的索引", async () => {
    const index = { format: 1, plugins: [{ name: "dsh-y", versions: [{ version: "2.0.0", source: { type: "npm" } }] }] };
    const f = (async (u: any) => (String(u) === "https://dshbazaar.io/api/index.json" ? new Response(j(index)) : new Response("", { status: 404 }))) as typeof fetch;
    const b = new DbxBridge(f, { repos: () => [{ id: "d", name: "DSH", url: "https://github.com/dsh-market/dsh-market", enabled: true }], localDir: path.join(home, "p2") });
    const rep = await b.catalogReport(true);
    expect(rep.errors).toEqual([]);
    expect(rep.entries.map(e => e.id)).toEqual(["dsh:dsh-y"]);
  });
});

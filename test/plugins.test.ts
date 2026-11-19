import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { BUNDLED, BUNDLED_SOURCE } from "../desktop/main/plugin-catalog";
import { PluginMarket } from "../desktop/main/plugins";
import { applyInstall, applyUninstall, detectCatalogFormat, isEnabled, marketplaceUrl, parseMarketplace, parsePackage, LOCAL_SOURCE, setEnabled, type PluginEntry } from "../desktop/shared/plugins";

const entry = (over: Partial<PluginEntry> & Pick<PluginEntry, "kind" | "install">): PluginEntry => ({
  key: "s:x/a",
  id: "x/a",
  name: "A",
  description: "d",
  tags: [],
  source: "s",
  ...over,
});

describe("安装 / 卸载", () => {
  it("MCP：写进 mcpServers 并记录；重复安装不重名；更新保留用户填的环境变量与权限", () => {
    const cfg: any = { mcpServers: { a: { command: "x", args: [] } } };
    const e = entry({ kind: "mcp", install: { kind: "mcp", server: { command: "npx", args: ["-y", "pkg"], env: { TOKEN: "" } } } });
    const rec = applyInstall(cfg, e, 1);
    expect(rec.ref).toBe("a-2"); // 不覆盖已有的 a
    expect(cfg.mcpServers["a-2"]).toMatchObject({ command: "npx", args: ["-y", "pkg"], enabled: true, permission: "confirm" });
    cfg.mcpServers["a-2"].env = { TOKEN: "secret" };
    cfg.mcpServers["a-2"].permission = "auto";
    cfg.mcpServers["a-2"].enabled = false;
    applyInstall(cfg, { ...e, version: "2" }, 2);
    expect(cfg.mcpServers["a-2"]).toMatchObject({ env: { TOKEN: "secret" }, permission: "auto", enabled: false });
    expect(cfg.plugins.installed[e.key]).toMatchObject({ ref: "a-2", version: "2", kind: "mcp" });
    applyUninstall(cfg, e.key);
    expect(cfg.mcpServers["a-2"]).toBeUndefined();
    expect(cfg.mcpServers.a).toBeTruthy();
    expect(cfg.plugins.installed[e.key]).toBeUndefined();
  });

  it("动作 / 规则：新增、更新（不重复）、卸载", () => {
    const cfg: any = { actions: [{ id: "plugin-a", name: "我自己的", prompt: "p" }] };
    const act = entry({ kind: "action", install: { kind: "action", prompt: "翻译 {{input}}" } });
    const r = applyInstall(cfg, act);
    expect(r.ref).toBe("plugin-a-2");
    applyInstall(cfg, { ...act, install: { kind: "action", prompt: "新模板" } });
    expect(cfg.actions).toHaveLength(2);
    expect(cfg.actions[1].prompt).toBe("新模板");
    applyUninstall(cfg, act.key);
    expect(cfg.actions).toHaveLength(1);

    const rule = entry({ key: "s:r", id: "r", kind: "rule", install: { kind: "rule", content: "规则内容" } });
    applyInstall(cfg, rule);
    expect(cfg.rules.items[0]).toMatchObject({ title: "A", content: "规则内容", enabled: true });
    setEnabled(cfg, cfg.plugins.installed[rule.key], false);
    applyInstall(cfg, rule); // 更新不会把用户关掉的规则重新打开
    expect(cfg.rules.items[0].enabled).toBe(false);
    applyUninstall(cfg, rule.key);
    expect(cfg.rules.items).toHaveLength(0);
  });

  it("技能：只改配置（启用状态与记录），文件由调用方写；停用后重装会重新启用", () => {
    const cfg: any = { skills: { disabled: ["code-review"] } };
    const e = entry({ key: "s:sk", id: "sk", kind: "skill", install: { kind: "skill", name: "code-review", description: "d", content: "c" } });
    const rec = applyInstall(cfg, e);
    expect(rec.ref).toBe("code-review");
    expect(cfg.skills.disabled).toEqual([]);
    setEnabled(cfg, rec, false);
    expect(isEnabled(cfg, rec)).toBe(false);
    setEnabled(cfg, rec, true);
    expect(isEnabled(cfg, rec)).toBe(true);
    expect(applyUninstall(cfg, e.key)?.kind).toBe("skill");
    expect(applyUninstall(cfg, e.key)).toBeNull();
  });
});

describe("插件源解析", () => {
  it("接受 {plugins:[]} 与数组；坏条目跳过并说明原因", () => {
    const good = { id: "p/one", name: "One", kind: "action", description: "d", install: { prompt: "hi" }, tags: ["a", 1], updated: "2026-11-02T10:00:00Z", homepage: "javascript:x" };
    const r = parseMarketplace(
      {
        name: "社区源",
        plugins: [
          good,
          { id: "bad id", name: "x", kind: "action", description: "d", install: { prompt: "p" } },
          { id: "p/two", name: "Two", kind: "nope", description: "d", install: {} },
          { id: "p/three", name: "Three", kind: "mcp", description: "d", install: { server: {} } },
          { id: "p/four", name: "Four", kind: "skill", description: "d", install: { name: "bad name!", content: "c" } },
          { id: "p/one", name: "Dup", kind: "action", description: "d", install: { prompt: "p" } },
          "oops",
        ],
      },
      "社区源",
    );
    expect(r.name).toBe("社区源");
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ key: "社区源:p/one", tags: ["a"], updated: "2026-11-02", homepage: undefined, install: { kind: "action", prompt: "hi" } });
    expect(r.skipped).toHaveLength(6);
    expect(parseMarketplace([good], "s").entries).toHaveLength(1);
    expect(() => parseMarketplace({ nope: 1 }, "s")).toThrow(/格式/);
  });

  it("MCP 只接受 http(s) 远程地址", () => {
    const bad = parseMarketplace([{ id: "m", name: "m", kind: "mcp", description: "d", install: { server: { url: "file:///etc/passwd" } } }], "s");
    expect(bad.entries).toHaveLength(0);
    const ok = parseMarketplace([{ id: "m", name: "m", kind: "mcp", description: "d", install: { server: { url: "https://x.y/mcp" } } }], "s");
    expect(ok.entries[0].install).toMatchObject({ kind: "mcp", server: { url: "https://x.y/mcp" } });
  });

  it("marketplaceUrl：owner/repo、github 链接、直链", () => {
    expect(marketplaceUrl("acme/plugins")).toBe("https://raw.githubusercontent.com/acme/plugins/HEAD/marketplace.json");
    expect(marketplaceUrl("https://github.com/acme/plugins.git")).toBe("https://raw.githubusercontent.com/acme/plugins/HEAD/marketplace.json");
    expect(marketplaceUrl("http://127.0.0.1:1/m.json")).toBe("http://127.0.0.1:1/m.json");
    expect(marketplaceUrl("ftp://x")).toBeNull();
    expect(marketplaceUrl("  ")).toBeNull();
  });
});

describe("自带插件", () => {
  it("每个条目都能通过校验，id / key 唯一，技能名合法", () => {
    const again = parseMarketplace(BUNDLED.map(({ key, source, ...rest }) => rest), BUNDLED_SOURCE);
    expect(again.skipped).toEqual([]);
    expect(again.entries).toHaveLength(BUNDLED.length);
    expect(new Set(BUNDLED.map(e => e.key)).size).toBe(BUNDLED.length);
    expect(BUNDLED.map(e => e.kind)).toEqual(expect.arrayContaining(["mcp", "skill", "action", "rule"]));
  });

  it("全部安装后的配置仍然是合法配置，再全部卸载后回到原样", () => {
    const cfg: any = {};
    for (const e of BUNDLED) applyInstall(cfg, e);
    const parsed = parseConfig(JSON.parse(JSON.stringify(cfg)));
    expect(Object.keys(parsed.plugins.installed)).toHaveLength(BUNDLED.length);
    expect(Object.keys(parsed.mcpServers).length).toBe(BUNDLED.filter(e => e.kind === "mcp").length);
    for (const e of BUNDLED) applyUninstall(cfg, e.key);
    expect(cfg.plugins.installed).toEqual({});
    expect(cfg.mcpServers).toEqual({});
    expect(cfg.actions).toEqual([]);
    expect(cfg.rules.items).toEqual([]);
  });
});

describe("PluginMarket", () => {
  const body = (name: string) => JSON.stringify({ name, plugins: [{ id: "p/x", name: "X", kind: "action", description: "d", install: { prompt: "hi" } }] });
  const fake = (calls: string[], fail = false): typeof fetch =>
    (async (url: string) => {
      calls.push(String(url));
      if (fail) throw new Error("断网了");
      if (String(url).includes("bad")) return new Response("{}", { status: 404 });
      if (String(url).includes("junk")) return new Response("not json", { status: 200 });
      return new Response(body("社区源"), { status: 200 });
    }) as any;

  it("合并自带 + 远程；用 JSON 里的名字；缓存；refresh 重新拉", async () => {
    const calls: string[] = [];
    const m = new PluginMarket(fake(calls));
    const r = await m.load([{ url: "http://h/ok.json" }]);
    expect(r.errors).toEqual([]);
    expect(r.entries.length).toBe(BUNDLED.length + 1);
    expect(r.entries.at(-1)).toMatchObject({ source: "社区源", key: "社区源:p/x" });
    await m.load([{ url: "http://h/ok.json" }]);
    expect(calls).toHaveLength(1);
    await m.load([{ url: "http://h/ok.json" }], true);
    expect(calls).toHaveLength(2);
  });

  it("坏源只报错不影响其它；停用的源不请求；自定义名字优先；重名忽略", async () => {
    const calls: string[] = [];
    const m = new PluginMarket(fake(calls));
    const r = await m.load([
      { name: "坏的", url: "http://h/bad.json" },
      { name: "垃圾", url: "http://h/junk.json" },
      { name: "关着", url: "http://h/off.json", enabled: false },
      { name: "我的源", url: "http://h/ok.json" },
      { name: "我的源", url: "http://h/ok2.json" },
      { name: "非法", url: "ftp://x" },
    ]);
    expect(calls.some(c => c.includes("off"))).toBe(false);
    expect(r.errors.map(e => e.source).sort()).toEqual(["垃圾", "我的源", "坏的", "非法"].sort());
    expect(r.entries.filter(e => e.source === "我的源")).toHaveLength(1);
    expect(r.entries.length).toBe(BUNDLED.length + 1);
  });

  it("断网时用旧缓存兜底", async () => {
    const calls: string[] = [];
    let down = false;
    const m = new PluginMarket((async (u: string) => (down ? Promise.reject(new Error("断网")) : fake(calls)(u))) as any);
    await m.load([{ url: "http://h/ok.json" }]);
    down = true;
    const r = await m.load([{ url: "http://h/ok.json" }], true);
    expect(r.errors).toEqual([]);
    expect(r.entries.length).toBe(BUNDLED.length + 1);
  });
});

describe("仓库目录格式识别", () => {
  it("DBX 目录 / 本软件的插件源 / 认不出来", () => {
    expect(detectCatalogFormat({ plugins: [{ id: "a", name: "A", versions: [] }] })).toBe("dbx");
    expect(detectCatalogFormat({ plugins: [] })).toBe("dbx");
    expect(detectCatalogFormat({ plugins: [{ id: "a", name: "A", kind: "rule", description: "d", install: { content: "x" } }] })).toBe("native");
    expect(detectCatalogFormat([{ id: "a", kind: "rule", install: { content: "x" } }])).toBe("native");
    expect(detectCatalogFormat([])).toBe("native");
    expect(detectCatalogFormat({ format: 1, plugins: [{ name: "dsh-x", versions: [{ version: "1" }] }] })).toBeNull(); // DSH 的 npm 索引：没有 id
    expect(detectCatalogFormat({ foo: 1 })).toBeNull();
    expect(detectCatalogFormat("x")).toBeNull();
  });
});

describe("插件包与可选字段", () => {
  const one = { id: "pkg/a", name: "A", kind: "action", description: "d", install: { prompt: "p" } };

  it("parsePackage：单个插件对象、列表、数组都行，来源是「本地安装」", () => {
    for (const j of [one, { plugins: [one] }, [one]]) {
      const r = parsePackage(j);
      expect(r.entries.map(e => e.key)).toEqual([`${LOCAL_SOURCE}:pkg/a`]);
    }
    expect(parsePackage({ kind: "action", id: "bad id" }).entries).toEqual([]);
    expect(() => parsePackage("x")).toThrow();
  });

  it("repo 只认 http(s)；downloads 必须是非负数，没有就不显示", () => {
    const r = parseMarketplace([{ ...one, repo: "https://github.com/a/b", downloads: 12.7 }, { ...one, id: "pkg/b", repo: "javascript:1", downloads: -1 }, { ...one, id: "pkg/c", downloads: "9" }], "s");
    expect(r.entries.map(e => [e.repo, e.downloads])).toEqual([["https://github.com/a/b", 12], [undefined, undefined], [undefined, undefined]]);
  });

  it("fetchPackage：下载并解析；非 http / 非 JSON / 超时错误都报错", async () => {
    const m = new PluginMarket((async (u: string) => (u.endsWith("bad") ? new Response("not json") : u.endsWith("404") ? new Response("x", { status: 404 }) : new Response(JSON.stringify(one)))) as any);
    expect((await m.fetchPackage("http://h/p.json")).entries[0].source).toBe(LOCAL_SOURCE);
    await expect(m.fetchPackage("ftp://h/p")).rejects.toThrow("http");
    await expect(m.fetchPackage("http://h/bad")).rejects.toThrow("JSON");
    await expect(m.fetchPackage("http://h/404")).rejects.toThrow("404");
  });
});

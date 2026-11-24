import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Backend } from "../desktop/main/backend";

/** 技能 / MCP / 动作 / 规则不是插件：软件自带推荐，也能从 GitHub / 资源文件导入，在各自的设置页里添加 */
describe("技能 / MCP / 规则 / 动作的推荐与导入", () => {
  let server: http.Server;
  let url = "";
  let home = "";
  const src = {
    name: "测试资源",
    plugins: [
      { id: "mcp-demo", name: "演示 MCP", kind: "mcp", version: "1.0.0", description: "d", install: { server: { command: "npx", args: ["-y", "demo"] } } },
      { id: "rule-test", name: "写测试规则", kind: "rule", version: "1.0.0", description: "d", install: { content: "改代码要写测试" } },
      { id: "skill-demo", name: "演示技能", kind: "skill", version: "1.0.0", description: "d", install: { name: "demo-skill", description: "演示", content: "# 演示\n步骤一" } },
      { id: "act-demo", name: "演示动作", kind: "action", version: "1.0.0", description: "d", install: { prompt: "帮我总结 {{input}}" } },
    ],
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(src));
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as any).port}/res.json`;
    home = fs.mkdtempSync(path.join(os.tmpdir(), "resource-"));
    process.env.HARNESS_DBX_CATALOG = url; // 预置的 DBX 仓库指到本地服务，测试不联网
    process.env.HARNESS_OFFICIAL_REPO = "none"; // 官方仓库在 GitHub 上，测试里不预置
    fs.writeFileSync(path.join(home, "harness.config.json"), JSON.stringify({ providers: {} }));
  });
  afterAll(() => {
    delete process.env.HARNESS_DBX_CATALOG;
    delete process.env.HARNESS_OFFICIAL_REPO;
    server.close();
  });

  const cfg = () => JSON.parse(fs.readFileSync(path.join(home, "harness.config.json"), "utf8"));

  it("推荐：去 GitHub 按星标榜取（不是写死的），缓存下来；网络挂了用旧缓存；MCP 没有 .mcp.json 时认 README 里的配置", async () => {
    const fence = "```";
    const readme = `${fence}json\n${JSON.stringify({ mcpServers: { zeta: { command: "npx", args: ["zeta-mcp"] } } })}\n${fence}`;
    let online = true;
    let searches = 0;
    const fake = (async (u: any) => {
      const s = String(u);
      if (!online) throw new Error("断网");
      if (s.startsWith("https://api.github.com/search/repositories")) {
        searches++;
        const q = decodeURIComponent(new URL(s).searchParams.get("q")!);
        const items = q.includes("topic:agent-skills")
          ? [{ full_name: "o/skills-a", stargazers_count: 500, description: "技能合集", html_url: "https://github.com/o/skills-a", topics: [] }]
          : q.includes("mcp in:name")
            ? [{ full_name: "o/zeta-mcp", stargazers_count: 300, description: "demo mcp", html_url: "https://github.com/o/zeta-mcp", topics: [] }]
            : [];
        return new Response(JSON.stringify({ items }), { status: 200 });
      }
      const m = /packages\/gh\/([^@]+)@/.exec(s);
      if (m) return new Response(JSON.stringify({ files: (m[1] === "o/skills-a" ? ["skills/x/SKILL.md"] : ["README.md"]).map(name => ({ name: "/" + name })) }), { status: 200 });
      if (/raw\.githubusercontent\.com\/o\/zeta-mcp\//.test(s)) return new Response(readme, { status: 200 });
      return new Response("", { status: 404 });
    }) as unknown as typeof fetch;
    const real = globalThis.fetch;
    globalThis.fetch = fake;
    try {
      const b = new Backend(home, { send() {} });
      const skills = await b.resourceRecommended("skill");
      expect(skills.ok).toBe(true);
      expect(skills.items.map(i => `${i.name}:${i.stars}:${i.source}`)).toEqual(["o/skills-a:500:GitHub 星标榜"]);
      expect(fs.existsSync(path.join(home, "recommend-cache.json"))).toBe(true);
      // 12 小时内不重复去拉
      const before = searches;
      await b.resourceRecommended("skill");
      expect(searches).toBe(before);
      // 强制刷新，但网络挂了：用旧缓存并说明
      online = false;
      const stale = await b.resourceRecommended("skill", true);
      expect(stale.ok).toBe(true);
      expect(stale.stale).toBe(true);
      expect(stale.items).toHaveLength(1);
      expect(stale.error).toBeTruthy();
      // 没有缓存又断网：如实报错，不拿写死的数据凑
      const none = await b.resourceRecommended("rule");
      expect(none.ok).toBe(false);
      expect(none.items).toEqual([]);
      online = true;
      // MCP：榜上的仓库，添加时扫描——没有 .mcp.json，从 README 的配置片段里装
      const mcp = await b.resourceRecommended("mcp");
      expect(mcp.items.map(i => i.name)).toEqual(["o/zeta-mcp"]);
      const scan = await b.resourceScan("o/zeta-mcp", "mcp");
      expect(scan.ok).toBe(true);
      const item = scan.items!.find(i => i.kind === "mcp")!;
      expect(item.name).toBe("zeta");
      expect(await b.resourceAdd(item.key)).toMatchObject({ ok: true });
      expect(cfg().mcpServers.zeta).toMatchObject({ command: "npx", enabled: true });
    } finally {
      globalThis.fetch = real;
    }
  });

  it("从资源文件导入：四类都能添加，写进各自的配置；重复添加不会多出一份", async () => {
    const b = new Backend(home, { send() {} });
    const r = await b.resourceScan(url);
    expect(r.ok).toBe(true);
    expect(r.items!.map(i => `${i.kind}:${i.name}`).sort()).toEqual(["action:演示动作", "mcp:演示 MCP", "rule:写测试规则", "skill:演示技能"]);
    for (const i of r.items!) expect(await b.resourceAdd(i.key)).toMatchObject({ ok: true });
    const c = cfg();
    expect(c.mcpServers.demo).toMatchObject({ command: "npx", enabled: true });
    expect(c.rules.items.find((x: any) => x.content === "改代码要写测试")).toBeTruthy();
    expect(c.actions.find((a: any) => a.prompt.includes("总结"))).toBeTruthy();
    expect(fs.readFileSync(path.join(home, "skills", "demo-skill", "SKILL.md"), "utf8")).toContain("步骤一");
    expect((await b.resourceScan(url)).items!.every(i => i.added)).toBe(true);
    for (const i of r.items!) await b.resourceAdd(i.key);
    expect(cfg().actions.filter((a: any) => a.prompt.includes("总结"))).toHaveLength(1);
    expect(Object.keys(cfg().mcpServers).filter(k => k.startsWith("demo"))).toEqual(["demo"]);
  });

  it("用户自己已经有同名技能：不覆盖，给出原因；找不到的 key 报错；扫描失败给原因", async () => {
    const b = new Backend(home, { send() {} });
    fs.rmSync(path.join(home, "skills", "demo-skill"), { recursive: true, force: true });
    const c = cfg();
    delete c.plugins.installed["127.0.0.1:" + new URL(url).port + ":skill-demo"];
    fs.writeFileSync(path.join(home, "harness.config.json"), JSON.stringify(c));
    fs.mkdirSync(path.join(home, "skills", "demo-skill"), { recursive: true });
    fs.writeFileSync(path.join(home, "skills", "demo-skill", "SKILL.md"), "用户自己写的");
    const skill = (await b.resourceScan(url)).items!.find(i => i.kind === "skill")!;
    const r = await b.resourceAdd(skill.key);
    expect(r.ok).toBe(false);
    expect(r.error).toContain("已经有一个叫「demo-skill」的技能");
    expect(fs.readFileSync(path.join(home, "skills", "demo-skill", "SKILL.md"), "utf8")).toBe("用户自己写的");
    expect((await b.resourceAdd("没有这个:key")).ok).toBe(false);
    expect((await b.resourceScan("")).ok).toBe(false);
    expect((await b.resourceScan("http://evil.example/x.json")).error).toMatch(/https/);
  });

  it("插件商店里没有这些：就算仓库是资源格式，也只提示「不是插件」", async () => {
    const b = new Backend(home, { send() {} });
    expect((await b.pluginRepoAdd({ name: "资源仓库", url: `${url}?r=1` })).ok).toBe(true);
    const m = await b.pluginMarket(true);
    expect(m.entries.filter(e => e.source === "资源仓库")).toEqual([]);
    expect(m.errors.find(e => e.source === "资源仓库")?.error).toContain("不是插件");
  });
});

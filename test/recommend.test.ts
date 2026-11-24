import { describe, expect, it } from "vitest";
import { candidates, hasContent, isNoise, mcpRawFromReadme, mcpServersFromReadme, REC_QUERIES, TOP, topRepos } from "../desktop/main/recommend";
import { fmtStars } from "../desktop/renderer/src/lib/stars";

const repo = (full: string, stars: number, extra: Partial<{ description: string; topics: string[] }> = {}) => ({ full_name: full, stargazers_count: stars, description: extra.description ?? "", html_url: `https://github.com/${full}`, topics: extra.topics ?? [] });

/** 假的 fetch：GitHub 搜索按 query 返回；jsDelivr 文件清单 / README 按仓库返回 */
function fakeFetch(opts: { search: Record<string, any[]>; trees: Record<string, string[] | "fail">; readmes?: Record<string, string> }) {
  const calls: string[] = [];
  const f = (async (url: string) => {
    const u = String(url);
    calls.push(u);
    if (u.startsWith("https://api.github.com/search/repositories")) {
      const q = decodeURIComponent(new URL(u).searchParams.get("q")!).replace(/ archived:false fork:false$/, "");
      const items = opts.search[q];
      if (!items) return new Response("{}", { status: 422 });
      return new Response(JSON.stringify({ items }), { status: 200 });
    }
    const m = /packages\/gh\/([^@]+)@/.exec(u);
    if (m) {
      const t = opts.trees[m[1]];
      if (t === "fail" || !t) return new Response("", { status: 500 });
      return new Response(JSON.stringify({ files: t.map(name => ({ name: `/${name}` })) }), { status: 200 });
    }
    const r = /(?:raw\.githubusercontent\.com|cdn\.jsdelivr\.net\/gh)\/([^/@]+\/[^/@]+)[/@]/.exec(u);
    if (r && opts.readmes?.[r[1]]) return new Response(opts.readmes[r[1]], { status: 200 });
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  return { f, calls };
}

describe("isNoise：awesome 清单不算", () => {
  it("名字 / 话题 / 简介里是清单的都过滤", () => {
    expect(isNoise({ full: "a/awesome-mcp-servers", description: "", topics: [] })).toBe(true);
    expect(isNoise({ full: "a/x", description: "A curated list of MCP servers", topics: [] })).toBe(true);
    expect(isNoise({ full: "a/x", description: "", topics: ["awesome-list"] })).toBe(true);
    expect(isNoise({ full: "a/playwright-mcp", description: "Playwright MCP server", topics: ["mcp-server"] })).toBe(false);
  });
});

describe("hasContent：这个仓库里软件能不能添加这一类", () => {
  it("四类各认各的文件", () => {
    expect(hasContent("skill", ["skills/a/SKILL.md"])).toBe(true);
    expect(hasContent("skill", ["README.md"])).toBe(false);
    expect(hasContent("action", [".claude/commands/review.md"])).toBe(true);
    expect(hasContent("action", ["docs/commands/x.md"])).toBe(false);
    expect(hasContent("rule", [".cursor/rules/a.mdc"])).toBe(true);
    expect(hasContent("mcp", [".mcp.json"])).toBe(true);
    expect(hasContent("skill", ["node_modules/x/SKILL.md"])).toBe(false);
  });
});

describe("mcpServersFromReadme：README 里的配置片段", () => {
  const md = ["# x", "```json", '{ "mcpServers": { "playwright": { "command": "npx", "args": ["@playwright/mcp@latest"] } } }', "```", "```bash", "npm i", "```"].join("\n");
  it("认 mcpServers，只留需要的字段", () => {
    expect(mcpServersFromReadme(md)).toEqual({ playwright: { command: "npx", args: ["@playwright/mcp@latest"] } });
  });
  it("认没有外层花括号的片段、行注释和尾逗号", () => {
    const m2 = ["```jsonc", "// 配置", '"context7": { "url": "https://mcp.context7.com/mcp", },', "```"].join("\n");
    expect(mcpServersFromReadme(m2)).toEqual({ context7: { url: "https://mcp.context7.com/mcp" } });
  });
  it("不是 MCP 配置的 JSON 不算；没有配置返回空", () => {
    expect(mcpServersFromReadme(["```json", '{ "name": "x", "version": "1" }', "```"].join("\n"))).toEqual({});
    expect(mcpServersFromReadme("没有代码块")).toEqual({});
  });
  it("生成的条目带来源仓库，有环境变量时提示去填", () => {
    const raw = mcpRawFromReadme("o", "r", ["```json", '{"mcpServers":{"a":{"command":"npx","args":["a"],"env":{"KEY":"x"}}}}', "```"].join("\n"));
    expect(raw).toHaveLength(1);
    expect(raw[0]).toMatchObject({ id: "mcp-a", kind: "mcp", homepage: "https://github.com/o/r" });
    expect(raw[0].install.note).toContain("环境变量");
  });
});

describe("topRepos：星标榜前 6，且是真能添加的", () => {
  it("按星标从高到低，去掉 awesome 清单和装不了东西的仓库，最多 6 个", async () => {
    const items = [repo("big/awesome-skills", 900), ...Array.from({ length: 8 }, (_, i) => repo(`o/skill${i}`, 800 - i * 10)), repo("o/no-skill", 850)];
    const trees: Record<string, string[]> = { "o/no-skill": ["README.md"] };
    for (let i = 0; i < 8; i++) trees[`o/skill${i}`] = [`skills/s/SKILL.md`];
    const { f } = fakeFetch({ search: { [REC_QUERIES.skill[0]]: items, [REC_QUERIES.skill[1]]: [] }, trees });
    const top = await topRepos(f, "skill");
    expect(top).toHaveLength(TOP);
    expect(top.map(r => r.full)).toEqual(["o/skill0", "o/skill1", "o/skill2", "o/skill3", "o/skill4", "o/skill5"]);
    expect(top.every((r, i, a) => i === 0 || a[i - 1].stars >= r.stars)).toBe(true);
  });
  it("两条搜索合并去重", async () => {
    const { f } = fakeFetch({ search: { [REC_QUERIES.rule[0]]: [repo("a/r1", 10), repo("a/r2", 30)], [REC_QUERIES.rule[1]]: [repo("a/r2", 30), repo("a/r3", 20)] }, trees: {} });
    expect((await candidates(f, "rule")).map(r => r.full)).toEqual(["a/r2", "a/r3", "a/r1"]);
  });
  it("MCP：没有 .mcp.json 但 README 有配置的也算", async () => {
    const readme = ["```json", '{"mcpServers":{"x":{"command":"npx","args":["x-mcp"]}}}', "```"].join("\n");
    const { f } = fakeFetch({ search: { [REC_QUERIES.mcp[0]]: [repo("a/x-mcp", 100), repo("a/plain-mcp", 90)], [REC_QUERIES.mcp[1]]: [] }, trees: { "a/x-mcp": ["README.md", "src/index.ts"], "a/plain-mcp": ["README.md"] }, readmes: { "a/x-mcp": readme, "a/plain-mcp": "# nothing" } });
    expect((await topRepos(f, "mcp")).map(r => r.full)).toEqual(["a/x-mcp"]);
  });
  it("核实通道全挂了：不硬判，按星标直接给前 6 个", async () => {
    const items = Array.from({ length: 9 }, (_, i) => repo(`o/r${i}`, 100 - i));
    const trees: Record<string, "fail"> = {};
    for (const it of items) trees[it.full_name] = "fail";
    const { f } = fakeFetch({ search: { [REC_QUERIES.action[0]]: items, [REC_QUERIES.action[1]]: [] }, trees });
    expect((await topRepos(f, "action")).map(r => r.full)).toEqual(items.slice(0, TOP).map(i => i.full_name));
  });
  it("GitHub 搜索全失败就报错（交给上层用缓存）", async () => {
    const { f } = fakeFetch({ search: {}, trees: {} });
    await expect(topRepos(f, "skill")).rejects.toThrow();
  });
});

describe("fmtStars", () => {
  it("缩写", () => {
    expect(fmtStars(950)).toBe("950");
    expect(fmtStars(1500)).toBe("1.5k");
    expect(fmtStars(65352)).toBe("65.4k");
    expect(fmtStars(199520)).toBe("200k");
  });
});

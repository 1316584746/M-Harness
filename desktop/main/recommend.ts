import { slug } from "../shared/plugins";

/**
 * 「推荐」的数据：不再写死，而是去 GitHub 按星标排行取每一类最高的几个仓库。
 *   · 候选：GitHub 搜索（按 topic，星标从高到低）
 *   · 过滤：「awesome 清单」这类只有链接、装不了东西的仓库
 *   · 核实：只留下「软件真的能从里面添加东西」的仓库（技能有 SKILL.md、动作有 commands/、规则有 .cursor/rules、MCP 有配置）
 * 码云（Gitee）的搜索接口不带令牌只会返回空，所以没有接。
 */

type Fetch = typeof fetch;
export type RecKind = "mcp" | "skill" | "action" | "rule";

export interface RecRepo {
  /** owner/repo */
  full: string;
  description: string;
  stars: number;
  url: string;
  topics: string[];
}

/** 每一类展示几个 */
export const TOP = 6;
/** 最多核实几个候选（按星标从高到低，凑够 TOP 个就停） */
const MAX_VERIFY = 18;

/** 每一类的 GitHub 搜索条件（多条合并后按星标排）。MCP 额外要求名字里带 mcp，不然 n8n 这种「用到 MCP」的大项目也会混进来 */
export const REC_QUERIES: Record<RecKind, string[]> = {
  mcp: ["topic:mcp-server mcp in:name", "topic:model-context-protocol mcp in:name"],
  skill: ["topic:agent-skills", "topic:claude-skills"],
  action: ["topic:claude-code-commands", "topic:slash-commands topic:claude-code"],
  rule: ["topic:cursor-rules", "topic:cursorrules"],
};

export const isRecKind = (k: string): k is RecKind => k === "mcp" || k === "skill" || k === "action" || k === "rule";

/** 「awesome 清单」：整仓是链接汇总，里面没有能添加的东西 */
export function isNoise(r: Pick<RecRepo, "full" | "description" | "topics">): boolean {
  const name = r.full.split("/")[1] ?? r.full;
  if (/awesome/i.test(name)) return true;
  if (r.topics.some(t => /^awesome(-list)?s?$/i.test(t))) return true;
  return /\b(curated|awesome)\b[^.]{0,40}\blist\b|^a (curated )?(list|collection) of/i.test(r.description);
}

const README = /^readme(\.md|\.markdown|\.mdx)?$/i;

/** 这个仓库的文件清单里，有没有这一类的东西可以添加（MCP 另外还看 README，见 hasMcpInReadme） */
export function hasContent(kind: RecKind, tree: string[]): boolean {
  const ok: Record<RecKind, RegExp> = {
    skill: /(^|\/)SKILL\.md$/,
    action: /^(\.claude\/)?commands\/[^/]+\.md$/,
    rule: /^\.cursor\/rules\/[^/]+\.mdc?$/,
    mcp: /^(\.mcp\.json|mcp\.json|\.cursor\/mcp\.json)$/,
  };
  return tree.some(p => ok[kind].test(p) && !/(^|\/)(node_modules|dist|build)\//.test(p));
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/**
 * 从 README 里的配置片段找 MCP 服务：绝大多数 MCP 项目都会在 README 里贴一段
 * { "mcpServers": { "名字": { "command": "npx", "args": [...] } } }，照着它装就行。
 * 返回 名字 → 服务配置（只留 command / args / env / url / headers / type）。
 */
export function mcpServersFromReadme(md: string, max = 3): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const m of md.matchAll(/```[\w+-]*\r?\n([\s\S]*?)```/g)) {
    const block = m[1];
    if (!/"command"|"url"/.test(block)) continue;
    const txt = block.replace(/^\s*\/\/.*$/gm, "").trim().replace(/,$/, "");
    let j: unknown;
    for (const cand of [txt, `{${txt}}`]) {
      try {
        j = JSON.parse(cand.replace(/,(\s*[}\]])/g, "$1"));
        break;
      } catch {
        /* 换一种包法再试 */
      }
    }
    if (!isObj(j)) continue;
    const servers = isObj(j.mcpServers) ? j.mcpServers : isObj(j.servers) ? j.servers : isObj(j.mcp) && isObj(j.mcp.servers) ? j.mcp.servers : j.command || j.url ? {} : j;
    for (const [name, s] of Object.entries<any>(servers)) {
      if (!isObj(s) || !(typeof s.command === "string" && s.command.trim()) && !(typeof s.url === "string" && s.url.trim())) continue;
      if (out[name]) continue;
      const keep: Record<string, unknown> = {};
      for (const k of ["command", "args", "env", "url", "headers", "type"]) if (s[k] !== undefined) keep[k] = s[k];
      out[name] = keep;
      if (Object.keys(out).length >= max) return out;
    }
  }
  return out;
}

/** README 里找到的 MCP 服务 → 本软件资源格式的原始条目（再交给 parseMarketplace 校验） */
export function mcpRawFromReadme(owner: string, repo: string, md: string): any[] {
  const used = new Set<string>();
  return Object.entries(mcpServersFromReadme(md)).map(([name, server]) => {
    let id = `mcp-${slug(name)}`;
    for (let i = 2; used.has(id); i++) id = `mcp-${slug(name)}-${i}`;
    used.add(id);
    const env = isObj(server.env) && Object.keys(server.env).length;
    return {
      id,
      name,
      kind: "mcp",
      description: `${owner}/${repo} 的 MCP 服务「${name}」（配置取自它的 README）`,
      author: owner,
      repo: `https://github.com/${owner}/${repo}`,
      homepage: `https://github.com/${owner}/${repo}`,
      tags: ["github"],
      install: { server, note: env ? "装好后到「设置 → MCP」填写环境变量" : undefined },
    };
  });
}

async function getJson(f: Fetch, url: string): Promise<any> {
  const res = await f(url, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/vnd.github+json" } });
  if (res.status === 403 || res.status === 429) throw new Error("GitHub 暂时限制了访问（匿名搜索每分钟有次数上限），稍后点「刷新」");
  if (!res.ok) throw new Error(`读取 GitHub 失败（HTTP ${res.status}）`);
  return res.json();
}

/** GitHub 搜索：按星标从高到低 */
export async function searchGithub(f: Fetch, q: string, perPage = 30): Promise<RecRepo[]> {
  const j = await getJson(f, `https://api.github.com/search/repositories?q=${encodeURIComponent(`${q} archived:false fork:false`)}&sort=stars&order=desc&per_page=${perPage}`);
  return (Array.isArray(j?.items) ? j.items : [])
    .filter((x: any) => typeof x?.full_name === "string")
    .map((x: any) => ({ full: x.full_name, description: String(x.description ?? "").replace(/\s+/g, " ").trim(), stars: Number(x.stargazers_count) || 0, url: String(x.html_url ?? `https://github.com/${x.full_name}`), topics: Array.isArray(x.topics) ? x.topics.map(String) : [] }));
}

/** 仓库文件清单：走 jsDelivr（不占 GitHub 的匿名次数，国内也通常更稳） */
export async function treeViaCdn(f: Fetch, full: string): Promise<string[]> {
  const res = await f(`https://data.jsdelivr.com/v1/packages/gh/${full}@HEAD?structure=flat`, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const j: any = await res.json();
  return (Array.isArray(j?.files) ? j.files : []).map((x: any) => String(x?.name ?? "").replace(/^\//, "")).filter(Boolean);
}

/** 读仓库根目录的 README：先 raw.githubusercontent.com，不行再走 jsDelivr */
export async function fetchReadme(f: Fetch, full: string, name = "README.md"): Promise<string> {
  let err: unknown;
  for (const u of [`https://raw.githubusercontent.com/${full}/HEAD/${name}`, `https://cdn.jsdelivr.net/gh/${full}@HEAD/${name}`]) {
    try {
      const r = await f(u, { signal: AbortSignal.timeout(20_000) });
      if (r.ok) {
        const t = await r.text();
        return t.length > 400_000 ? t.slice(0, 400_000) : t;
      }
      err ??= new Error(`HTTP ${r.status}`);
    } catch (e) {
      err ??= e;
    }
  }
  throw err instanceof Error ? err : new Error("读不到 README");
}

/** 一类的候选：多条搜索合并、去重、去掉 awesome 清单，按星标从高到低 */
export async function candidates(f: Fetch, kind: RecKind): Promise<RecRepo[]> {
  const results = await Promise.allSettled(REC_QUERIES[kind].map(q => searchGithub(f, q)));
  const ok = results.filter((r): r is PromiseFulfilledResult<RecRepo[]> => r.status === "fulfilled");
  if (!ok.length) throw (results[0] as PromiseRejectedResult).reason;
  const seen = new Set<string>();
  return ok
    .flatMap(r => r.value)
    .filter(r => (seen.has(r.full) ? false : (seen.add(r.full), true)))
    .filter(r => !isNoise(r))
    .sort((a, b) => b.stars - a.stars);
}

/**
 * 一类里星标最高的 TOP 个「能添加东西」的仓库。
 * 核实不了的时候（比如 jsDelivr 连不上）不硬判，直接按星标给前 TOP 个，添加时再如实告诉用户装不装得了。
 */
export async function topRepos(f: Fetch, kind: RecKind): Promise<RecRepo[]> {
  const list = (await candidates(f, kind)).slice(0, MAX_VERIFY);
  const good: RecRepo[] = [];
  let tried = 0;
  let failed = 0;
  for (let i = 0; i < list.length && good.length < TOP; i += 4) {
    const batch = list.slice(i, i + 4);
    const checked = await Promise.all(
      batch.map(async r => {
        try {
          const tree = await treeViaCdn(f, r.full);
          if (hasContent(kind, tree)) return true;
          if (kind !== "mcp") return false;
          const name = tree.find(p => README.test(p));
          return !!name && Object.keys(mcpServersFromReadme(await fetchReadme(f, r.full, name))).length > 0;
        } catch {
          failed++;
          return null;
        }
      }),
    );
    tried += batch.length;
    batch.forEach((r, k) => checked[k] && good.length < TOP && good.push(r));
  }
  if (!good.length && tried > 0 && failed === tried) return list.slice(0, TOP);
  return good;
}

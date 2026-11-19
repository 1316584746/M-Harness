import { detectCatalogFormat, parseMarketplace, slug, type PluginEntry } from "../shared/plugins";

/**
 * 导入一个 GitHub 仓库当插件仓库：不要求它事先有「目录文件」，软件自己去看仓库里有什么——
 *   · 现成的目录：catalog/index.json（DBX）、marketplace.json / .claude-plugin/marketplace.json（本软件格式或 Claude Code 市场）
 *   · 否则扫描仓库本身：技能（SKILL.md）、MCP（.mcp.json）、命令（commands/*.md → 动作）、规则（.cursor/rules）
 * 什么都没找到，就说清楚「这个仓库里没有本软件能用的东西」，而不是甩一句格式不对。
 */

export interface GithubSrc {
  owner: string;
  repo: string;
  /** 分支 / 标签；没写就用默认分支 */
  ref?: string;
  /** 只看仓库里的这个子目录（不带首尾斜杠） */
  dir: string;
}

/** 认 github.com 的仓库链接和 owner/repo 简写；其他返回 null（当作直接的目录文件地址） */
export function parseGithubUrl(input: string): GithubSrc | null {
  const s = input.trim();
  const short = /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  if (short && !/^https?:/i.test(s)) return { owner: short[1], repo: short[2].replace(/\.git$/, ""), dir: "" };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !/^(www\.)?github\.com$/.test(u.hostname)) return null;
  const seg = u.pathname.split("/").filter(Boolean);
  if (seg.length < 2) return null;
  const out: GithubSrc = { owner: seg[0], repo: seg[1].replace(/\.git$/, ""), dir: "" };
  if ((seg[2] === "tree" || seg[2] === "blob") && seg[3]) {
    out.ref = decodeURIComponent(seg[3]);
    out.dir = seg.slice(4).map(decodeURIComponent).join("/");
  } else if (seg.length > 2) return null; // issues / pulls 之类的页面，不是仓库首页
  return out;
}

const MAX_FILE = 200_000;
export const LIMITS = { skill: 80, action: 60, rule: 40, mcp: 20, externals: 8 };

type Fetch = typeof fetch;

export interface Ctx {
  src: GithubSrc;
  tree: string[];
  fetchText: (p: string) => Promise<string>;
  /** 下载二进制文件（插件的代码文件） */
  fetchBytes: (p: string, max?: number) => Promise<Buffer>;
  raw: (p: string) => string;
}

/** 读仓库文件的上下文：先 raw.githubusercontent.com，连不上（国内常见）再走 jsDelivr */
export function makeCtx(f: Fetch, src: GithubSrc, tree: string[]): Ctx {
  const get = async (p: string): Promise<Response> => {
    let res: Response | undefined;
    let err: unknown;
    // raw.githubusercontent.com 偶尔超时（国内常见），先重试一次再换 jsDelivr；jsDelivr 对大仓库会 404，所以别一上来就放弃 raw
    for (const u of [rawUrl(src, p), rawUrl(src, p), cdnUrl(src, p)]) {
      try {
        const r = await f(u, { signal: AbortSignal.timeout(30_000) });
        if (r.ok) {
          res = r;
          break;
        }
        err ??= new Error(`HTTP ${r.status}`);
      } catch (e) {
        err ??= e;
      }
    }
    if (!res) throw err instanceof Error ? err : new Error("下载失败");
    return res;
  };
  return {
    src,
    tree,
    raw: p => rawUrl(src, p),
    fetchText: async p => {
      const t = await (await get(p)).text();
      if (t.length > MAX_FILE) throw new Error("文件太大，已跳过");
      return t;
    },
    fetchBytes: async (p, max = 20_000_000) => {
      const b = Buffer.from(await (await get(p)).arrayBuffer());
      if (b.length > max) throw new Error(`文件太大（${p}）`);
      return b;
    },
  };
}

const ref = (s: GithubSrc) => s.ref ?? "HEAD";
const rawUrl = (s: GithubSrc, p: string) => `https://raw.githubusercontent.com/${s.owner}/${s.repo}/${ref(s)}/${p.split("/").map(encodeURIComponent).join("/")}`;
const webUrl = (s: GithubSrc, dir = "") => `https://github.com/${s.owner}/${s.repo}${dir ? `/tree/${ref(s)}/${dir}` : ""}`;
const under = (dir: string) => (dir ? `${dir}/` : "");

class NotFound extends Error {}
class EmptyRepo extends Error {}

async function getJson(f: Fetch, url: string, what: string): Promise<any> {
  const res = await f(url, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/vnd.github+json" } });
  if (res.status === 403 || res.status === 429) throw new Error(`GitHub 暂时限制了访问（匿名请求每小时有次数上限），等一会儿再试：${what}`);
  if (res.status === 409) throw new EmptyRepo(); // GitHub：仓库里还没有任何提交
  if (res.status === 404) throw new NotFound(`在 GitHub 上找不到这个仓库（或它是私有的）：${what}`);
  if (!res.ok) throw new Error(`读取 GitHub 失败（HTTP ${res.status}）：${what}`);
  return res.json();
}

const cdnUrl = (s: GithubSrc, p: string) => `https://cdn.jsdelivr.net/gh/${s.owner}/${s.repo}@${ref(s)}/${p.split("/").map(encodeURIComponent).join("/")}`;

/** 仓库里的文件清单。GitHub API 匿名每小时只有 60 次（共用出口 IP 的网络很容易用光），被限流或连不上时改走 jsDelivr 的清单接口 */
export async function loadTree(f: Fetch, src: GithubSrc, keepBuild = false): Promise<string[]> {
  const what = `${src.owner}/${src.repo}`;
  let paths: string[];
  try {
    const j = await getJson(f, `https://api.github.com/repos/${src.owner}/${src.repo}/git/trees/${encodeURIComponent(ref(src))}?recursive=1`, what);
    paths = (Array.isArray(j?.tree) ? j.tree : []).filter((t: any) => t?.type === "blob" && typeof t.path === "string").map((t: any) => t.path);
  } catch (e) {
    if (e instanceof EmptyRepo) return []; // 空仓库：没有文件，不是出错
    if (e instanceof NotFound) throw e;
    try {
      const res = await f(`https://data.jsdelivr.com/v1/packages/gh/${src.owner}/${src.repo}@${encodeURIComponent(ref(src))}?structure=flat`, { signal: AbortSignal.timeout(20_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j: any = await res.json();
      paths = (Array.isArray(j?.files) ? j.files : []).map((x: any) => String(x?.name ?? "").replace(/^\//, "")).filter(Boolean);
    } catch {
      throw e; // 备用通道也不行，报最初的原因
    }
  }
  // keepBuild：DSH 插件的代码就在编译产物目录（dist/）里，读它们时不能丢掉
  return paths.filter(p => !(keepBuild ? /(^|\/)(node_modules|\.git)\// : /(^|\/)(node_modules|\.git|dist|build)\//).test(p));
}

export async function pool<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

/** 拆 Markdown 开头的 --- 头：返回头里的键值和正文 */
export function splitFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const t = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(t);
  if (!m) return { meta: {}, body: t.trim() };
  const meta: Record<string, string> = {};
  const lines = m[1].split("\n");
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!kv) continue;
    let v = kv[2].trim();
    if (/^[>|][+-]?$/.test(v)) {
      const parts: string[] = [];
      while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) parts.push(lines[++i].trim());
      v = parts.join(" ");
    } else v = v.replace(/^(["'])([\s\S]*)\1$/, "$2");
    meta[kv[1]] = v;
  }
  return { meta, body: t.slice(m[0].length).trim() };
}

const firstLine = (s: string) => (s.split("\n").map(x => x.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "").slice(0, 200);

/** 扫描目录 dir（仓库里的相对路径）下的内容，生成本软件插件源格式的条目（再交给 parseMarketplace 校验） */
export async function scanDir(c: Ctx, dir: string, prefix: string, extra: { tags?: string[]; author?: string; description?: string } = {}): Promise<{ raw: any[]; notes: string[] }> {
  const { src } = c;
  const base = under(dir);
  const rel = (p: string) => p.slice(base.length);
  const mine = c.tree.filter(p => p.startsWith(base) && !/(^|\/)(dist|build)\//.test(p));
  const raw: any[] = [];
  const notes: string[] = [];
  const ids = new Set<string>();
  const pid = (kind: string, name: string) => {
    const root = `${prefix ? prefix + "/" : ""}${kind}-${slug(name)}`;
    let id = root;
    for (let i = 2; ids.has(id); i++) id = `${root}-${i}`;
    ids.add(id);
    return id;
  };
  const common = (d: string) => ({ author: extra.author ?? src.owner, repo: webUrl(src), homepage: webUrl(src, d), tags: ["github", ...(extra.tags ?? [])].slice(0, 8) });

  // 技能：每个 SKILL.md 所在的文件夹就是一个技能，文件夹里其他文件跟着装
  const skillFiles = mine.filter(p => /(^|\/)SKILL\.md$/.test(rel(p))).slice(0, LIMITS.skill);
  if (mine.filter(p => /(^|\/)SKILL\.md$/.test(rel(p))).length > LIMITS.skill) notes.push(`技能太多，只列了前 ${LIMITS.skill} 个`);
  await pool(skillFiles, 8, async p => {
    try {
      const text = await c.fetchText(p);
      const { meta, body } = splitFrontmatter(text);
      const sdir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : ""; // 技能所在文件夹
      const dirName = sdir.split("/").pop() || src.repo;
      const name = /^[A-Za-z0-9_-]{1,64}$/.test(meta.name ?? "") ? meta.name : slug(meta.name || dirName).slice(0, 64);
      const description = (meta.description || firstLine(body) || `${name} 技能`).slice(0, 400);
      // 技能文件夹里的其他文件（脚本、参考资料）跟着装；SKILL.md 直接放在仓库根目录时不带，免得把整个仓库塞进来
      const files = sdir
        ? c.tree
            .filter(f => f.startsWith(under(sdir)) && f !== p && !/(^|\/)SKILL\.md$/.test(f.slice(under(sdir).length)))
            .slice(0, 40)
            .map(f => ({ path: f.slice(under(sdir).length), url: c.raw(f) }))
        : [];
      // _dir：技能所在文件夹（相对路径）。解析插件源时会被忽略，本机导入要靠它找到文件夹把附带文件拷过来
      raw.push({ id: pid("skill", name), _dir: sdir, name: meta.name || dirName, kind: "skill", description, ...common(sdir), install: { name, description, content: body || description, ...(files.length ? { files } : {}) } });
    } catch (e) {
      notes.push(`技能 ${p}：${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // MCP：.mcp.json / mcp.json，里面每个服务一个条目
  const mcpFiles = mine.filter(p => /^(\.mcp\.json|mcp\.json|\.cursor\/mcp\.json)$/.test(rel(p))).slice(0, LIMITS.mcp);
  for (const p of mcpFiles) {
    try {
      const j = JSON.parse(await c.fetchText(p));
      const servers = j && typeof j === "object" ? (j.mcpServers && typeof j.mcpServers === "object" ? j.mcpServers : j) : {};
      for (const [name, s] of Object.entries<any>(servers)) {
        if (!s || typeof s !== "object" || (!s.command && !s.url)) continue;
        raw.push({ id: pid("mcp", name), name, kind: "mcp", description: extra.description || `${src.owner}/${src.repo} 里的 MCP 服务「${name}」`, ...common(dir), install: { server: s, note: s.env && Object.keys(s.env).length ? "装好后到「设置 → MCP」填写环境变量" : undefined } });
      }
    } catch (e) {
      notes.push(`MCP ${p}：${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // 命令：commands/*.md → 动作（$ARGUMENTS 换成 {{input}}）
  const cmdFiles = mine.filter(p => /^(\.claude\/)?commands\/[^/]+\.md$/.test(rel(p))).slice(0, LIMITS.action);
  await pool(cmdFiles, 8, async p => {
    try {
      const { meta, body } = splitFrontmatter(await c.fetchText(p));
      if (!body) return;
      const name = p.split("/").pop()!.replace(/\.md$/, "");
      raw.push({ id: pid("action", name), name: meta.name || name, kind: "action", description: meta.description || firstLine(body) || `${name} 命令`, ...common(dir), install: { prompt: body.replace(/\$ARGUMENTS/g, "{{input}}"), description: meta.description } });
    } catch (e) {
      notes.push(`命令 ${p}：${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // 规则：.cursor/rules/*.mdc / *.md
  const ruleFiles = mine.filter(p => /^\.cursor\/rules\/[^/]+\.mdc?$/.test(rel(p))).slice(0, LIMITS.rule);
  await pool(ruleFiles, 8, async p => {
    try {
      const { meta, body } = splitFrontmatter(await c.fetchText(p));
      if (!body) return;
      const name = p.split("/").pop()!.replace(/\.mdc?$/, "");
      raw.push({ id: pid("rule", name), name, kind: "rule", description: meta.description || firstLine(body) || `${name} 规则`, ...common(dir), install: { content: body } });
    } catch (e) {
      notes.push(`规则 ${p}：${e instanceof Error ? e.message : String(e)}`);
    }
  });

  return { raw, notes };
}

const CATALOG_FILES = [".claude-plugin/marketplace.json", "marketplace.json", "catalog/index.json"];

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** Claude Code 的 marketplace.json：每个插件指向本仓库的一个子目录，或另一个 GitHub 仓库 */
async function fromClaudeMarketplace(f: Fetch, c: Ctx, json: Record<string, any>, depth: number): Promise<{ raw: any[]; notes: string[] }> {
  const raw: any[] = [];
  const notes: string[] = [];
  const root = isObj(json.metadata) && typeof json.metadata.pluginRoot === "string" ? json.metadata.pluginRoot : "";
  const externals: Array<{ name: string; src: GithubSrc; plugin: any }> = [];
  for (const p of (json.plugins as any[]).filter(isObj)) {
    const pname = typeof p.name === "string" ? p.name : "";
    if (!pname) continue;
    const tags = [...(Array.isArray(p.tags) ? p.tags : []), ...(typeof p.category === "string" ? [p.category] : [])].filter((t: unknown): t is string => typeof t === "string");
    const author = isObj(p.author) ? p.author.name : typeof p.author === "string" ? p.author : undefined;
    const description = typeof p.description === "string" ? p.description : undefined;
    const s = p.source;
    if (typeof s === "string" && !/^[a-z][a-z0-9+.-]*:/i.test(s)) {
      // 本仓库里的子目录（"./plugins/x" 或 "plugins/x"；"./" 就是仓库根）
      const sub = s.replace(/^\.\/?/, "").replace(/\/+$/, "");
      const dir = [c.src.dir, root.replace(/^\.\/?|\/+$/g, ""), sub].filter(Boolean).join("/");
      const r = await scanDir(c, dir, slug(pname), { tags: [pname, ...tags], author, description });
      if (isObj(p.mcpServers)) {
        for (const [name, sv] of Object.entries<any>(p.mcpServers)) if (isObj(sv) && (sv.command || sv.url)) r.raw.push({ id: `${slug(pname)}/mcp-${slug(name)}`, name, kind: "mcp", description: description || `${pname} 的 MCP 服务「${name}」`, author: author ?? c.src.owner, repo: webUrl(c.src), tags: ["github", pname], install: { server: sv } });
      }
      raw.push(...r.raw);
      notes.push(...r.notes);
    } else if (isObj(s) && (s.source === "github" || s.source === "url") && depth < 1) {
      const target = s.source === "github" ? parseGithubUrl(String(s.repo ?? "")) : parseGithubUrl(String(s.url ?? "").replace(/\.git$/, ""));
      if (target) externals.push({ name: pname, src: { ...target, ref: s.ref ?? target.ref }, plugin: p });
      else notes.push(`${pname}：来源不是 GitHub 仓库，暂不支持`);
    } else notes.push(`${pname}：来源类型暂不支持`);
  }
  for (const e of externals.slice(0, LIMITS.externals)) {
    try {
      const sub = await loadGithubRepo(f, e.src, { depth: depth + 1 });
      for (const en of sub.raw) raw.push({ ...en, id: `${slug(e.name)}/${en.id}`, tags: [...(en.tags ?? []), e.name].slice(0, 8) });
      notes.push(...sub.notes);
    } catch (err) {
      notes.push(`${e.name}：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (externals.length > LIMITS.externals) notes.push(`指向其他仓库的插件太多，只展开了前 ${LIMITS.externals} 个`);
  return { raw, notes };
}

/** 这个仓库里是技能 / MCP / 规则之类，不是插件 */
export const NOT_PLUGIN = "这个仓库里是技能 / MCP / 规则之类的内容，不是插件。要用它们，请到「设置」里对应的技能、MCP、规则、动作页面，用「从 GitHub 导入」添加。";

/**
 * 读一个 GitHub 仓库，返回「本软件资源格式」的原始条目（技能 / MCP / 动作 / 规则）和备注；仓库自带 DBX 目录时返回 dbx（原始 JSON，由调用方按 DBX 格式解析）。
 * catalogOnly：给插件仓库用，只认 DBX 插件目录；碰到技能 / MCP 这类内容就明说「这不是插件」，不去扫描。
 */
export async function loadGithubRepo(f: Fetch, src: GithubSrc, opts: { depth?: number; catalogOnly?: boolean; tree?: string[] } = {}): Promise<{ raw: any[]; notes: string[]; dbx?: unknown }> {
  const depth = opts.depth ?? 0;
  const tree = opts.tree ?? (await loadTree(f, src));
  // 插件仓库还是空的（比如刚建好、还没发布插件）：当作一个没有插件的目录，不报错
  if (opts.catalogOnly && !tree.length) return { raw: [], notes: [], dbx: { plugins: [] } };
  const base = under(src.dir);
  if (src.dir && !tree.some(p => p.startsWith(base))) throw new Error(`仓库里没有「${src.dir}」这个目录`);
  const c = makeCtx(f, src, tree);

  // 1. 现成的目录文件
  for (const name of CATALOG_FILES) {
    const p = base + name;
    if (!tree.includes(p)) continue;
    let json: unknown;
    try {
      json = JSON.parse(await c.fetchText(p));
    } catch {
      continue;
    }
    const fmt = detectCatalogFormat(json);
    if (fmt === "dbx" && isObj(json) && Array.isArray(json.plugins) && json.plugins.length) return { raw: [], notes: [], dbx: json };
    if (opts.catalogOnly && isObj(json) && Array.isArray(json.plugins) && json.plugins.length) throw new Error(NOT_PLUGIN);
    if (fmt === "native" && isObj(json) && Array.isArray(json.plugins) && json.plugins.length) {
      // 本软件的资源源：直接用它，条目里的 id 等原样保留
      return { raw: json.plugins, notes: [] };
    }
    if (isObj(json) && Array.isArray(json.plugins) && json.plugins.some((x: any) => isObj(x) && x.source !== undefined && x.id === undefined)) {
      const r = await fromClaudeMarketplace(f, c, json, depth);
      if (r.raw.length) return r;
    }
  }

  if (opts.catalogOnly) {
    const has = tree.some(t => t.startsWith(base) && /(^|\/)(SKILL\.md|\.mcp\.json|mcp\.json)$|(^|\/)\.cursor\/rules\/|(^|\/)commands\/[^/]+\.md$/.test(t));
    throw new Error(has ? NOT_PLUGIN : `在 ${src.owner}/${src.repo} 里没找到插件：既没有 DBX 插件目录（catalog/index.json），也没有 Codex / Claude 的插件市场（marketplace.json）或 DSH 插件（package.json 里带 dsh 字段）。`);
  }

  // 2. 扫描仓库本身
  const r = await scanDir(c, src.dir, "");
  if (!r.raw.length) throw new Error(`在 ${src.owner}/${src.repo} 里没找到本软件能用的内容（技能 SKILL.md、MCP 配置 .mcp.json、commands 命令、.cursor/rules 规则，或插件目录文件）。如果它是一个插件仓库，请到「插件」页的仓库管理里添加。`);
  return r;
}

/** 导入 GitHub 仓库并转成条目；name 是来源名（条目 key 的前缀）。catalogOnly 见 loadGithubRepo */
export async function importGithubRepo(f: Fetch, src: GithubSrc, name: string, parseDbx: (json: unknown) => PluginEntry[], opts: { catalogOnly?: boolean; tree?: string[] } = {}): Promise<{ entries: PluginEntry[]; skipped: string[] }> {
  const r = await loadGithubRepo(f, src, opts);
  if (r.dbx) return { entries: parseDbx(r.dbx), skipped: [] };
  const parsed = parseMarketplace(r.raw, name);
  if (!parsed.entries.length) throw new Error(parsed.skipped[0] ? `仓库里的内容都不合格：${parsed.skipped.slice(0, 3).join("；")}` : "仓库里没有可用的内容");
  return { entries: parsed.entries, skipped: [...r.notes, ...parsed.skipped] };
}

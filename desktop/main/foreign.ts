import { DSH_NOTE, foreignId, parseMarketplace, slug, type BundleParts, type Ecosystem, type PluginEntry } from "../shared/plugins";
import { LIMITS, loadTree, makeCtx, parseGithubUrl, pool, scanDir, type Ctx, type GithubSrc } from "./repo-import";

/**
 * 读「别家的插件仓库」：把 Codex、Claude、DSH 的插件翻译成商店里的条目。
 *   · Codex：.agents/plugins/marketplace.json（插件在仓库的 plugins/<名字>/ 里，有 .codex-plugin/plugin.json），
 *     也认单个插件仓库（根目录就是 .codex-plugin/plugin.json 或 Agent Plugins 的 plugin.json）。
 *   · Claude：.claude-plugin/marketplace.json 和 .claude-plugin/plugin.json。
 *   · DSH：package.json 里有 dsh 字段的 npm 插件（根目录或子目录）。
 * Codex / Claude 的插件是「打包」的：里面的技能、MCP、命令、规则拆开来装进本软件，hooks、子 agent、外部应用连接器没有对应的东西，只提醒不装。
 */

type Fetch = typeof fetch;
const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const under = (dir: string) => (dir ? `${dir}/` : "");
const join = (...p: string[]) => p.filter(Boolean).join("/").replace(/\/{2,}/g, "/").replace(/^\.\//, "");

const MARKETPLACES: Array<{ file: string; eco?: "codex" | "claude" }> = [{ file: ".agents/plugins/marketplace.json", eco: "codex" }, { file: ".claude-plugin/marketplace.json", eco: "claude" }, { file: "marketplace.json" }];
const MANIFESTS: Array<{ file: string; eco: "codex" | "claude" }> = [
  { file: ".codex-plugin/plugin.json", eco: "codex" },
  { file: ".claude-plugin/plugin.json", eco: "claude" },
];
const LIMIT = { externals: 8, plugins: 80, dsh: 40 };

export interface ForeignResult {
  entries: PluginEntry[];
  skipped: string[];
  /** 插件包条目 id → 装的时候要写进配置的各项（技能 / MCP / 动作 / 规则） */
  items: Map<string, () => Promise<{ items: PluginEntry[]; notes: string[] }>>;
}

interface Meta {
  /** 插件的标识名（做 id 用，不变）；name 是显示名 */
  key: string;
  name: string;
  description?: string;
  version?: string;
  author?: string;
  homepage?: string;
  category?: string;
  license?: string;
}

const emptyParts = (): BundleParts => ({ skills: 0, mcp: 0, actions: 0, rules: 0 });

/** 路径安全：marketplace 里的 source.path 必须在仓库里面 */
function safeRel(p: string): string | undefined {
  const s = p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (s.startsWith("/") || /(^|\/)\.\.(\/|$)/.test(s) || /^[A-Za-z]:/.test(s)) return undefined;
  return s;
}

async function readJson(c: Ctx, p: string): Promise<any | undefined> {
  if (!c.tree.includes(p)) return undefined;
  try {
    return JSON.parse((await c.fetchText(p)).replace(/^\uFEFF/, ""));
  } catch {
    return undefined;
  }
}

async function readManifest(c: Ctx, dir: string): Promise<{ eco?: "codex" | "claude"; json?: Record<string, any> }> {
  for (const m of MANIFESTS) {
    const j = await readJson(c, join(dir, m.file));
    if (isObj(j)) return { eco: m.eco, json: j };
  }
  const j = await readJson(c, join(dir, "plugin.json"));
  if (isObj(j) && typeof j.$schema === "string" && /agent-plugins/.test(j.$schema)) return { eco: "codex", json: j };
  return {};
}

/** 把一个插件目录做成一个「插件包」条目 */
async function bundleFromDir(c: Ctx, dir: string, meta: Meta, eco: "codex" | "claude", sourceName: string, out: ForeignResult, manifest?: Record<string, any>): Promise<void> {
  const id = foreignId(eco, slug(meta.key));
  if (out.items.has(id)) return;
  const json = manifest ?? (await readManifest(c, dir)).json;
  const notes: string[] = [];
  // 清单里直接写出来的 MCP 服务（对象），或指向别处的 MCP 文件
  const mcp = json?.mcpServers;
  const inline: Record<string, any> = {};
  if (isObj(mcp)) Object.assign(inline, mcp);
  else if (typeof mcp === "string") {
    const rel = safeRel(mcp);
    const f = rel && join(dir, rel);
    const j = f && !/(^|\/)(\.mcp\.json|mcp\.json)$/.test(f.slice(under(dir).length)) ? await readJson(c, f) : undefined;
    if (isObj(j)) Object.assign(inline, isObj(j.mcpServers) ? j.mcpServers : j);
  }
  const inlineMcp = Object.entries(inline).filter(([, s]) => isObj(s) && (s.command || s.url));
  const base = under(dir);
  const mine = c.tree.filter(p => p.startsWith(base));
  const rel = (p: string) => p.slice(base.length);
  const has = (re: RegExp) => mine.some(p => re.test(rel(p)));
  if (has(/^hooks(\/|\.json$)/)) notes.push("里面有 hooks（生命周期脚本），本软件不支持，已忽略");
  if (has(/^\.app\.json$/)) notes.push("里面有 apps（外部应用连接器），本软件不支持，已忽略");
  if (has(/^agents\/[^/]+\.(md|toml|json|ya?ml)$/)) notes.push("里面有子 agent 定义，本软件不支持，已忽略");

  // 商店里只数一数有什么（不下载技能、命令的内容，那些等用户真的要装时才下载）：技能、命令、规则按文件数，MCP 要读一下 .mcp.json 才知道有几个服务
  const parts = emptyParts();
  const count = (re: RegExp, max: number) => Math.min(mine.filter(p => !/(^|\/)(dist|build)\//.test(rel(p)) && re.test(rel(p))).length, max);
  parts.skills = count(/(^|\/)SKILL\.md$/, LIMITS.skill);
  parts.actions = count(/^(\.claude\/)?commands\/[^/]+\.md$/, LIMITS.action);
  parts.rules = count(/^\.cursor\/rules\/[^/]+\.mdc?$/, LIMITS.rule);
  const mcpNames = new Set(inlineMcp.map(([n]) => n));
  for (const p of mine.filter(x => /^(\.mcp\.json|mcp\.json|\.cursor\/mcp\.json)$/.test(rel(x))).slice(0, LIMITS.mcp)) {
    const j = await readJson(c, p);
    const servers = isObj(j) ? (isObj(j.mcpServers) ? j.mcpServers : j) : {};
    for (const [n, s] of Object.entries(servers)) if (isObj(s) && (s.command || s.url)) mcpNames.add(n);
  }
  parts.mcp = mcpNames.size;
  if (!parts.skills && !parts.actions && !parts.rules && !parts.mcp) {
    out.skipped.push(`${meta.name}：里面没有本软件能用的内容（技能、MCP、命令、规则）${notes.length ? `。${notes[0]}` : ""}`);
    return;
  }

  // 真正要装时才执行：下载技能、命令、规则的内容，整理成一项一项的条目
  let loaded: Promise<{ items: PluginEntry[]; notes: string[] }> | undefined;
  out.items.set(id, () =>
    (loaded ??= (async () => {
      const r = await scanDir(c, dir, slug(meta.key), { tags: [meta.name, ...(meta.category ? [meta.category] : [])], author: meta.author, description: meta.description });
      const raw = [...r.raw];
      for (const [n, s] of inlineMcp) {
        if (raw.some(x => x.kind === "mcp" && x.name === n)) continue;
        raw.push({ id: `${slug(meta.key)}/mcp-${slug(n)}`, name: n, kind: "mcp", description: meta.description || `${meta.name} 的 MCP 服务「${n}」`, author: meta.author ?? c.src.owner, repo: `https://github.com/${c.src.owner}/${c.src.repo}`, tags: ["github", meta.name], install: { server: s } });
      }
      const parsed = parseMarketplace(raw, sourceName);
      return { items: parsed.entries, notes: [...r.notes, ...parsed.skipped] };
    })().catch(e => {
      loaded = undefined; // 这次失败了，下次可以重试
      throw e;
    })),
  );
  const ownRepo = `https://github.com/${c.src.owner}/${c.src.repo}`;
  out.entries.push({
    key: `${sourceName}:${id}`,
    id,
    name: meta.name,
    kind: "bundle",
    ecosystem: eco,
    author: meta.author ?? c.src.owner,
    description: meta.description ?? "",
    tags: [...(meta.category ? [meta.category] : []), eco === "codex" ? "Codex" : "Claude"].slice(0, 8),
    version: meta.version,
    license: meta.license,
    homepage: meta.homepage && /^https?:\/\//.test(meta.homepage) ? meta.homepage : undefined,
    repo: ownRepo,
    source: sourceName,
    note: notes.length ? `${notes.join("；")}。` : undefined,
    install: { kind: "bundle", ecosystem: eco, parts, notes },
  });
}

const metaOf = (name: string, json: Record<string, any> | undefined, extra: Record<string, any> = {}): Meta => {
  const iface = isObj(json?.interface) ? json!.interface : {};
  const author = isObj(json?.author) ? json!.author.name : json?.author;
  const eAuthor = isObj(extra.author) ? extra.author.name : extra.author;
  return {
    key: name,
    name: str(iface.displayName) ?? str(extra.displayName) ?? name,
    description: str(extra.description) ?? str(json?.description) ?? str(iface.shortDescription) ?? str(iface.longDescription),
    version: str(extra.version) ?? str(json?.version),
    author: str(eAuthor) ?? str(author) ?? str(iface.developerName),
    homepage: str(extra.homepage) ?? str(json?.homepage) ?? str(iface.websiteURL),
    category: str(extra.category) ?? str(iface.category),
    license: str(json?.license),
  };
};

/** marketplace.json 里的 source：本仓库里的目录，或另一个 GitHub 仓库（可带子目录） */
type Located = { local: string } | { repo: GithubSrc; sub: string } | { error: string };
function locate(s: unknown, root: string, base: string): Located {
  if (typeof s === "string") {
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
      const g = parseGithubUrl(s.replace(/\.git$/, ""));
      return g ? { repo: g, sub: g.dir } : { error: "来源不是 GitHub 仓库，暂不支持" };
    }
    const rel = safeRel(s);
    return rel === undefined ? { error: "来源路径不安全" } : { local: join(base, root, rel) };
  }
  if (!isObj(s)) return { error: "来源格式不认识" };
  const kind = String(s.source ?? s.type ?? "");
  if (kind === "local" || (!kind && typeof s.path === "string")) {
    const rel = safeRel(String(s.path ?? ""));
    return rel === undefined ? { error: "来源路径不安全" } : { local: join(base, root, rel) };
  }
  if (kind === "github" || kind === "url" || kind === "git" || kind === "git-subdir") {
    const raw = String(s.repo ?? s.url ?? "");
    const g = parseGithubUrl(kind === "github" && !/^https?:/.test(raw) ? raw : raw.replace(/\.git$/, ""));
    if (!g) return { error: "来源不是 GitHub 仓库，暂不支持" };
    const sub = safeRel(String(s.path ?? s.subdir ?? "")) ?? "";
    return { repo: { ...g, ref: str(s.ref) ?? str(s.sha) ?? g.ref }, sub: join(g.dir, sub) };
  }
  return { error: `来源类型「${kind || "?"}」暂不支持` };
}

async function fromMarketplace(f: Fetch, c: Ctx, json: Record<string, any>, eco: "codex" | "claude", sourceName: string, base: string, out: ForeignResult, depth: number): Promise<void> {
  const root = isObj(json.metadata) && typeof json.metadata.pluginRoot === "string" ? (safeRel(json.metadata.pluginRoot) ?? "") : "";
  const externals: Array<{ p: Record<string, any>; repo: GithubSrc; sub: string }> = [];
  const locals: Array<{ pname: string; p: Record<string, any>; dir: string }> = [];
  for (const p of (json.plugins as any[]).filter(isObj).slice(0, LIMIT.plugins)) {
    const pname = str(p.name);
    if (!pname) continue;
    const loc = locate(p.source, root, base);
    if ("error" in loc) {
      out.skipped.push(`${pname}：${loc.error}`);
      continue;
    }
    if ("local" in loc) locals.push({ pname, p, dir: loc.local });
    else if (depth < 1) externals.push({ p, repo: loc.repo, sub: loc.sub });
    else out.skipped.push(`${pname}：来源在别的仓库里，嵌套太深，已跳过`);
  }
  // 同一个仓库里的插件一起读（每个只要读几个小文件），比一个个排队快得多；结果按原来的先后排
  const parts = await pool(locals, 6, async l => {
    const sub: ForeignResult = { entries: [], skipped: [], items: new Map() };
    try {
      const { json: mj } = await readManifest(c, l.dir);
      await bundleFromDir(c, l.dir, metaOf(l.pname, mj, l.p), eco, sourceName, sub, mj);
    } catch (err) {
      sub.skipped.push(`${l.pname}：${err instanceof Error ? err.message : String(err)}`);
    }
    return sub;
  });
  for (const s of parts) {
    for (const e of s.entries) if (!out.items.has(e.id)) out.entries.push(e);
    out.skipped.push(...s.skipped);
    for (const [k, v] of s.items) if (!out.items.has(k)) out.items.set(k, v);
  }
  for (const e of externals.slice(0, LIMIT.externals)) {
    const pname = String(e.p.name);
    try {
      const tree = await loadTree(f, e.repo);
      if (!tree.length) {
        out.skipped.push(`${pname}：它所在的仓库是空的`);
        continue;
      }
      const ec = makeCtx(f, e.repo, tree);
      const { json: mj } = await readManifest(ec, e.sub);
      await bundleFromDir(ec, e.sub, metaOf(pname, mj, e.p), eco, sourceName, out);
    } catch (err) {
      out.skipped.push(`${pname}：${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (externals.length > LIMIT.externals) out.skipped.push(`指向其他仓库的插件太多，只展开了前 ${LIMIT.externals} 个`);
}

/** 是不是 DSH 插件的 package.json：有 dsh 字段，或者依赖 / 对等依赖里有 @deepseek-ai/* */
export function isDshPackage(pkg: unknown): boolean {
  if (!isObj(pkg) || typeof pkg.name !== "string") return false;
  if (isObj(pkg.dsh)) return true;
  return [pkg.dependencies, pkg.peerDependencies, pkg.devDependencies].some(d => isObj(d) && Object.keys(d).some(k => k.startsWith("@deepseek-ai/")));
}

/** 编译好的入口文件（main / exports）在不在仓库里 */
export function dshEntryInTree(pkg: Record<string, any>, dir: string, tree: string[]): boolean {
  const pick = (v: unknown): string | undefined => (typeof v === "string" ? v : isObj(v) ? pick(v["."] ?? v.import ?? v.node ?? v.default ?? v.require) : undefined);
  const rel = (pick(pkg.exports) ?? str(pkg.main) ?? "index.js").replace(/^\.\//, "");
  return tree.includes(join(dir, rel)) || (!/\.\w+$/.test(rel) && (tree.includes(join(dir, `${rel}.js`)) || tree.includes(join(dir, rel, "index.js"))));
}

async function dshFromRepo(c: Ctx, base: string, sourceName: string, out: ForeignResult): Promise<void> {
  const pkgs = c.tree.filter(p => p.startsWith(under(base)) && /(^|\/)package\.json$/.test(p) && p.slice(under(base).length).split("/").length <= 4).slice(0, LIMIT.dsh);
  for (const p of pkgs) {
    const pkg = await readJson(c, p);
    if (!isDshPackage(pkg)) continue;
    const dir = p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";
    const name = String(pkg.name);
    if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(name)) continue;
    if (!dshEntryInTree(pkg, dir, c.tree)) {
      out.skipped.push(`${name}：仓库里没有编译好的入口文件（需要先编译），本软件不能编译插件`);
      continue;
    }
    const id = foreignId("dsh", name);
    if (out.items.has(id) || out.entries.some(e => e.id === id)) continue;
    const gh = `https://github.com/${c.src.owner}/${c.src.repo}`;
    out.entries.push({
      key: `${sourceName}:${id}`,
      id,
      name,
      kind: "dsh",
      ecosystem: "dsh",
      author: (isObj(pkg.author) ? str(pkg.author.name) : str(pkg.author)) ?? c.src.owner,
      description: str(pkg.description) ?? "",
      tags: ["github", ...(Array.isArray(pkg.keywords) ? pkg.keywords.filter((k: unknown): k is string => typeof k === "string" && !/^(dsh|dsh-plugin|deepseek-harness)$/.test(k)) : [])].slice(0, 8),
      version: str(pkg.version),
      license: str(pkg.license),
      homepage: str(pkg.homepage) && /^https?:\/\//.test(pkg.homepage) ? pkg.homepage : undefined,
      repo: dir ? `${gh}/tree/${c.src.ref ?? "HEAD"}/${dir}` : gh,
      source: sourceName,
      note: DSH_NOTE,
      install: { kind: "dsh", pkg: name, version: str(pkg.version) ?? "0.0.0", source: { type: "git", url: gh, commit: c.src.ref ?? "HEAD", ...(dir ? { dir } : {}) } },
    });
  }
}

/**
 * 在一个 GitHub 仓库里找 Codex / Claude / DSH 的插件；什么都没找到返回 null（调用方再报「这不是插件仓库」）。
 * 仓库自己的 DBX 目录（catalog/index.json）由调用方先处理。
 */
export async function discoverForeign(f: Fetch, c: Ctx, sourceName: string, depth = 0): Promise<ForeignResult | null> {
  const out: ForeignResult = { entries: [], skipped: [], items: new Map() };
  const base = c.src.dir;

  // 1. 插件市场文件
  for (const m of MARKETPLACES) {
    const json = await readJson(c, join(base, m.file));
    if (!isObj(json) || !Array.isArray(json.plugins) || !json.plugins.length) continue;
    const list = json.plugins.filter(isObj);
    if (list.some(x => typeof x.kind === "string" && isObj(x.install)) || list.some(x => typeof x.id === "string" && Array.isArray(x.versions))) continue; // 本软件格式 / DBX 目录，不是别家的市场
    const eco = m.eco ?? (list.some(x => (isObj(x.source) && (x.source.source === "local" || x.source.path)) || isObj(x.policy)) ? "codex" : "claude");
    await fromMarketplace(f, c, json, eco, sourceName, base, out, depth);
    if (out.entries.length || out.skipped.length) return out;
  }

  // 2. 没有市场文件：仓库本身（或子目录）就是插件
  const mdirs = new Map<string, "codex" | "claude">();
  for (const p of c.tree) {
    if (!p.startsWith(under(base))) continue;
    for (const m of MANIFESTS) if (p.endsWith(`/${m.file}`) || p === m.file) mdirs.set(p.slice(0, p.length - m.file.length).replace(/\/$/, ""), m.eco);
    if (/(^|\/)plugin\.json$/.test(p) && !p.includes(".codex-plugin/") && !p.includes(".claude-plugin/")) {
      const j = await readJson(c, p);
      if (isObj(j) && typeof j.$schema === "string" && /agent-plugins/.test(j.$schema)) mdirs.set(p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "", "codex");
    }
  }
  for (const [dir, eco] of [...mdirs].slice(0, LIMIT.plugins)) {
    const { json } = await readManifest(c, dir);
    const name = str(json?.name) ?? (dir.split("/").pop() || c.src.repo);
    await bundleFromDir(c, dir, metaOf(name, json), eco, sourceName, out);
  }
  if (out.entries.length || out.skipped.length) return out;

  // 3. DSH 的 npm 插件
  await dshFromRepo(c, base, sourceName, out);
  return out.entries.length || out.skipped.length ? out : null;
}

/** 直接给一个 GitHub 来源，读它里面的 Codex / Claude / DSH 插件（给测试和别处复用） */
export async function loadForeignRepo(f: Fetch, src: GithubSrc, sourceName: string): Promise<ForeignResult | null> {
  const tree = await loadTree(f, src, true);
  if (!tree.length) return null;
  return discoverForeign(f, makeCtx(f, src, tree), sourceName);
}

export const ecoOfEntry = (e: PluginEntry): Ecosystem | undefined => e.ecosystem;

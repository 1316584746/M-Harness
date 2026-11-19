/**
 * 插件中心的数据模型与安装 / 卸载逻辑（主进程与界面共用，纯函数、不碰文件系统）。
 *
 * 插件有四种：
 *   mcp    写进配置里的 mcpServers
 *   skill  写成应用内的 SKILL.md（文件由调用方写，这里只处理配置）
 *   action 写进配置里的 actions
 *   rule   写进配置里的 rules.items
 * 已安装的插件记在配置的 plugins.installed 里，卸载时按记录把对应内容删掉。
 */
import { cmpVerStr, parseVer } from "./semver";

/**
 * 前四种是写进配置的资源；dbx / dsh / bundle 是商店里的「插件」：
 *   dbx     DBX 的 .dbxp 插件包
 *   dsh     DSH（DeepSeek Harness）的 npm 插件，由兼容运行器加载，提供 AI 工具
 *   bundle  Codex / Claude 这类「打包」的插件：装的时候拆成技能、MCP、动作、规则写进本软件
 */
export type PluginKind = "mcp" | "skill" | "action" | "rule" | "dbx" | "dsh" | "bundle";
/** 插件源 JSON 里允许写的类型（dbx / dsh / bundle 只能来自各家的插件仓库） */
export const PLUGIN_KINDS: PluginKind[] = ["mcp", "skill", "action", "rule"];
/** 商店里能筛选的类型 */
export const STORE_KINDS: PluginKind[] = [...PLUGIN_KINDS, "dbx", "dsh", "bundle"];
export const KIND_LABEL: Record<PluginKind, string> = { mcp: "MCP", skill: "技能", action: "动作", rule: "规则", dbx: "DBX", dsh: "DSH", bundle: "插件包" };
/** 资源类（写进配置里的）四种 */
export type ResourceKind = "mcp" | "skill" | "action" | "rule";

/** 插件来自哪一家的体系 */
export type Ecosystem = "dbx" | "dsh" | "codex" | "claude";
export const ECOSYSTEM_LABEL: Record<Ecosystem, string> = { dbx: "DBX 插件", dsh: "DSH 插件", codex: "Codex 插件", claude: "Claude 插件" };
/** 非 DBX 插件的 id 前缀（DBX 的 id 里不会有冒号，所以一眼能分开） */
export const foreignId = (eco: Exclude<Ecosystem, "dbx">, name: string): string => `${eco}:${name}`;
export const isForeignId = (id: string): boolean => /^(dsh|codex|claude):/.test(id);

/** DBX 插件中心在商店里的「仓库」名 */
export const DBX_SOURCE = "DBX 插件中心";
/** M-Harness 官方插件仓库：和别的仓库一样可以停用、删除 */
export const OFFICIAL_REPO_NAME = "M-Harness 官方插件";
export const OFFICIAL_REPO_URL = "https://github.com/1316584746/M-Market";
/** 从本地文件 / 链接安装的插件，记在这个「来源」下 */
export const LOCAL_SOURCE = "本地安装";

export interface McpSpec {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export type PluginInstall =
  | { kind: "mcp"; server: McpSpec; note?: string }
  | { kind: "skill"; name: string; description: string; content: string; /** 技能文件夹里的其他文件（脚本、参考资料），安装时一起下载 */ files?: Array<{ path: string; url: string }> }
  | { kind: "action"; prompt: string; description?: string }
  | { kind: "rule"; content: string }
  /** DBX 插件（.dbxp 包）：由本软件下载、校验、安装到自己的插件目录 */
  | { kind: "dbx"; dbxId: string; url?: string; sha256?: string; size?: number; permissions: string[] }
  /** DSH 的 npm 插件：来源是 npm 包，或固定到某个提交的 git 仓库 */
  | { kind: "dsh"; pkg: string; version: string; source: DshSource }
  /** Codex / Claude 的插件包：里面的技能 / MCP / 命令 / 规则数量（具体内容在主进程里，装的时候才用） */
  | { kind: "bundle"; ecosystem: "codex" | "claude"; parts: BundleParts; notes: string[] };

export type DshSource = { type: "npm"; registry?: string } | { type: "git"; url: string; commit: string; /** 插件在仓库里的子目录 */ dir?: string };

export interface BundleParts {
  skills: number;
  mcp: number;
  actions: number;
  rules: number;
}

/** 「3 个技能、1 个 MCP」这样的一句话 */
export function partsText(p: BundleParts): string {
  const t = [p.skills && `${p.skills} 个技能`, p.mcp && `${p.mcp} 个 MCP`, p.actions && `${p.actions} 个动作`, p.rules && `${p.rules} 条规则`].filter(Boolean);
  return t.length ? t.join("、") : "没有本软件能用的内容";
}

/** 装在本软件里的插件的内容摘要（读自插件自带的 manifest） */
export interface LocalPluginInfo {
  version: string;
  /** 装的时候插件目录里登记的版本（判断「可更新」用它；和 version 不一样时，version 是插件自己 package.json 里写的） */
  listed?: string;
  name?: string;
  /** 不是 DBX 的插件：来自哪一家，和装进来的内容说明 */
  ecosystem?: Ecosystem;
  summary?: string;
  /** 有界面 / 有后台程序 */
  ui: boolean;
  backend: boolean;
  permissions: string[];
  /** 贡献点类型：workbench / mcp / connection-provider … */
  kinds: string[];
  /** 声明的 AI 工具数 */
  tools: number;
}

/** 插件装在哪：本软件自己的插件目录，和本机 DBX 的情况 */
export interface DbxInfo {
  appFound: boolean;
  /** 已装在 DBX 里的插件：id → 版本 */
  plugins: Record<string, string>;
  /** 已装在本软件里的插件：id → 摘要（不需要 DBX） */
  local: Record<string, LocalPluginInfo>;
  /** 本软件的插件安装目录 */
  dir?: string;
  /** 找得到 DBX 的 MCP 组件时，桥接用的启动命令 */
  mcp?: { command: string; args: string[] };
}

export interface PluginEntry {
  /** 全局唯一：`${source}:${id}` */
  key: string;
  id: string;
  name: string;
  kind: PluginKind;
  author?: string;
  description: string;
  tags: string[];
  version?: string;
  license?: string;
  /** YYYY-MM-DD */
  updated?: string;
  homepage?: string;
  /** 源码仓库 */
  repo?: string;
  /** 安装次数（插件源自己提供才有，不会编造） */
  downloads?: number;
  /** 来自哪个插件源 */
  source: string;
  /** 来自哪一家的体系（DBX / DSH / Codex / Claude）；资源类条目没有 */
  ecosystem?: Ecosystem;
  /** 给用户的提醒，比如「DSH 插件只有 AI 工具能用」 */
  note?: string;
  install: PluginInstall;
}

export interface InstalledRecord {
  kind: PluginKind;
  name: string;
  version?: string;
  /** 实际写进配置里的名字 / id（MCP 服务名、动作 id、规则 id、技能名）；插件包是插件 id */
  ref: string;
  at: number;
  /** 插件包：它装进配置的各项的 key，卸载时一起删 */
  members?: string[];
  ecosystem?: Ecosystem;
}

/** 插件仓库：一个 GitHub 仓库，或一份目录文件（DBX 目录 / 本软件的插件源 / Claude 市场）。全部由用户配置，都能停用、删除 */
export interface PluginRepo {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
}

export interface MarketplaceCfg {
  name?: string;
  /** JSON 地址，或 owner/repo（读该仓库根目录的 marketplace.json） */
  url: string;
  enabled?: boolean;
}

export interface MarketResult {
  entries: PluginEntry[];
  errors: Array<{ source: string; error: string }>;
  /** 成功加载的自定义插件源：地址 → 显示名 / 插件数 */
  sources?: Array<{ url: string; label: string; count: number }>;
  /** 本机 DBX 的情况 */
  dbx?: DbxInfo;
}

/** 技能 / MCP / 动作 / 规则里的一项推荐或导入结果（不是插件，各在自己的设置页里用） */
export interface ResourceItem {
  key: string;
  kind: ResourceKind;
  name: string;
  description: string;
  author?: string;
  tags: string[];
  /** 来源：「owner/repo」或「软件自带的推荐」 */
  source: string;
  homepage?: string;
  /** 提醒，比如 MCP 需要本机装 uv */
  note?: string;
  /** 已经在配置里了 */
  added: boolean;
}

/** 「同步」里的一个平台（Cursor / Claude Code / Codex）：用户在「设置 → 模型」里添加过它的账号才算 configured */
export interface PlatformInfo {
  id: "cursor" | "claude" | "codex";
  name: string;
  /** 在「设置 → 模型」里添加过这个平台的账号 */
  configured: boolean;
  /** 本机上找得到它的用户目录 */
  found: boolean;
}

export interface ResourceScan {
  ok: boolean;
  items?: ResourceItem[];
  skipped?: string[];
  error?: string;
}

/** 仓库目录的格式：DBX 的 catalog、本软件自己的插件源（MCP / 技能 / 动作 / 规则） */
export type CatalogFormat = "dbx" | "native" | "dsh";

/** 看内容认格式：条目带 versions 的是 DBX 目录，带 kind + install 的是本软件的插件源（根是数组也算）；认不出来返回 null */
export function detectCatalogFormat(json: unknown): CatalogFormat | null {
  const list = Array.isArray(json) ? json : isObj(json) && Array.isArray(json.plugins) ? json.plugins : null;
  if (!list) return null;
  const items = list.filter(isObj);
  if (!items.length) return Array.isArray(json) ? "native" : "dbx"; // 空目录：按 DBX 的 {plugins:[]} 处理
  if (!Array.isArray(json) && items.some(x => Array.isArray(x.versions) && str(x.id))) return "dbx";
  if (items.some(x => typeof x.kind === "string" && isObj(x.install))) return "native";
  // DSH 的市场索引：没有 id，条目是 name + versions[]，每个版本带 source（npm 或固定提交的 git）
  if (!Array.isArray(json) && items.some(x => str(x.name) && !x.id && Array.isArray(x.versions) && x.versions.some((v: any) => isObj(v) && isObj(v.source) && (v.source.type === "npm" || v.source.type === "git")))) return "dsh";
  return null;
}

type Cfg = Record<string, any>;

export const slug = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "plugin";

/** id 最后一段，去掉 mcp- / action- 之类的类型前缀：mcp-time → time */
const baseOf = (e: { id: string }, kind: PluginKind): string => slug((e.id.split("/").pop() ?? e.id).replace(new RegExp(`^${kind}-`, "i"), ""));

function unique(base: string, taken: (k: string) => boolean): string {
  if (!taken(base)) return base;
  for (let i = 2; ; i++) if (!taken(`${base}-${i}`)) return `${base}-${i}`;
}

export const installedOf = (cfg: Cfg | null | undefined): Record<string, InstalledRecord> => cfg?.plugins?.installed ?? {};

/** 安装（或更新）一个插件：改 cfg，并返回记录。技能的文件由调用方另外写 */
export function applyInstall(cfg: Cfg, e: PluginEntry, now = Date.now()): InstalledRecord {
  cfg.plugins ??= {};
  cfg.plugins.installed ??= {};
  const prev: InstalledRecord | undefined = cfg.plugins.installed[e.key];
  const ins = e.install;
  let ref: string;

  if (ins.kind === "mcp") {
    cfg.mcpServers ??= {};
    ref = prev?.ref ?? unique(baseOf(e, "mcp"), k => k in cfg.mcpServers);
    const old = cfg.mcpServers[ref] ?? {};
    // 更新时保留用户已经填的环境变量 / 关掉的工具 / 权限
    cfg.mcpServers[ref] = {
      ...ins.server,
      args: ins.server.args ?? [],
      env: ins.server.env || old.env ? { ...ins.server.env, ...old.env } : undefined,
      enabled: old.enabled ?? true,
      disabledTools: old.disabledTools ?? [],
      permission: old.permission ?? "confirm",
    };
  } else if (ins.kind === "action") {
    cfg.actions ??= [];
    ref = prev?.ref ?? unique(`plugin-${baseOf(e, "action")}`, k => cfg.actions.some((a: any) => a.id === k));
    const item = { id: ref, name: e.name, prompt: ins.prompt, ...(ins.description ? { description: ins.description } : {}) };
    const i = cfg.actions.findIndex((a: any) => a.id === ref);
    if (i >= 0) cfg.actions[i] = item;
    else cfg.actions.push(item);
  } else if (ins.kind === "rule") {
    cfg.rules ??= { items: [], useProjectFiles: true };
    cfg.rules.items ??= [];
    ref = prev?.ref ?? unique(`plugin-${baseOf(e, "rule")}`, k => cfg.rules.items.some((r: any) => r.id === k));
    const i = cfg.rules.items.findIndex((r: any) => r.id === ref);
    const item = { id: ref, title: e.name, content: ins.content, enabled: i >= 0 ? (cfg.rules.items[i].enabled ?? true) : true };
    if (i >= 0) cfg.rules.items[i] = item;
    else cfg.rules.items.push(item);
  } else if (ins.kind === "dbx" || ins.kind === "dsh" || ins.kind === "bundle") {
    throw new Error("这是插件，请到插件中心安装");
  } else {
    ref = ins.name;
    if (cfg.skills?.disabled) cfg.skills.disabled = cfg.skills.disabled.filter((n: string) => n !== ref);
  }

  const rec: InstalledRecord = { kind: e.kind, name: e.name, version: e.version, ref, at: now };
  cfg.plugins.installed[e.key] = rec;
  return rec;
}

/** 卸载：把安装时写进配置的内容删掉，返回被删的记录（技能要调用方再删文件） */
export function applyUninstall(cfg: Cfg, key: string): InstalledRecord | null {
  const rec: InstalledRecord | undefined = cfg.plugins?.installed?.[key];
  if (!rec) return null;
  if (rec.kind === "mcp") delete cfg.mcpServers?.[rec.ref];
  else if (rec.kind === "action") cfg.actions = (cfg.actions ?? []).filter((a: any) => a.id !== rec.ref);
  else if (rec.kind === "rule" && cfg.rules?.items) cfg.rules.items = cfg.rules.items.filter((r: any) => r.id !== rec.ref);
  else if (rec.kind === "skill" && cfg.skills?.disabled) cfg.skills.disabled = cfg.skills.disabled.filter((n: string) => n !== rec.ref);
  delete cfg.plugins.installed[key];
  return rec;
}

/** 启用 / 停用：MCP、规则、技能支持；动作没有开关 */
export function isEnabled(cfg: Cfg, rec: InstalledRecord): boolean | undefined {
  if (rec.kind === "mcp") return cfg.mcpServers?.[rec.ref]?.enabled ?? true;
  if (rec.kind === "rule") return cfg.rules?.items?.find((r: any) => r.id === rec.ref)?.enabled ?? true;
  if (rec.kind === "skill") return !(cfg.skills?.disabled ?? []).includes(rec.ref);
  return undefined;
}

export function setEnabled(cfg: Cfg, rec: InstalledRecord, on: boolean): void {
  if (rec.kind === "mcp" && cfg.mcpServers?.[rec.ref]) cfg.mcpServers[rec.ref].enabled = on;
  else if (rec.kind === "rule") {
    const r = cfg.rules?.items?.find((x: any) => x.id === rec.ref);
    if (r) r.enabled = on;
  } else if (rec.kind === "skill") {
    cfg.skills ??= {};
    const d: string[] = (cfg.skills.disabled ??= []);
    cfg.skills.disabled = on ? d.filter(n => n !== rec.ref) : d.includes(rec.ref) ? d : [...d, rec.ref];
  }
}

// ───────────── 插件源 JSON 的校验 ─────────────

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const strRec = (v: unknown): Record<string, string> | undefined => {
  if (!isObj(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) if (typeof x === "string") out[k] = x;
  return out;
};

function parseInstall(kind: PluginKind, raw: any, name: string, description: string): PluginInstall | string {
  const r = isObj(raw) ? raw : {};
  if (kind === "mcp") {
    const s = isObj(r.server) ? r.server : r;
    const command = str(s.command);
    const url = str(s.url);
    if (!command && !url) return "MCP 插件需要 install.server.command 或 url";
    if (url && !/^https?:\/\//.test(url)) return "MCP 的 url 必须是 http(s) 地址";
    return {
      kind,
      server: { command, args: Array.isArray(s.args) ? s.args.filter((a: unknown) => typeof a === "string") : undefined, env: strRec(s.env), url, headers: strRec(s.headers) },
      note: str(r.note),
    };
  }
  if (kind === "skill") {
    const n = str(r.name);
    const content = str(r.content);
    if (!n || !/^[A-Za-z0-9_-]{1,64}$/.test(n)) return "技能需要 install.name（字母、数字、短横线、下划线）";
    if (!content) return "技能需要 install.content（SKILL.md 正文）";
    // 附带文件：路径必须是技能文件夹里的相对路径，地址只认 raw.githubusercontent.com，最多 40 个
    const files = Array.isArray(r.files)
      ? r.files
          .filter((f: any) => isObj(f) && typeof f.path === "string" && typeof f.url === "string" && !/(^|[\\/])\.\.([\\/]|$)/.test(f.path) && !/^([\\/]|[A-Za-z]:)/.test(f.path) && /^https:\/\/raw\.githubusercontent\.com\//.test(f.url))
          .slice(0, 40)
          .map((f: any) => ({ path: f.path as string, url: f.url as string }))
      : [];
    return { kind, name: n, description: str(r.description) ?? description, content, ...(files.length ? { files } : {}) };
  }
  if (kind === "action") {
    const prompt = str(r.prompt);
    if (!prompt) return "动作需要 install.prompt";
    return { kind, prompt, description: str(r.description) };
  }
  const content = str(r.content);
  if (!content) return "规则需要 install.content";
  return { kind: "rule", content };
}

/** 解析一个插件源 JSON（`{plugins:[…]}` 或直接是数组）；坏条目跳过并记录原因 */
export function parseMarketplace(json: unknown, source: string): { entries: PluginEntry[]; name?: string; skipped: string[] } {
  const list = Array.isArray(json) ? json : isObj(json) && Array.isArray(json.plugins) ? json.plugins : null;
  if (!list) throw new Error("格式不对：需要 {\"plugins\": [...]} 或数组");
  const entries: PluginEntry[] = [];
  const skipped: string[] = [];
  const seen = new Set<string>();
  for (const [i, raw] of list.entries()) {
    const label = isObj(raw) ? (str(raw.name) ?? str(raw.id) ?? `#${i + 1}`) : `#${i + 1}`;
    if (!isObj(raw)) {
      skipped.push(`${label}：不是对象`);
      continue;
    }
    const id = str(raw.id);
    const name = str(raw.name);
    const kind = raw.kind as PluginKind;
    const description = str(raw.description);
    if (!id || !/^[A-Za-z0-9._/-]+$/.test(id)) {
      skipped.push(`${label}：缺少合法的 id`);
      continue;
    }
    if (!name || !description) {
      skipped.push(`${label}：需要 name 和 description`);
      continue;
    }
    if (!PLUGIN_KINDS.includes(kind)) {
      skipped.push(`${label}：kind 只能是 ${PLUGIN_KINDS.join(" / ")}`);
      continue;
    }
    const install = parseInstall(kind, raw.install, name, description);
    if (typeof install === "string") {
      skipped.push(`${label}：${install}`);
      continue;
    }
    if (seen.has(id)) {
      skipped.push(`${label}：id 重复`);
      continue;
    }
    seen.add(id);
    const updated = str(raw.updated);
    entries.push({
      key: `${source}:${id}`,
      id,
      name,
      kind,
      author: str(raw.author),
      description,
      tags: Array.isArray(raw.tags) ? raw.tags.filter((t: unknown): t is string => typeof t === "string").slice(0, 8) : [],
      version: str(raw.version),
      license: str(raw.license),
      updated: updated && /^\d{4}-\d{2}-\d{2}/.test(updated) ? updated.slice(0, 10) : undefined,
      homepage: str(raw.homepage) && /^https?:\/\//.test(raw.homepage) ? raw.homepage : undefined,
      repo: str(raw.repo) && /^https?:\/\//.test(raw.repo) ? raw.repo : undefined,
      downloads: typeof raw.downloads === "number" && Number.isFinite(raw.downloads) && raw.downloads >= 0 ? Math.floor(raw.downloads) : undefined,
      source,
      install,
    });
  }
  return { entries, name: isObj(json) ? str(json.name) : undefined, skipped };
}

/** 插件包：单个插件对象，或和插件源一样的 {plugins:[…]} / 数组 */
export function parsePackage(json: unknown, source = LOCAL_SOURCE): { entries: PluginEntry[]; skipped: string[] } {
  const one = isObj(json) && typeof json.kind === "string" && !Array.isArray(json.plugins) ? [json] : json;
  const r = parseMarketplace(one, source);
  return { entries: r.entries, skipped: r.skipped };
}

/** owner/repo、github.com 链接、直接的 JSON 地址 → 可请求的地址 */
export function marketplaceUrl(input: string): string | null {
  const s = input.trim();
  if (!s) return null;
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://raw.githubusercontent.com/${s}/HEAD/marketplace.json`;
  const gh = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(s);
  if (gh) return `https://raw.githubusercontent.com/${gh[1]}/${gh[2]}/HEAD/marketplace.json`;
  return /^https?:\/\//.test(s) ? s : null;
}

// ───────────── DBX 插件中心 ─────────────

export const DBX_CATALOG_URL = "https://dl.dbxio.com/catalog/index.json";

/** 「常用仓库」：界面上一键添加（只是方便，和手动填地址添加出来的仓库完全一样） */
export const PRESET_REPOS: Array<{ name: string; url: string; desc: string }> = [
  { name: OFFICIAL_REPO_NAME, url: OFFICIAL_REPO_URL, desc: "M-Harness 官方插件仓库" },
  { name: DBX_SOURCE, url: DBX_CATALOG_URL, desc: "第三方：DBX 的 .dbxp 插件目录（不是 M-Harness 官方仓库）" },
  { name: "OpenAI Codex 插件", url: "https://github.com/openai/plugins", desc: "Codex 官方插件仓库：装进来的是里面的技能、MCP、命令（hooks、子 agent 不支持）" },
  { name: "DSH 插件市场", url: "https://dshbazaar.io/api/index.json", desc: "DeepSeek Harness 的插件索引（近千个）：只有 AI 工具和命令能用，运行前要你确认信任" },
];

/** 本机的 DBX 安装包目标：windows-x64、darwin-arm64 … */
export const dbxTarget = (platform: string, arch: string): string => `${platform === "win32" ? "windows" : platform}-${arch}`;

/** 只认 DBX 官方下载域名的 .dbxp，拼出让 DBX 弹出安装确认的链接 */
export function dbxInstallLink(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:" || u.hostname !== "dl.dbxio.com" || !/\.dbxp$/.test(u.pathname)) return null;
    return `dbx://plugins/install?url=${encodeURIComponent(u.toString())}`;
  } catch {
    return null;
  }
}

/** 解析 DBX 官方目录（catalog/index.json）成商店条目；没有当前系统安装包的也列出来，只是装不了 */
export function parseDbxCatalog(json: unknown, target: string, lang = "zh-CN", sourceName = DBX_SOURCE): PluginEntry[] {
  const list = isObj(json) && Array.isArray(json.plugins) ? json.plugins : null;
  if (!list) throw new Error("这个目录不是 DBX 格式：里面没有 plugins 列表。请确认地址指向 catalog/index.json 这个文件本身，而不是网页或仓库主页");
  const out: PluginEntry[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const id = str(raw.id);
    const nameRaw = str(raw.name);
    if (!id || !nameRaw || !/^[A-Za-z0-9._/-]+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const loc = isObj(raw.localizations) && isObj(raw.localizations[lang]) ? raw.localizations[lang] : {};
    const versions: any[] = Array.isArray(raw.versions) ? raw.versions.filter(isObj) : [];
    const latest = str(raw.latestVersion);
    const ver = versions.find(v => v.version === latest) ?? versions[0];
    const arts: any[] = Array.isArray(ver?.artifacts) ? ver.artifacts.filter(isObj) : [];
    // 先找当前系统的包，没有再用跨平台（universal）的包
    const art = arts.find(a => a.target === target) ?? arts.find(a => a.target === "universal");
    const released = str(ver?.releasedAt);
    const web = (v: unknown) => (str(v) && /^https?:\/\//.test(v as string) ? (v as string) : undefined);
    const source = web(raw.source);
    out.push({
      key: `${sourceName}:${id}`,
      id,
      name: str(loc.name) ?? nameRaw,
      kind: "dbx",
      author: str(raw.publisher),
      description: str(loc.description) ?? str(raw.description) ?? "",
      tags: Array.isArray(raw.tags) ? raw.tags.filter((t: unknown): t is string => typeof t === "string").slice(0, 8) : [],
      version: str(ver?.version) ?? latest,
      license: str(raw.license),
      updated: released && /^\d{4}-\d{2}-\d{2}/.test(released) ? released.slice(0, 10) : undefined,
      homepage: web(raw.homepage),
      repo: source?.replace(/\/tree\/.*$/, ""),
      source: sourceName,
      install: {
        kind: "dbx",
        dbxId: id,
        url: str(art?.url),
        sha256: str(art?.sha256),
        size: typeof art?.size === "number" ? art.size : undefined,
        permissions: Array.isArray(raw.permissions) ? raw.permissions.filter((p: unknown): p is string => typeof p === "string") : [],
      },
    });
  }
  // 有一堆条目却一个都认不出来：不是 DBX 格式
  if (list.length > 0 && out.length === 0) {
    const first = list.find(isObj) as Record<string, unknown> | undefined;
    if (first && !("id" in first) && "name" in first) throw new Error("这个目录不是 DBX 格式（条目没有 id），也不是能识别的 DSH 市场索引（条目的版本里需要有 source）。请确认地址指向插件目录文件本身");
    throw new Error("这个目录里没有能识别的插件，请确认是 DBX 格式的 catalog/index.json，或 DSH 的市场索引");
  }
  return out;
}

export const DSH_NOTE = "DSH 插件：本软件只运行它的 AI 工具和命令（装好后到「让 AI 使用插件」里开启）；它的网页界面、设置页、系统提示词这些 DSH 专有功能没有。会运行第三方代码，只装信任的作者。";

const localized = (v: unknown, lang: string): string | undefined => (isObj(v) ? (str(v[lang]) ?? str(v.zh) ?? str(v.en) ?? Object.values(v).map(str).find(Boolean)) : str(v));

/** 解析 DSH 的市场索引（format 1：name + versions[]，每个版本带 npm 或 git 来源）成商店条目；每个插件取最高的正式版 */
export function parseDshIndex(json: unknown, sourceName: string, lang = "zh"): PluginEntry[] {
  const list = isObj(json) && Array.isArray(json.plugins) ? json.plugins : null;
  if (!list) throw new Error("这个目录不是 DSH 市场索引：里面没有 plugins 列表");
  const out: PluginEntry[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const name = str(raw.name);
    if (!name || !/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/.test(name) || seen.has(name)) continue;
    const versions: any[] = Array.isArray(raw.versions) ? raw.versions.filter((v: any) => isObj(v) && str(v.version) && isObj(v.source) && (v.source.type === "npm" || (v.source.type === "git" && str(v.source.url) && /^[0-9a-f]{40}$/.test(String(v.source.commit))))) : [];
    if (!versions.length) continue;
    const stable = versions.filter(v => !parseVer(v.version)?.pre.length);
    const best = (stable.length ? stable : versions).sort((a, b) => cmpVerStr(a.version, b.version)).pop();
    const src = best.source;
    const source: DshSource = src.type === "npm" ? { type: "npm", ...(str(src.registry) && /^https:\/\//.test(src.registry) ? { registry: src.registry } : {}) } : { type: "git", url: src.url, commit: src.commit };
    seen.add(name);
    const meta = isObj(raw.metadata) ? raw.metadata : {};
    const ts = typeof best.publishTimestamp === "number" ? best.publishTimestamp : typeof meta.sortKeys?.updated === "number" ? meta.sortKeys.updated : undefined;
    const repoUrl = isObj(raw.repository) ? str(raw.repository.url) : str(raw.repository);
    const id = foreignId("dsh", name);
    // 索引里标 unconfirmed 的，只是 GitHub 上带 dsh-plugin 标签的仓库，没人确认过它真是 DSH 插件（不少是技能 / 文档仓库）
    const unconfirmed = Array.isArray(meta.labels) && meta.labels.includes("unconfirmed");
    const kw: string[] = Array.isArray(meta.keywords) ? meta.keywords.filter((t: unknown): t is string => typeof t === "string" && !/^(dsh|dsh-plugin|deepseek-harness)$/.test(t)) : [];
    out.push({
      key: `${sourceName}:${id}`,
      id,
      name: localized(raw.title, lang) && localized(raw.title, lang) !== name ? `${localized(raw.title, lang)}` : name,
      kind: "dsh",
      ecosystem: "dsh",
      author: str(raw.author) ?? (isObj(raw.author) ? str(raw.author.name) : undefined),
      description: localized(raw.description, lang) ?? "",
      tags: [...(unconfirmed ? ["未验证"] : []), ...(str(meta.category) ? [meta.category as string] : []), ...kw].slice(0, 8),
      version: best.version,
      license: str(raw.license),
      updated: ts ? new Date(ts * 1000).toISOString().slice(0, 10) : undefined,
      homepage: str(raw.homepage) && /^https?:\/\//.test(raw.homepage) ? raw.homepage : undefined,
      repo: repoUrl && /^https?:\/\//.test(repoUrl) ? repoUrl.replace(/\.git$/, "") : undefined,
      source: sourceName,
      note: unconfirmed ? `市场里标为「未验证」：只是 GitHub 上带 dsh-plugin 标签的仓库，不保证真是 DSH 插件（不少是技能或文档仓库，装不上）。${DSH_NOTE}` : DSH_NOTE,
      install: { kind: "dsh", pkg: name, version: best.version, source },
    });
  }
  return out;
}

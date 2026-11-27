import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { discoverForeign } from "./foreign";
import { netError } from "./neterr";
import { importGithubRepo, loadTree, makeCtx, NOT_PLUGIN, parseGithubUrl } from "./repo-import";
import { DBX_CATALOG_URL, DBX_SOURCE, dbxTarget, detectCatalogFormat, parseDbxCatalog, parseDshIndex, type DbxInfo, type LocalPluginInfo, type PluginEntry, type PluginRepo } from "../shared/plugins";
import { OFFICIAL_HOSTS, installDbxp, installDbxpBuffer, installDbxpFromUrl, readLocalInfo, uninstallDbxp, uninstallDbxpAsync } from "./dbxp";

const TTL = 10 * 60_000;
const MAX_BYTES = 5_000_000;
const DSH_INDEX_URL = "https://dshbazaar.io/api/index.json";
const FALLBACK_URL = "https://raw.githubusercontent.com/t8y2/dbx-store/main/catalog/index.json";

export interface DbxOpts {
  /** 单个仓库最多等多久再先显示别的（毫秒，默认 30 秒；测试用） */
  repoDeadlineMs?: number;
  /** DBX 的数据目录（里面有 plugins/）；默认按系统找 */
  dataDir?: string;
  /** 本软件自己的插件目录（插件直接装在这里，不需要 DBX） */
  localDir?: string;
  /** 目录地址；默认官方 */
  catalogUrl?: string;
  /** 已启用的仓库（每次现取，用户随时可能增删、停用） */
  repos?: () => PluginRepo[];
  /** 指定桥接用的 MCP 组件（测试用）；默认自动找 */
  mcp?: DbxInfo["mcp"];
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
}

/** DBX 在各系统上的数据目录 */
export function dbxDataDir(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string {
  if (platform === "win32") return path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "com.dbx.app");
  if (platform === "darwin") return path.join(home, "Library", "Application Support", "com.dbx.app");
  return path.join(env.XDG_DATA_HOME ?? path.join(home, ".local", "share"), "com.dbx.app");
}

const verKey = (v: string): number[] => v.split(/[.+-]/).map(x => Number.parseInt(x, 10) || 0);
const cmpVer = (a: string, b: string): number => {
  const x = verKey(a);
  const y = verKey(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
};

/** 读 DBX 已装的插件：plugins/<id>/versions/<版本>/manifest.json，取最高版本 */
export function scanDbxPlugins(dataDir: string, sub = "plugins"): Record<string, string> {
  const root = path.join(dataDir, sub);
  const out: Record<string, string> = {};
  let ids: string[] = [];
  try {
    ids = fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith(".")).map(d => d.name);
  } catch {
    return out;
  }
  for (const id of ids) {
    try {
      const vs = fs
        .readdirSync(path.join(root, id, "versions"), { withFileTypes: true })
        .filter(d => d.isDirectory() && fs.existsSync(path.join(root, id, "versions", d.name, "manifest.json")))
        .map(d => d.name)
        .sort(cmpVer);
      if (vs.length) out[id] = vs[vs.length - 1];
    } catch {
      // 不是完整的插件目录，忽略
    }
  }
  return out;
}

/** 找 DBX 自带的 MCP 组件（npm 全局装的 @dbx-app/mcp-server）；找不到返回 undefined */
export function findDbxMcp(platform: NodeJS.Platform = process.platform, arch: string = process.arch, env: NodeJS.ProcessEnv = process.env, home = os.homedir()): DbxInfo["mcp"] {
  const roots =
    platform === "win32"
      ? [path.join(env.APPDATA ?? path.join(home, "AppData", "Roaming"), "npm", "node_modules")]
      : [path.join(home, ".npm-global", "lib", "node_modules"), "/usr/local/lib/node_modules", "/opt/homebrew/lib/node_modules", "/usr/lib/node_modules"];
  const exe = platform === "win32" ? "dbx-mcp.exe" : "dbx-mcp";
  for (const r of roots) {
    const p = path.join(r, "@dbx-app", "mcp-server", "node_modules", "@dbx-app", `mcp-${platform}-${arch}`, "bin", exe);
    if (fs.existsSync(p)) return { command: p, args: [] };
  }
  return undefined;
}

/** DBX 插件中心：官方目录（带缓存） + 本机已装情况 */
export class DbxBridge {
  private cache: { at: number; entries: PluginEntry[] } | null = null;

  constructor(
    private fetchImpl: typeof fetch = fetch,
    private opts: DbxOpts = {},
  ) {}

  private get platform() {
    return this.opts.platform ?? process.platform;
  }
  private get arch() {
    return this.opts.arch ?? process.arch;
  }
  private get dataDir() {
    return this.opts.dataDir ?? dbxDataDir(this.platform, this.opts.env);
  }

  private get localDir() {
    return this.opts.localDir ?? path.join(os.homedir(), ".harness", "plugins");
  }

  /** 装在本软件里的插件 */
  localPlugins(): Record<string, LocalPluginInfo> {
    const out: Record<string, LocalPluginInfo> = {};
    for (const [id, v] of Object.entries(scanDbxPlugins(path.dirname(this.localDir), path.basename(this.localDir)))) out[id] = readLocalInfo(this.localDir, id, v);
    return out;
  }

  /** 下载、校验并安装目录里的某个插件到本软件的插件目录；返回装好的版本 */
  async install(id: string): Promise<string> {
    const e = (await this.catalogReport()).entries.find(x => x.id === id);
    if (!e || e.install.kind !== "dbx") throw new Error("插件目录里没有这个插件");
    if (!e.install.url || !e.version) throw new Error(`这个插件的作者没有发布当前系统的安装包`);
    const hosts = [...OFFICIAL_HOSTS];
    if (this.opts.catalogUrl) hosts.push(new URL(this.opts.catalogUrl).host); // 测试用：目录指到本地服务时，允许同一个本地服务下载
    if (e.source !== DBX_SOURCE) {
      try {
        hosts.push(new URL(e.install.url).host); // 第三方仓库：下载站由仓库自己指定（用户添加仓库就是信任它），sha256 照样要核对
      } catch {
        /* 地址不合法，下面会报错 */
      }
    }
    return installDbxp({ id: e.id, version: e.version, url: e.install.url, sha256: e.install.sha256 ?? "", size: e.install.size }, this.localDir, { hosts, fetchImpl: this.fetchImpl });
  }

  uninstall(id: string): boolean {
    return uninstallDbxp(id, this.localDir);
  }

  /** 界面用的卸载：异步删，目录被刚退出的后台进程占着时慢慢重试，不卡主进程 */
  uninstallAsync(id: string): Promise<boolean> {
    return uninstallDbxpAsync(id, this.localDir);
  }

  /** 本机的情况（每次现读，装完马上能看到） */
  info(): DbxInfo {
    return {
      appFound: fs.existsSync(this.dataDir),
      dir: this.localDir,
      plugins: scanDbxPlugins(this.dataDir),
      local: this.localPlugins(),
      mcp: this.opts.mcp ?? findDbxMcp(this.platform, this.arch, this.opts.env),
    };
  }

  private async fetchJson(url: string): Promise<unknown> {
    // DSH 的索引有 1MB 多，国内网络下可能要二三十秒
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(60_000), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("插件目录太大（超过 5MB）");
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("这个地址返回的不是 JSON 文件（像是一个网页）。请填目录文件（比如 catalog/index.json）本身的直链，不要填仓库或网站主页");
    }
  }

  private async download(url: string, source = DBX_SOURCE): Promise<PluginEntry[]> {
    return parseDbxCatalog(await this.fetchJson(url), dbxTarget(this.platform, this.arch), "zh-CN", source);
  }

  private extraCache = new Map<string, { at: number; entries: PluginEntry[]; skipped: string[] }>();
  /** 插件包（Codex / Claude）条目 id → 装的时候要写进配置的各项；读目录时顺手记下 */
  private bundleItems = new Map<string, () => Promise<{ items: PluginEntry[]; notes: string[] }>>();

  /** 插件包里的各项（技能 / MCP / 动作 / 规则）：现在才去下载它们的内容；目录里没有这个插件包时返回 undefined */
  loadItems(id: string): Promise<{ items: PluginEntry[]; notes: string[] }> | undefined {
    return this.bundleItems.get(id)?.();
  }

  /** 目录里的某个插件（已安装的插件包装之前需要它） */
  async findEntry(id: string): Promise<PluginEntry | undefined> {
    return (await this.catalogReport()).entries.find(x => x.id === id);
  }

  /** 一个 GitHub 仓库里的插件：DBX 目录优先，其次 Codex / Claude 的插件市场，最后是 DSH 的 npm 插件 */
  private async githubCatalog(r: PluginRepo, gh: NonNullable<ReturnType<typeof parseGithubUrl>>, target: string): Promise<{ entries: PluginEntry[]; skipped: string[] }> {
    // DSH 市场自己的网站源码仓库：插件不在里面，用户填它的 GitHub 链接时，直接读它对外发布的索引
    if (gh.owner.toLowerCase() === "dsh-market" && gh.repo.toLowerCase() === "dsh-market" && !gh.dir) return { entries: parseDshIndex(await this.fetchJson(DSH_INDEX_URL), r.name, "zh"), skipped: [] };
    const tree = await loadTree(this.fetchImpl, gh, true);
    let first: unknown;
    try {
      return await importGithubRepo(this.fetchImpl, gh, r.name, json => parseDbxCatalog(json, target, "zh-CN", r.name), { catalogOnly: true, tree });
    } catch (e) {
      first = e;
    }
    const found = await discoverForeign(this.fetchImpl, makeCtx(this.fetchImpl, gh, tree), r.name);
    if (!found) throw first;
    for (const [id, items] of found.items) this.bundleItems.set(id, items);
    return { entries: found.entries, skipped: found.skipped };
  }

  /** 一个仓库里的插件（带缓存，出错用旧缓存兜底）。认三类：DBX 插件目录、Codex / Claude 的插件市场、DSH 的插件索引；单独的技能 / MCP 不是插件，不收 */
  /** 测试一个仓库：现读一次，不用缓存也不写缓存，出错直接抛 */
  testRepo(r: PluginRepo): Promise<{ entries: PluginEntry[]; skipped: string[] }> {
    return this.repoCatalog(r, true, false);
  }

  private async repoCatalog(r: PluginRepo, refresh: boolean, useCache = true): Promise<{ entries: PluginEntry[]; skipped: string[] }> {
    const hit = useCache ? this.extraCache.get(r.url) : undefined;
    if (hit && !refresh && Date.now() - hit.at < TTL) return hit;
    try {
      const target = dbxTarget(this.platform, this.arch);
      let item: { entries: PluginEntry[]; skipped: string[] };
      const gh = parseGithubUrl(r.url);
      if (gh) {
        item = await this.githubCatalog(r, gh, target);
      } else {
        let json: unknown;
        try {
          json = await this.fetchJson(r.url);
        } catch (e) {
          if (r.url !== DBX_CATALOG_URL) throw e;
          json = await this.fetchJson(FALLBACK_URL); // DBX 的下载站连不上时，用 GitHub 上的同一份目录
        }
        const fmt = detectCatalogFormat(json);
        if (fmt === "native") throw new Error(NOT_PLUGIN);
        // DSH 市场索引；认不出来的格式，DBX 解析器会给出「不是 DBX 格式」之类的具体原因
        item = { entries: fmt === "dsh" ? parseDshIndex(json, r.name, "zh") : parseDbxCatalog(json, target, "zh-CN", r.name), skipped: [] };
      }
      const saved = { at: Date.now(), ...item };
      if (useCache) this.extraCache.set(r.url, saved);
      return saved;
    } catch (e) {
      if (hit) return hit;
      throw e;
    }
  }

  /** 所有已启用仓库的插件，按仓库在列表里的先后排；某个仓库失败不影响别的，错误单独带回 */
  async catalogReport(refresh = false): Promise<{ entries: PluginEntry[]; errors: Array<{ source: string; error: string }> }> {
    const errors: Array<{ source: string; error: string }> = [];
    const entries: PluginEntry[] = [];
    const seen = new Set<string>();
    const repos = this.opts.repos?.() ?? [];
    const got = await Promise.all(
      repos.map(async r => {
        try {
          // 某个仓库太慢（比如连不上的下载站要等 60 秒才超时）不能拖住整个商店：超过期限先显示别的，它继续在后台读、读完进缓存，再刷新就有了
          let timer: ReturnType<typeof setTimeout> | undefined;
          const slow = new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new Error(`读取太慢（超过 ${Math.round(this.opts.repoDeadlineMs ?? 30_000) / 1000} 秒），先显示其它仓库的插件；它还在后台继续读，过一会儿点刷新就有了`)), this.opts.repoDeadlineMs ?? 30_000)));
          const c = await Promise.race([this.repoCatalog(r, refresh), slow]).finally(() => clearTimeout(timer));
          if (c.skipped.length) errors.push({ source: r.name, error: `跳过 ${c.skipped.length} 个无效条目：${c.skipped.slice(0, 3).join("；")}` });
          return c.entries;
        } catch (e) {
          errors.push({ source: r.name, error: `获取仓库「${r.name}」的目录失败：${netError(e)}` });
          return [];
        }
      }),
    );
    for (const list of got)
      for (const e of list) {
        // 插件靠 id 安装，所以 id 不能重复（排在前面的仓库优先）
        if (seen.has(e.id)) continue;
        seen.add(e.id);
        entries.push(e);
      }
    return { entries, errors };
  }

  /** 从本地 .dbxp 文件内容安装（来源不在目录里，只能校验包内文件） */
  installPackage(buf: Buffer): { id: string; version: string; name?: string } {
    return installDbxpBuffer(buf, this.localDir, { requireChecksums: true });
  }

  /** 从链接安装 .dbxp */
  installUrl(url: string): Promise<{ id: string; version: string; name?: string }> {
    return installDbxpFromUrl(url, this.localDir, { fetchImpl: this.fetchImpl });
  }

  get pluginDir(): string {
    return this.localDir;
  }

  async catalog(refresh = false): Promise<PluginEntry[]> {
    if (this.cache && !refresh && Date.now() - this.cache.at < TTL) return this.cache.entries;
    const url = this.opts.catalogUrl ?? DBX_CATALOG_URL;
    try {
      let entries: PluginEntry[];
      try {
        entries = await this.download(url);
      } catch (e) {
        if (this.opts.catalogUrl) throw e;
        entries = await this.download(FALLBACK_URL); // 官方下载站连不上时，用 GitHub 上的同一份目录
      }
      this.cache = { at: Date.now(), entries };
      return entries;
    } catch (e) {
      if (this.cache) return this.cache.entries; // 网络失败用旧缓存兜底
      throw e;
    }
  }
}

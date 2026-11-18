import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DBX_CATALOG_URL, DBX_SOURCE, dbxTarget, parseDbxCatalog, type DbxInfo, type LocalPluginInfo, type PluginEntry, type PluginRepo } from "../shared/plugins";
import { OFFICIAL_HOSTS, installDbxp, installDbxpBuffer, installDbxpFromUrl, readLocalInfo, uninstallDbxp } from "./dbxp";

const TTL = 10 * 60_000;
const MAX_BYTES = 5_000_000;
const FALLBACK_URL = "https://raw.githubusercontent.com/t8y2/dbx-store/main/catalog/index.json";

export interface DbxOpts {
  /** DBX 的数据目录（里面有 plugins/）；默认按系统找 */
  dataDir?: string;
  /** 本软件自己的插件目录（插件直接装在这里，不需要 DBX） */
  localDir?: string;
  /** 目录地址；默认官方 */
  catalogUrl?: string;
  /** 已启用的第三方仓库（每次现取，用户随时可能增删） */
  extraRepos?: () => PluginRepo[];
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

  private async download(url: string, source = DBX_SOURCE): Promise<PluginEntry[]> {
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("DBX 插件目录太大（超过 5MB）");
    return parseDbxCatalog(JSON.parse(text), dbxTarget(this.platform, this.arch), "zh-CN", source);
  }

  private extraCache = new Map<string, { at: number; entries: PluginEntry[] }>();

  /** 第三方仓库的目录（带缓存，出错用旧缓存兜底） */
  private async repoCatalog(r: PluginRepo, refresh: boolean): Promise<PluginEntry[]> {
    const hit = this.extraCache.get(r.url);
    if (hit && !refresh && Date.now() - hit.at < TTL) return hit.entries;
    try {
      const entries = await this.download(r.url, r.name);
      this.extraCache.set(r.url, { at: Date.now(), entries });
      return entries;
    } catch (e) {
      if (hit) return hit.entries;
      throw e;
    }
  }

  /** 官方 + 已启用的第三方仓库；某个仓库失败不影响别的，错误单独带回。同一个 id 官方优先，第三方不能顶替官方插件 */
  async catalogReport(refresh = false): Promise<{ entries: PluginEntry[]; errors: Array<{ source: string; error: string }> }> {
    const errors: Array<{ source: string; error: string }> = [];
    let entries: PluginEntry[] = [];
    try {
      entries = await this.catalog(refresh);
    } catch (e) {
      errors.push({ source: DBX_SOURCE, error: `获取插件目录失败：${e instanceof Error ? e.message : String(e)}` });
    }
    const seen = new Set(entries.map(e => e.id));
    const repos = this.opts.extraRepos?.() ?? [];
    const got = await Promise.all(
      repos.map(async r => {
        try {
          return await this.repoCatalog(r, refresh);
        } catch (e) {
          errors.push({ source: r.name, error: `获取仓库「${r.name}」的目录失败：${e instanceof Error ? e.message : String(e)}` });
          return [];
        }
      }),
    );
    for (const list of got)
      for (const e of list) {
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

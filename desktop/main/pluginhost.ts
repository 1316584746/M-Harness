import fs from "node:fs";
import path from "node:path";
import { Sidecar } from "./sidecar";
import { scanDbxPlugins } from "./dbx";
import { PLUGIN_KIT_CSS, PLUGIN_SHIM } from "./pluginshim";
import type { PluginConn, PluginDbAccess, PluginReply, UiPlugin } from "../shared/pluginhost";
import { connSummary, type ConnKind, type Connection } from "../shared/connections";
import { CONN_ADAPTERS, type ConnAdapter } from "./plugin-conn";
import { hostDbType, type DbConnOption, type DbQueryRequest, type DbQueryResult, type TableMeta, type TableMetaRequest } from "../shared/db";

/**
 * 插件运行时：把已装的 DBX 插件跑起来。
 *  - 界面：用自定义协议 harness-plugin://<插件id>/ 提供 ui/ 目录里的文件（只读、不出 ui 目录），
 *    页面里注入 window.dbxPlugin，并加上严格的 CSP（只允许插件声明过的网络来源）。
 *  - 后台：首次调用时才启动插件自带的本机程序（stdio JSON-RPC），崩了下次调用自动重启。
 *  - 信任：带本机程序的插件第一次运行前必须由用户确认；换版本要重新确认（本软件不验签，不能替用户信任）。
 */

/** 握手时告诉插件的宿主版本。插件的 engines.dbx 只是下限，这里取目前验证过的协议版本 */
export const HOST_COMPAT_VERSION = "0.6.30";

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const MAX_ASSET = 2 * 1024 * 1024;
const STORE_VALUE_MAX = 256 * 1024;
const STORE_ALL_MAX = 1024 * 1024;
const ORIGIN_RE = /^https:\/\/[A-Za-z0-9*.-]+(:\d{1,5})?$/;

interface Manifest {
  id?: string;
  name?: string;
  version?: string;
  description?: string;
  icon?: string;
  permissions?: string[];
  entrypoints?: { backend?: { executable?: string }; ui?: { root?: string; entry?: string } };
  contributions?: { type?: string; icon?: string; label?: string; database_type?: string; workbench?: string }[];
  localizations?: Record<string, { name?: string; description?: string }>;
}

interface Resolved {
  id: string;
  version: string;
  dir: string;
  manifest: Manifest;
  uiRoot: string;
  entry: string;
}

/** 能给 AI 用的插件（不含工具列表，工具要启动后台程序才拿得到） */
export interface AiPluginRef {
  id: string;
  name: string;
  version: string;
  description?: string;
  trusted: boolean;
  connKind?: ConnKind;
  conns: PluginConn[];
  /** 不是 DBX 的插件：来自哪一家（目前只有 DSH 插件会给 AI 提供工具） */
  ecosystem?: import("../shared/plugins").Ecosystem;
}

export interface AiRawTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

export interface PluginHostOpts {
  /** 已装插件目录：<dir>/<id>/versions/<版本>/ */
  localDir: string;
  /** 插件自己的数据目录根：<dir>/<id>/ */
  dataRoot: string;
  /** 用户确认过的记录文件 */
  consentFile: string;
  onEvent?: (id: string, method: string, params: unknown) => void;
  /** 测试用：自定义怎么启动后台程序 */
  launch?: (exe: string) => { command: string; args?: string[]; env?: Record<string, string> };
  locale?: string;
  /** 本软件「设置 → 连接」里的连接：连接类插件（如 XXL-JOB）用它，不需要 DBX */
  connections?: {
    list: (kind: ConnKind) => Connection[];
    get: (id: string) => { conn: Connection; secrets: Record<string, string> } | undefined;
  };
  /** 只读数据库引擎：数据库类插件（SQL Notebook、Visual Query Builder 等）通过它查数据 */
  db?: {
    options(): DbConnOption[];
    query(req: DbQueryRequest, who: string): Promise<DbQueryResult>;
    tableMetadata(req: TableMetaRequest, who: string): Promise<TableMeta>;
  };
  /** 记录「哪个插件可以用哪些数据库连接」的文件 */
  grantsFile?: string;
}

const DATA_PERMS = ["host.data:read", "host.schema:read", "host.connections:read"];

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

const inside = (root: string, p: string) => {
  const r = path.resolve(root);
  const f = path.resolve(p);
  return f === r || f.startsWith(r + path.sep);
};

/** 安全地把 清单里的相对路径 解析到根目录里面；不合法返回 undefined */
function under(root: string, rel: string | undefined): string | undefined {
  if (!rel || path.isAbsolute(rel) || rel.includes("\0")) return undefined;
  const f = path.resolve(root, rel);
  if (!inside(root, f)) return undefined;
  try {
    const real = fs.realpathSync(f);
    if (!inside(fs.realpathSync(root), real)) return undefined; // 符号链接跑出去了
  } catch {
    /* 文件不存在，交给调用方处理 */
  }
  return f;
}

export class PluginHost {
  private sidecars = new Map<string, Sidecar>();
  private starting = new Map<string, Promise<Sidecar>>();
  private titles = new Map<string, string>();
  /** 已经交给后台程序的连接：同一个后台进程、同样的配置就不重复连 */
  private connected = new Map<string, { sc: Sidecar; sig: string }>();
  private connecting = new Map<string, Promise<void>>();

  constructor(private o: PluginHostOpts) {}

  private get locale() {
    return this.o.locale ?? "zh-CN";
  }

  // ───────── 清单 ─────────

  private resolve(idIn: string): Resolved | undefined {
    const ids = scanDbxPlugins(path.dirname(this.o.localDir), path.basename(this.o.localDir));
    const id = Object.keys(ids).find(k => k === idIn) ?? Object.keys(ids).find(k => k.toLowerCase() === idIn.toLowerCase());
    if (!id || !ID_RE.test(id)) return undefined;
    const version = ids[id];
    const dir = path.join(this.o.localDir, id, "versions", version);
    let manifest: Manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8"));
    } catch {
      return undefined;
    }
    if (manifest.id && manifest.id !== id) return undefined;
    const ui = manifest.entrypoints?.ui;
    const uiRoot = under(dir, ui?.root ?? "ui");
    const entryAbs = under(dir, ui?.entry ?? "ui/index.html");
    if (!ui || !uiRoot || !entryAbs || !inside(uiRoot, entryAbs)) return { id, version, dir, manifest, uiRoot: "", entry: "" };
    return { id, version, dir, manifest, uiRoot, entry: path.relative(uiRoot, entryAbs).split(path.sep).join("/") };
  }

  private nameOf(m: Manifest, id: string): { name: string; description?: string } {
    const l = m.localizations?.[this.locale] ?? m.localizations?.[this.locale.split("-")[0]];
    return { name: l?.name ?? m.name ?? id, description: l?.description ?? m.description };
  }

  private iconOf(r: Resolved): string | undefined {
    const rel = r.manifest.icon ?? r.manifest.contributions?.find(c => c.type === "workbench" && c.icon)?.icon;
    const f = under(r.dir, rel);
    if (!f) return undefined;
    try {
      const st = fs.statSync(f);
      if (!st.isFile() || st.size > 256 * 1024) return undefined;
      const mime = MIME[path.extname(f).toLowerCase()];
      if (!mime?.startsWith("image/")) return undefined;
      return `data:${mime};base64,${fs.readFileSync(f).toString("base64")}`;
    } catch {
      return undefined;
    }
  }

  /** 带界面的已装插件（右侧栏的内容） */
  list(): UiPlugin[] {
    const out: UiPlugin[] = [];
    const ids = scanDbxPlugins(path.dirname(this.o.localDir), path.basename(this.o.localDir));
    for (const id of Object.keys(ids)) {
      const r = this.resolve(id);
      if (!r?.entry) continue;
      const n = this.nameOf(r.manifest, id);
      const backend = !!r.manifest.entrypoints?.backend?.executable;
      out.push({
        id,
        name: n.name,
        version: r.version,
        description: n.description,
        icon: this.iconOf(r),
        backend,
        permissions: Array.isArray(r.manifest.permissions) ? r.manifest.permissions.map(String) : [],
        // 带本机程序，或者要读数据库的插件，第一次运行前都要用户确认
        trusted: (!backend && !this.wantsData(r)) || this.trustedVersion(id) === r.version,
        connKind: this.provider(r)?.adapter.kind ?? (this.wantsData(r) ? "database" : undefined),
        dataAccess: this.wantsData(r) || undefined,
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  // ───────── 信任 ─────────

  private consent(): Record<string, { version: string; at: number }> {
    try {
      const j = JSON.parse(fs.readFileSync(this.o.consentFile, "utf8"));
      return j && typeof j === "object" ? j : {};
    } catch {
      return {};
    }
  }

  private trustedVersion(id: string): string | undefined {
    return this.consent()[id]?.version;
  }

  trust(id: string, grants?: string[]): boolean {
    const r = this.resolve(id);
    if (!r) return false;
    if (grants && this.wantsData(r)) this.setGrants(r.id, grants);
    const c = this.consent();
    c[r.id] = { version: r.version, at: Date.now() };
    fs.mkdirSync(path.dirname(this.o.consentFile), { recursive: true });
    fs.writeFileSync(this.o.consentFile, JSON.stringify(c, null, 2));
    return true;
  }

  // ───────── 界面文件（自定义协议） ─────────

  private csp(r: Resolved): string {
    const origins = (r.manifest.permissions ?? []).filter(p => typeof p === "string" && p.startsWith("host.network:")).map(p => p.slice("host.network:".length)).filter(o => ORIGIN_RE.test(o)).slice(0, 8);
    const net = origins.join(" ");
    return [
      "default-src 'none'",
      "script-src 'self' 'unsafe-inline'",
      "style-src 'self' 'unsafe-inline'",
      `img-src 'self' data: blob: ${net}`,
      `font-src 'self' data: ${net}`,
      "media-src 'self' data: blob:",
      `connect-src 'self' ${net}`,
      "frame-src 'none'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ].join("; ");
  }

  /** 给自定义协议用：返回插件 ui/ 目录里的文件 */
  serve(rawUrl: string): Response {
    const text = (status: number, msg: string) => new Response(msg, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
    let u: URL;
    try {
      u = new URL(rawUrl);
    } catch {
      return text(400, "bad url");
    }
    const r = this.resolve(u.hostname);
    if (!r?.entry) return text(404, "plugin not found");
    let rel: string;
    try {
      rel = decodeURIComponent(u.pathname).replace(/^\/+/, "");
    } catch {
      return text(400, "bad path");
    }
    if (!rel) rel = r.entry;
    const f = under(r.uiRoot, rel);
    if (!f) return text(403, "forbidden");
    let data: Buffer;
    try {
      if (!fs.statSync(f).isFile()) return text(404, "not found");
      data = fs.readFileSync(f);
    } catch {
      return text(404, "not found");
    }
    const ext = path.extname(f).toLowerCase();
    const headers: Record<string, string> = {
      "content-type": MIME[ext] ?? "application/octet-stream",
      "cache-control": "no-store",
      "access-control-allow-origin": "*",
      "x-content-type-options": "nosniff",
      "content-security-policy": this.csp(r),
    };
    if (ext === ".html" || ext === ".htm") {
      let html = data.toString("utf8");
      const tag = `<style>${PLUGIN_KIT_CSS}</style><script>${PLUGIN_SHIM}</script>`;
      const m = /<head[^>]*>/i.exec(html);
      html = m ? html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length) : tag + html;
      return new Response(html, { status: 200, headers });
    }
    return new Response(new Uint8Array(data), { status: 200, headers });
  }

  // ───────── 后台程序 ─────────

  private dataDir(id: string): string {
    const d = path.join(this.o.dataRoot, id);
    fs.mkdirSync(d, { recursive: true });
    return d;
  }

  private async sidecar(id: string): Promise<Sidecar> {
    const live = this.sidecars.get(id);
    if (live?.alive) return live;
    const going = this.starting.get(id);
    if (going) return going;
    const p = this.startSidecar(id).finally(() => this.starting.delete(id));
    this.starting.set(id, p);
    return p;
  }

  private async startSidecar(id: string): Promise<Sidecar> {
    const r = this.resolve(id);
    if (!r) throw new Error("这个插件已经不在了");
    const rel = r.manifest.entrypoints?.backend?.executable;
    if (!rel) throw new Error("这个插件没有后台程序");
    if (this.trustedVersion(r.id) !== r.version) throw new Error("还没有确认信任这个插件");
    const exe = under(r.dir, rel);
    if (!exe || !fs.existsSync(exe)) throw new Error("找不到插件的后台程序文件，可以试试重新安装");
    if (process.platform !== "win32") {
      try {
        fs.chmodSync(exe, 0o755);
      } catch {
        /* 只读目录，尽量跑 */
      }
    }
    // 后台程序是 .js / .mjs / .cjs 脚本（跨平台的 Node 插件）：用本软件自带的 Node 运行，一个包三个系统通用；其余按原生程序直接启动
    const asScript = /\.(?:c|m)?js$/i.test(exe) ? { command: process.execPath, args: [exe], env: { ELECTRON_RUN_AS_NODE: "1" } } : undefined;
    const l = this.o.launch?.(exe) ?? asScript ?? { command: exe };
    const sc = new Sidecar({
      command: l.command,
      args: l.args,
      cwd: r.dir,
      env: { ...l.env, DBX_PLUGIN_DATA_DIR: this.dataDir(r.id), DBX_PLUGIN_ID: r.id },
      pluginId: r.id,
      version: r.version,
      permissions: Array.isArray(r.manifest.permissions) ? r.manifest.permissions.map(String) : [],
      hostVersion: HOST_COMPAT_VERSION,
      onEvent: (m, params) => {
        if (r.manifest.permissions?.includes("host.events")) this.o.onEvent?.(r.id, m, params);
      },
      onExit: () => {
        if (this.sidecars.get(r.id) === sc) this.sidecars.delete(r.id);
      },
    });
    await sc.start();
    this.sidecars.set(r.id, sc);
    return sc;
  }

  /** 停掉某个插件的后台程序（更新 / 卸载前必须停，否则 Windows 上文件被占用） */
  async stop(id: string): Promise<void> {
    const sc = this.sidecars.get(id) ?? [...this.sidecars].find(([k]) => k.toLowerCase() === id.toLowerCase())?.[1];
    for (const [k, v] of this.sidecars) if (v === sc) this.sidecars.delete(k);
    await sc?.stop();
  }

  async stopAll(): Promise<void> {
    const all = [...this.sidecars.values()];
    this.sidecars.clear();
    await Promise.all(all.map(sc => sc.stop()));
  }

  // ───────── 界面发来的请求 ─────────

  async request(idIn: string, method: string, params: unknown): Promise<PluginReply> {
    try {
      return { ok: true, result: await this.dispatch(idIn, method, params) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private async dispatch(idIn: string, method: string, params: unknown): Promise<unknown> {
    const r = this.resolve(idIn);
    if (!r?.entry) throw new Error("这个插件已经不在了");
    const p = (params && typeof params === "object" ? params : {}) as Record<string, unknown>;
    const perms = Array.isArray(r.manifest.permissions) ? r.manifest.permissions : [];
    switch (method) {
      case "backend.invoke": {
        const m = String(p.method ?? "");
        if (!m || m.length > 200 || /^(plugin|host)\//.test(m)) throw new Error("不允许的方法名");
        const timeout = typeof p.timeoutMs === "number" ? p.timeoutMs : undefined;
        const cid = this.provider(r) && p.params && typeof p.params === "object" ? (p.params as Record<string, unknown>).connectionId : undefined;
        if (typeof cid !== "string" || !cid) return (await this.sidecar(r.id)).call(m, p.params ?? {}, timeout);
        await this.connect(r.id, cid);
        try {
          return await (await this.sidecar(r.id)).call(m, p.params ?? {}, timeout);
        } catch (e) {
          // 后台说连接断了（对方重启、会话过期）：重新连一次再试
          if (!/尚未建立|已经断开/.test(e instanceof Error ? e.message : "")) throw e;
          this.connected.delete(`${r.id}\n${cid}`);
          await this.connect(r.id, cid);
          return (await this.sidecar(r.id)).call(m, p.params ?? {}, timeout);
        }
      }
      case "backend.notify": {
        const m = String(p.method ?? "");
        if (!m || m.length > 200 || /^(plugin|host)\//.test(m)) throw new Error("不允许的方法名");
        (await this.sidecar(r.id)).notify(m, p.params ?? {});
        return null;
      }
      case "host.getContext":
        return this.context(r);
      case "host.getCapabilities":
        return this.capabilities(r.id);
      case "host.getConnections": {
        this.needData(r, "host.connections:read");
        return this.grantedDb(r.id).map(c => ({ id: c.id, name: c.name, dbType: hostDbType(c.dbType ?? ""), dialect: hostDbType(c.dbType ?? ""), connected: true, readOnly: true, ...(c.database ? { database: c.database } : {}) }));
      }
      case "host.queryData": {
        this.needData(r, "host.data:read");
        const req = this.dbRequest(r, p);
        return this.o.db!.query({ ...req, sql: String(p.sql ?? ""), maxRows: typeof p.maxRows === "number" ? p.maxRows : undefined, timeoutMs: typeof p.timeoutMs === "number" ? p.timeoutMs : undefined }, r.id);
      }
      case "host.getTableMetadata": {
        this.needData(r, "host.schema:read");
        const req = this.dbRequest(r, p);
        return this.o.db!.tableMetadata({ ...req, table: String(p.table ?? "") }, r.id);
      }
      case "host.setTitle":
        if (p.title == null) this.titles.delete(r.id);
        else this.titles.set(r.id, String(p.title).slice(0, 200));
        return null;
      case "host.getTitle":
        return this.titles.get(r.id) ?? null;
      case "host.readAsset":
        return this.readAsset(r, String(p.path ?? ""), p.url === true);
      case "host.storage.get":
      case "host.storage.set":
      case "host.storage.delete": {
        if (!perms.includes("host.storage")) throw new Error("这个插件没有声明 host.storage 权限");
        return this.storage(r.id, method.slice("host.storage.".length), String(p.key ?? ""), p.value);
      }
      default:
        throw new Error(`本软件暂不支持 ${method}`);
    }
  }

  /** 界面启动时拿到的上下文（和 DBX 的 context 同形：workbenchId 等） */
  context(idIn: string | Resolved): Record<string, unknown> {
    const r = typeof idIn === "string" ? this.resolve(idIn) : idIn;
    if (!r) return {};
    const wb = this.provider(r)?.workbench;
    return { pluginId: r.id, pluginVersion: r.version, workbenchId: wb ?? `${r.id}.main`, contributionId: wb ?? `${r.id}.workbench`, newQuery: false };
  }

  // ───────── 连接 ─────────

  /** 这个插件是不是连接类（清单里有 connection-provider，且本软件有对应的适配器） */
  private provider(r: Resolved): { adapter: ConnAdapter; workbench?: string } | undefined {
    const c = r.manifest.contributions?.find(x => x.type === "connection-provider" && x.database_type && Object.prototype.hasOwnProperty.call(CONN_ADAPTERS, x.database_type));
    return c ? { adapter: CONN_ADAPTERS[c.database_type as string], workbench: c.workbench } : undefined;
  }

  /** 可供这个插件选的连接（已启用的、对应类型的，不含秘密） */
  connectionsFor(idIn: string): PluginConn[] {
    const r = this.resolve(idIn);
    if (r && !this.provider(r) && this.wantsData(r)) return this.grantedDb(r.id);
    const pv = r && this.provider(r);
    if (!pv || !this.o.connections) return [];
    return this.o.connections
      .list(pv.adapter.kind)
      .filter(c => c.enabled)
      .map(c => ({ id: c.id, name: c.name, env: c.env, machine: c.machine, summary: connSummary(c) }));
  }

  /** 把一个连接交给插件的后台程序（connection/connect）。已经连过且配置没变就直接返回 */
  connect(idIn: string, connId: string): Promise<void> {
    const r = this.resolve(idIn);
    const pv = r && this.provider(r);
    if (!r || !pv) return Promise.reject(new Error("这个插件不使用连接"));
    const key = `${r.id}\n${connId}`;
    const going = this.connecting.get(key);
    if (going) return going;
    const job = (async () => {
      const got = this.o.connections?.get(connId);
      if (!got || got.conn.kind !== pv.adapter.kind || !got.conn.enabled) throw new Error("这个连接不存在或已停用，请到「设置 → 连接」里检查");
      let connection: Record<string, unknown>;
      try {
        connection = pv.adapter.toConnection(got.conn, got.secrets);
      } catch {
        throw new Error("连接配置不完整或地址不合法，请到「设置 → 连接」里检查");
      }
      const sig = JSON.stringify(connection);
      const sc = await this.sidecar(r.id);
      const cur = this.connected.get(key);
      if (cur && cur.sc === sc && cur.sig === sig && sc.alive) return;
      await sc.call("connection/connect", { connection }, 30_000);
      this.connected.set(key, { sc, sig });
    })().finally(() => this.connecting.delete(key));
    this.connecting.set(key, job);
    return job;
  }

  /** 连接被改了或删了：让后台程序断开旧会话（下次用时按新配置重连） */
  forgetConnection(connId: string): void {
    for (const [key, v] of [...this.connected]) {
      if (key.split("\n")[1] !== connId) continue;
      this.connected.delete(key);
      v.sc.call("connection/disconnect", { connectionId: connId, id: connId }, 5000).catch(() => {});
    }
  }

  capabilities(id: string): Record<string, boolean> {
    const perms = this.resolve(id)?.manifest.permissions ?? [];
    const db = !!this.o.db;
    return {
      downloadFile: false,
      planApi: false,
      schemaMetadataApi: db && perms.includes("host.schema:read"),
      dataApi: db && perms.includes("host.data:read"),
      connectionsApi: db && perms.includes("host.connections:read"),
      storage: perms.includes("host.storage"),
      workbenchTitle: true,
      ai: false,
      aiModelDiscovery: false,
      aiCompletion: false,
      aiRecommendations: false,
    };
  }

  // ───────── 给 AI 用的工具（清单里的 mcp 贡献，走后台程序的 mcp/tools、mcp/call） ─────────

  /** 能给 AI 用的插件：清单里声明了 mcp 贡献，并且带后台程序 */
  aiPlugins(): AiPluginRef[] {
    const out: AiPluginRef[] = [];
    const ids = scanDbxPlugins(path.dirname(this.o.localDir), path.basename(this.o.localDir));
    for (const id of Object.keys(ids)) {
      const r = this.resolve(id);
      if (!r || !r.manifest.entrypoints?.backend?.executable) continue;
      if (!r.manifest.contributions?.some(c => c.type === "mcp")) continue;
      const pv = this.provider(r);
      out.push({
        id: r.id,
        name: this.nameOf(r.manifest, r.id).name,
        version: r.version,
        description: this.nameOf(r.manifest, r.id).description,
        trusted: this.trustedVersion(r.id) === r.version,
        connKind: pv?.adapter.kind,
        conns: pv ? this.connectionsFor(r.id) : [],
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  /** 向插件的后台程序要它的 AI 工具列表（会启动后台程序，所以要先确认信任） */
  async aiTools(id: string): Promise<AiRawTool[]> {
    const r = this.resolve(id);
    if (!r) throw new Error("这个插件已经不在了");
    const res = (await (await this.sidecar(r.id)).call("mcp/tools", {}, 20_000)) as { tools?: unknown } | null;
    const out: AiRawTool[] = [];
    for (const t of Array.isArray(res?.tools) ? res.tools : []) {
      const x = t as { name?: unknown; description?: unknown; inputSchema?: unknown; annotations?: { readOnlyHint?: unknown } };
      if (typeof x?.name !== "string" || !x.name) continue;
      const schema = x.inputSchema && typeof x.inputSchema === "object" ? { ...(x.inputSchema as Record<string, unknown>) } : {};
      delete schema.$schema;
      schema.type = "object";
      if (!schema.properties || typeof schema.properties !== "object") schema.properties = {};
      out.push({ name: x.name, description: typeof x.description === "string" ? x.description : "", inputSchema: schema, readOnly: x.annotations?.readOnlyHint === true });
    }
    return out;
  }

  /**
   * 让 AI 调用插件的一个工具。连接类插件要带上一个连接（设置 → 连接里的）：
   * 没指定时只有一个就用它，多个就让 AI 说清楚。连接配置只在主进程里交给插件，不进对话。
   */
  async aiCall(id: string, tool: string, args: Record<string, unknown>, connRef?: string, timeoutMs = 120_000): Promise<unknown> {
    const r = this.resolve(id);
    if (!r) throw new Error("这个插件已经不在了");
    const pv = this.provider(r);
    const params: Record<string, unknown> = { tool, arguments: args };
    if (pv) {
      const list = this.connectionsFor(r.id);
      if (!list.length) throw new Error("还没有可用的连接，请先到「设置 → 连接」里添加并启用");
      const ref = (connRef ?? "").trim();
      const hit = ref ? (list.find(c => c.id === ref) ?? list.find(c => c.name === ref) ?? list.find(c => c.name.toLowerCase() === ref.toLowerCase())) : list.length === 1 ? list[0] : undefined;
      if (!hit) throw new Error(ref ? `没有叫「${ref}」的连接，可用的有：${list.map(c => c.name).join("、")}` : `有多个连接，请用 connection 参数指定其中一个：${list.map(c => c.name).join("、")}`);
      const got = this.o.connections?.get(hit.id);
      if (!got || got.conn.kind !== pv.adapter.kind || !got.conn.enabled) throw new Error("这个连接不存在或已停用，请到「设置 → 连接」里检查");
      let connection: Record<string, unknown>;
      try {
        connection = pv.adapter.toConnection(got.conn, got.secrets);
      } catch {
        throw new Error("连接配置不完整或地址不合法，请到「设置 → 连接」里检查");
      }
      params.lifecycle = { connection };
    }
    return (await this.sidecar(r.id)).call("mcp/call", params, timeoutMs);
  }

  // ───────── 数据库访问（只读） ─────────

  private wantsData(r: Resolved): boolean {
    return !!this.o.db && (r.manifest.permissions ?? []).some(p => DATA_PERMS.includes(p));
  }

  private needData(r: Resolved, perm: string): void {
    if (!this.o.db) throw new Error("本软件没有开启数据库功能");
    if (!(r.manifest.permissions ?? []).includes(perm)) throw new Error(`这个插件没有声明 ${perm} 权限`);
    if (this.trustedVersion(r.id) !== r.version) throw new Error("还没有确认信任这个插件");
  }

  private grantsAll(): Record<string, string[]> {
    if (!this.o.grantsFile) return {};
    try {
      const j = JSON.parse(fs.readFileSync(this.o.grantsFile, "utf8"));
      return j && typeof j === "object" ? j : {};
    } catch {
      return {};
    }
  }

  /** 这个插件被允许用的连接 id */
  grants(id: string): string[] {
    const g = this.grantsAll()[this.resolve(id)?.id ?? id];
    return Array.isArray(g) ? g.filter(x => typeof x === "string") : [];
  }

  setGrants(idIn: string, ids: string[]): void {
    const r = this.resolve(idIn);
    if (!r || !this.o.grantsFile) return;
    const all = this.grantsAll();
    all[r.id] = [...new Set(ids.filter(x => typeof x === "string"))].slice(0, 200);
    fs.mkdirSync(path.dirname(this.o.grantsFile), { recursive: true });
    fs.writeFileSync(this.o.grantsFile, JSON.stringify(all, null, 2));
  }

  /** 授权界面用：所有数据库连接，和已授权的 */
  dbAccess(id: string): PluginDbAccess {
    return { options: this.o.db?.options() ?? [], granted: this.grants(id) };
  }

  /** 已授权、已启用、本软件能查的数据库连接（给插件和连接栏用） */
  private grantedDb(id: string): PluginConn[] {
    const ok = new Set(this.grants(id));
    return (this.o.db?.options() ?? [])
      .filter(o => ok.has(o.id) && o.supported)
      .flatMap(o => {
        const got = this.o.connections?.get(o.id);
        if (!got || !got.conn.enabled) return [];
        return [{ id: o.id, name: o.name, env: o.env, machine: o.machine, summary: connSummary(got.conn), dbType: hostDbType(o.dbType), database: got.conn.fields.database || undefined }];
      });
  }

  private dbRequest(r: Resolved, p: Record<string, unknown>): { connectionId: string; database?: string; schema?: string } {
    const connectionId = typeof p.connectionId === "string" ? p.connectionId : "";
    if (!connectionId) throw new Error("缺少 connectionId");
    if (!this.grants(r.id).includes(connectionId)) throw new Error("你还没有允许这个插件使用这个数据库连接（在插件顶部「数据库访问」里勾选）");
    return { connectionId, database: typeof p.database === "string" && p.database ? p.database : undefined, schema: typeof p.schema === "string" && p.schema ? p.schema : undefined };
  }

  private readAsset(r: Resolved, rel: string, asUrl: boolean): string {
    const f = under(r.dir, rel);
    const top = rel.replace(/\\/g, "/").split("/")[0];
    if (!f || (top !== "assets" && top !== "ui")) throw new Error("只能读插件自己的 assets 或 ui 目录");
    const st = fs.statSync(f);
    if (!st.isFile() || st.size > MAX_ASSET) throw new Error("文件不存在或太大");
    const buf = fs.readFileSync(f);
    if (!asUrl) return buf.toString("utf8");
    return `data:${MIME[path.extname(f).toLowerCase()] ?? "application/octet-stream"};base64,${buf.toString("base64")}`;
  }

  private storage(id: string, op: string, key: string, value: unknown): unknown {
    if (!key || key.length > 200 || key === "__proto__") throw new Error("键名不合法");
    const file = path.join(this.dataDir(id), ".host-storage.json");
    let data: Record<string, unknown> = {};
    try {
      data = JSON.parse(fs.readFileSync(file, "utf8")) ?? {};
    } catch {
      /* 还没有 */
    }
    if (op === "get") return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    if (op === "delete") delete data[key];
    else {
      const s = JSON.stringify(value ?? null);
      if (s.length > STORE_VALUE_MAX) throw new Error("单个值不能超过 256 KB");
      data[key] = value ?? null;
    }
    const all = JSON.stringify(data);
    if (all.length > STORE_ALL_MAX) throw new Error("存储总量不能超过 1 MB，大数据请放在后台程序自己的数据目录");
    fs.writeFileSync(file, all);
    return null;
  }
}

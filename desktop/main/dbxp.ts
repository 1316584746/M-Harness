import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

/**
 * .dbxp 插件包的安装：下载 → 核对 sha256（来自官方目录）→ 安全解压 → 核对包内 checksums.json → 放进 plugins/<id>/versions/<版本>/。
 * 目录布局和 DBX 自己的一致，所以同一套扫描逻辑（scanDbxPlugins）两边都能用。
 */

export const MAX_PACKAGE = 200 * 1024 * 1024;
const MAX_ENTRIES = 5000;
const MAX_UNPACKED = 600 * 1024 * 1024;

export interface ZipFile {
  name: string;
  data: Buffer;
}

/** 读 zip（只认常见的 stored / deflate，不支持 zip64 和加密）；路径不安全就直接报错 */
export function readZip(buf: Buffer): ZipFile[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的插件包（不是 zip）");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || p === 0xffffffff) throw new Error("插件包太大（zip64），暂不支持");
  if (count > MAX_ENTRIES) throw new Error("插件包里的文件太多");
  const out: ZipFile[] = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new Error("插件包损坏（目录不完整）");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen).replace(/\\/g, "/");
    p += 46 + nlen + elen + clen;
    if (name.endsWith("/")) continue; // 目录
    if (flags & 1) throw new Error("插件包是加密的，不支持");
    if (name.startsWith("/") || /^[A-Za-z]:/.test(name) || name.split("/").some(s => s === ".." || s === "")) throw new Error(`插件包里有不安全的路径：${name}`);
    total += usize;
    if (total > MAX_UNPACKED) throw new Error("插件包解压后太大");
    if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new Error("插件包损坏（文件头不对）");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    if (raw.length !== csize) throw new Error("插件包损坏（数据被截断）");
    const data = method === 0 ? Buffer.from(raw) : method === 8 ? zlib.inflateRawSync(raw, { maxOutputLength: usize + 1 }) : null;
    if (!data) throw new Error(`插件包用了不支持的压缩方式（${method}）`);
    if (data.length !== usize) throw new Error(`插件包损坏（${name} 大小对不上）`);
    out.push({ name, data });
  }
  return out;
}

const sha256 = (b: Buffer | string): string => crypto.createHash("sha256").update(b).digest("hex");
const safeId = (id: string): boolean => /^[A-Za-z0-9._-]+$/.test(id) && !id.startsWith(".") && !id.includes("..");
const hostOk = (u: URL, allow: string[]): boolean => u.protocol === "https:" || (u.protocol === "http:" && allow.includes(u.host) && /^(127\.0\.0\.1|localhost)(:|$)/.test(u.host));

export interface InstallSpec {
  id: string;
  version: string;
  url: string;
  sha256: string;
  size?: number;
}

export interface InstallOpts {
  /** 允许下载的主机（官方下载站；测试时再加本地服务） */
  hosts?: string[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export const OFFICIAL_HOSTS = ["dl.dbxio.com"];

/** 下载并安装一个插件包到 root/<id>/versions/<version>/，返回装好的版本号 */
export async function installDbxp(spec: InstallSpec, root: string, opts: InstallOpts = {}): Promise<string> {
  if (!safeId(spec.id)) throw new Error(`插件 id 不合法：${spec.id}`);
  if (!/^[A-Za-z0-9._+-]+$/.test(spec.version)) throw new Error(`插件版本号不合法：${spec.version}`);
  if (!/^[0-9a-f]{64}$/i.test(spec.sha256)) throw new Error("官方目录里没有这个插件的校验值，为了安全不安装");
  const allow = opts.hosts ?? OFFICIAL_HOSTS;
  let u: URL;
  try {
    u = new URL(spec.url);
  } catch {
    throw new Error("下载地址不合法");
  }
  if (!hostOk(u, allow) || !allow.includes(u.host) || !/\.dbxp$/.test(u.pathname)) throw new Error("下载地址不在官方插件下载站，已拒绝");

  const res = await (opts.fetchImpl ?? fetch)(u, { signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000) });
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
  const declared = Number(res.headers.get("content-length") ?? 0);
  if (declared > MAX_PACKAGE) throw new Error("插件包太大，已拒绝");
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_PACKAGE) throw new Error("插件包太大，已拒绝");
  if (spec.size && buf.length !== spec.size) throw new Error(`下载的插件包大小不对（应为 ${spec.size}，实际 ${buf.length}）`);
  if (sha256(buf) !== spec.sha256.toLowerCase()) throw new Error("插件包校验失败（sha256 和官方目录不一致），已丢弃");

  return installDbxpBuffer(buf, root, { expect: { id: spec.id, version: spec.version } }).version;
}

export interface BufferInstallOpts {
  /** 期望的插件 id / 版本（来自目录）；没有就以包里的清单为准 */
  expect?: { id?: string; version?: string };
  /** 没有来自目录的 sha256 时（本地文件 / 链接），必须有包内校验文件，否则拒绝 */
  requireChecksums?: boolean;
}

/** 校验并安装一个 .dbxp 包（已经在内存里）：解压、核对清单和包内校验值、放进 root/<id>/versions/<版本>/ */
export function installDbxpBuffer(buf: Buffer, root: string, opts: BufferInstallOpts = {}): { id: string; version: string; name?: string } {
  if (buf.length > MAX_PACKAGE) throw new Error("插件包太大，已拒绝");
  const spec = { id: opts.expect?.id ?? "", version: opts.expect?.version ?? "" };
  const files = readZip(buf);
  const by = new Map(files.map(f => [f.name, f.data]));
  const manifestRaw = by.get("manifest.json");
  if (!manifestRaw) throw new Error("插件包里没有 manifest.json");
  let manifest: any;
  try {
    manifest = JSON.parse(manifestRaw.toString("utf8").replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("插件的 manifest.json 解析失败");
  }
  if (spec.id && manifest?.id !== spec.id) throw new Error(`插件包的 id（${manifest?.id}）和目录里的（${spec.id}）不一致`);
  if (spec.version && manifest?.version !== spec.version) throw new Error(`插件包的版本（${manifest?.version}）和目录里的（${spec.version}）不一致`);
  spec.id = String(manifest?.id ?? "");
  spec.version = String(manifest?.version ?? "");
  if (!safeId(spec.id)) throw new Error(`插件 id 不合法：${spec.id}`);
  if (!/^[A-Za-z0-9._+-]+$/.test(spec.version)) throw new Error(`插件版本号不合法：${spec.version}`);

  const sums = by.get("checksums.json");
  if (!sums && opts.requireChecksums) throw new Error("插件包里没有 checksums.json，没法校验完整性，已拒绝安装");
  if (sums) {
    let list: Record<string, string> = {};
    try {
      list = JSON.parse(sums.toString("utf8")).files ?? {};
    } catch {
      throw new Error("插件的 checksums.json 解析失败");
    }
    for (const [name, want] of Object.entries(list)) {
      const data = by.get(name);
      if (!data) throw new Error(`插件包缺少文件：${name}`);
      if (sha256(data) !== String(want).toLowerCase()) throw new Error(`插件文件校验失败：${name}`);
    }
  }

  const pluginDir = path.join(root, spec.id);
  const vdir = path.join(pluginDir, "versions");
  const tmp = path.join(pluginDir, `.tmp-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(vdir, { recursive: true });
  try {
    for (const f of files) {
      const dest = path.join(tmp, ...f.name.split("/"));
      if (path.relative(tmp, dest).startsWith("..")) throw new Error(`插件包里有不安全的路径：${f.name}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, f.data, { mode: /^bin\//.test(f.name) ? 0o755 : 0o644 });
    }
    const final = path.join(vdir, spec.version);
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(tmp, final);
    // 只保留最新版本
    for (const d of fs.readdirSync(vdir)) if (d !== spec.version) fs.rmSync(path.join(vdir, d), { recursive: true, force: true });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  return { id: spec.id, version: spec.version, name: typeof manifest?.name === "string" ? manifest.name : undefined };
}

/** 从链接下载一个 .dbxp 并安装（没有官方目录的 sha256，只能校验包内文件，所以只在用户明确给出链接时用） */
export async function installDbxpFromUrl(rawUrl: string, root: string, opts: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): Promise<{ id: string; version: string; name?: string }> {
  let u: URL;
  try {
    u = new URL(rawUrl.trim());
  } catch {
    throw new Error("链接不合法");
  }
  const local = u.protocol === "http:" && /^(127\.0\.0\.1|localhost)$/.test(u.hostname);
  if (u.protocol !== "https:" && !local) throw new Error("只支持 https 链接");
  if (!/\.dbxp$/i.test(u.pathname)) throw new Error("链接要以 .dbxp 结尾");
  const res = await (opts.fetchImpl ?? fetch)(u, { signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000) });
  if (!res.ok) throw new Error(`下载失败（HTTP ${res.status}）`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_PACKAGE) throw new Error("插件包太大，已拒绝");
  return installDbxpBuffer(Buffer.from(await res.arrayBuffer()), root, { requireChecksums: true });
}

/** 卸载：删除 root/<id>（只能删 root 下面的） */
export function uninstallDbxp(id: string, root: string): boolean {
  if (!safeId(id)) throw new Error("插件 id 不合法");
  const dir = path.join(root, id);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

export interface LocalInfo {
  version: string;
  name?: string;
  ui: boolean;
  backend: boolean;
  permissions: string[];
  /** 贡献点类型：workbench / mcp / connection-provider … */
  kinds: string[];
  /** 声明的 AI 工具数 */
  tools: number;
}

/** 读已装插件的清单摘要 */
export function readLocalInfo(root: string, id: string, version: string): LocalInfo {
  const info: LocalInfo = { version, ui: false, backend: false, permissions: [], kinds: [], tools: 0 };
  try {
    const m = JSON.parse(fs.readFileSync(path.join(root, id, "versions", version, "manifest.json"), "utf8").replace(/^\uFEFF/, ""));
    info.name = typeof m.name === "string" ? m.name : undefined;
    info.ui = !!m.entrypoints?.ui;
    info.backend = !!m.entrypoints?.backend;
    info.permissions = Array.isArray(m.permissions) ? m.permissions.filter((x: unknown): x is string => typeof x === "string") : [];
    const cs: any[] = Array.isArray(m.contributions) ? m.contributions : [];
    info.kinds = [...new Set(cs.map(c => String(c?.type ?? "")).filter(Boolean))];
    info.tools = cs.filter(c => c?.type === "mcp").reduce((n, c) => n + Object.keys(c?.tools ?? {}).length, 0);
  } catch {
    // 清单读不出来就只显示版本
  }
  return info;
}

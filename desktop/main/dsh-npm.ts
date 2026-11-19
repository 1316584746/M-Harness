import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { pickVersion } from "../shared/semver";

/**
 * 不依赖本机 npm 的小安装器：从 npm 仓库下载包（校验完整性）、解开、再按 dependencies 往下装。
 * 只做安装 DSH 插件够用的事：
 *   · 不运行任何安装脚本（preinstall / postinstall 一律不跑），需要编译的原生依赖自然也装不出可用的东西；
 *   · 不装 optionalDependencies 和 peerDependencies（对等依赖是宿主提供的，比如 @deepseek-ai/cordis）；
 *   · 已经能被找到的、版本满足的依赖不重复装；版本冲突时放到需要它的包自己的 node_modules 里。
 */

export const DEFAULT_REGISTRIES = ["https://registry.npmjs.org", "https://registry.npmmirror.com"];
const MAX_PACKAGES = 300;
const MAX_TARBALL = 120 * 1024 * 1024;
const MAX_UNPACKED = 400 * 1024 * 1024;
const MAX_FILES = 40_000;

export interface NpmOpts {
  fetchImpl?: typeof fetch;
  /** 按顺序尝试的 npm 仓库 */
  registries?: string[];
  /** 给界面看的进度 */
  progress?: (msg: string) => void;
  /** 依赖里 @deepseek-ai/* 一律由宿主提供，不装；装宿主自己要用的包时要关掉 */
  skipScope?: string;
  /** 一次安装里最多装多少个包 */
  maxPackages?: number;
}

export interface PkgMeta {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  dist: { tarball: string; integrity?: string; shasum?: string };
}

const enc = (name: string) => name.replace("/", "%2F");

async function getJson(f: typeof fetch, url: string): Promise<any> {
  const res = await f(url, { signal: AbortSignal.timeout(30_000), headers: { accept: "application/vnd.npm.install-v1+json, application/json" } });
  if (res.status === 404) throw new Error("NOT_FOUND");
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/** 在若干仓库里找一个包的版本清单；第一个仓库没有或连不上，就换下一个 */
export async function packument(name: string, o: NpmOpts = {}): Promise<{ meta: any; registry: string }> {
  const f = o.fetchImpl ?? fetch;
  let last: unknown;
  for (const reg of o.registries ?? DEFAULT_REGISTRIES) {
    try {
      return { meta: await getJson(f, `${reg.replace(/\/+$/, "")}/${enc(name)}`), registry: reg };
    } catch (e) {
      last = e;
    }
  }
  throw new Error(last instanceof Error && last.message === "NOT_FOUND" ? `npm 上找不到这个包：${name}` : `读取 npm 仓库失败（${name}）：${last instanceof Error ? last.message : String(last)}`);
}

/** 解出某个包某个版本（范围）的元数据 */
export async function resolvePackage(name: string, range: string, o: NpmOpts = {}): Promise<{ meta: PkgMeta; registry: string }> {
  const { meta, registry } = await packument(name, o);
  const versions = Object.keys(meta.versions ?? {});
  const v = pickVersion(versions, range || "latest", meta["dist-tags"] ?? {});
  if (!v) throw new Error(`${name} 没有满足 ${range} 的版本`);
  return { meta: meta.versions[v] as PkgMeta, registry };
}

function checkIntegrity(buf: Buffer, dist: PkgMeta["dist"], name: string): void {
  if (dist.integrity) {
    const m = /^(sha512|sha384|sha256|sha1)-(.+)$/.exec(dist.integrity.trim().split(/\s+/)[0]);
    if (m) {
      const got = crypto.createHash(m[1]).update(buf).digest("base64");
      if (got !== m[2]) throw new Error(`${name} 的下载内容校验没通过（和 npm 上登记的指纹对不上），已拒绝安装`);
      return;
    }
  }
  if (dist.shasum && crypto.createHash("sha1").update(buf).digest("hex") !== dist.shasum) throw new Error(`${name} 的下载内容校验没通过，已拒绝安装`);
}

export async function downloadTarball(meta: PkgMeta, o: NpmOpts = {}, registry?: string): Promise<Buffer> {
  const f = o.fetchImpl ?? fetch;
  const urls = [meta.dist.tarball];
  // 镜像站给的 tarball 地址有时指向自己，连不上时在别的仓库里按同样的规则拼
  for (const reg of o.registries ?? DEFAULT_REGISTRIES) {
    const base = reg.replace(/\/+$/, "");
    const file = `${meta.name.split("/").pop()}-${meta.version}.tgz`;
    const u = `${base}/${meta.name}/-/${file}`;
    if (!urls.includes(u) && reg !== registry) urls.push(u);
  }
  let err: unknown;
  for (const u of urls) {
    try {
      const res = await f(u, { signal: AbortSignal.timeout(180_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > MAX_TARBALL) throw new Error("包太大");
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > MAX_TARBALL) throw new Error("包太大（超过 120MB）");
      checkIntegrity(buf, meta.dist, meta.name);
      return buf;
    } catch (e) {
      err = e;
      if (e instanceof Error && /校验没通过/.test(e.message)) throw e; // 内容被改了不是网络问题，不换地方重试
    }
  }
  throw new Error(`下载 ${meta.name}@${meta.version} 失败：${err instanceof Error ? err.message : String(err)}`);
}

// ───────── tar ─────────

const cstr = (b: Buffer, from: number, len: number) => {
  const s = b.subarray(from, from + len);
  const z = s.indexOf(0);
  return s.subarray(0, z < 0 ? s.length : z).toString("utf8");
};
const octal = (b: Buffer, from: number, len: number) => {
  const t = cstr(b, from, len).trim();
  return t ? Number.parseInt(t, 8) : 0;
};

export interface TarFile {
  path: string;
  data: Buffer;
  mode: number;
}

/** 解 .tgz：返回里面的普通文件（去掉最外层的 package/ 目录）。符号链接和硬链接一律不要；路径不能跑出目录 */
export function untgz(tgz: Buffer): TarFile[] {
  const buf = zlib.gunzipSync(tgz, { maxOutputLength: MAX_UNPACKED });
  const out: TarFile[] = [];
  let off = 0;
  let longName: string | undefined;
  let paxPath: string | undefined;
  let total = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    if (h.every(x => x === 0)) break;
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    const prefix = cstr(h, 345, 155);
    let name = cstr(h, 0, 100);
    if (prefix && /^ustar/.test(cstr(h, 257, 6))) name = `${prefix}/${name}`;
    const data = buf.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "x") {
      // pax 扩展头：「长度 键=值\n」
      const t = data.toString("utf8");
      const m = /\d+ path=([^\n]*)\n/.exec(t);
      if (m) paxPath = m[1];
      continue;
    }
    if (type === "L") {
      longName = cstr(data, 0, data.length);
      continue;
    }
    if (type === "g") continue;
    const full = paxPath ?? longName ?? name;
    paxPath = longName = undefined;
    if (type !== "0") continue; // 目录、链接、设备文件都不要
    const parts = full.replace(/\\/g, "/").split("/").filter(x => x && x !== ".");
    parts.shift(); // package/
    if (!parts.length || parts.some(p => p === "..") || /^[A-Za-z]:$/.test(parts[0])) continue;
    total += data.length;
    if (total > MAX_UNPACKED || out.length >= MAX_FILES) throw new Error("包解开后太大");
    out.push({ path: parts.join("/"), data: Buffer.from(data), mode: octal(h, 100, 8) });
  }
  return out;
}

/** 把文件写进目录；路径不能跑出这个目录 */
export function writeFiles(dir: string, files: Array<{ path: string; data: Buffer }>): void {
  const root = path.resolve(dir);
  for (const f of files) {
    const target = path.resolve(root, f.path);
    if (target !== root && !target.startsWith(root + path.sep)) throw new Error(`包里有不安全的路径：${f.path}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.data);
  }
}

// ───────── 依赖安装 ─────────

const readPkg = (dir: string): { name?: string; version?: string } | undefined => {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  } catch {
    return undefined;
  }
};

/** 沿着 node_modules 链找一个已经装好的、版本满足的依赖 */
function findInstalled(chain: string[], name: string, range: string): boolean {
  for (const nm of chain) {
    const p = readPkg(path.join(nm, ...name.split("/")));
    if (p?.version && (pickVersion([p.version], range) === p.version || range === "*" || range === "" || range === "latest")) return true;
  }
  return false;
}

/**
 * 给目录 pkgDir 里的包装依赖。chain：从近到远的 node_modules 目录（含 pkgDir/node_modules）。
 * 返回装了多少个包。
 */
export async function installDeps(pkgDir: string, deps: Record<string, string>, o: NpmOpts = {}, chainIn?: string[], counter = { n: 0 }): Promise<number> {
  const chain = chainIn ?? [path.join(pkgDir, "node_modules")];
  const skip = o.skipScope ?? "@deepseek-ai/";
  const max = o.maxPackages ?? MAX_PACKAGES;
  for (const [name, rangeRaw] of Object.entries(deps)) {
    if (skip && name.startsWith(skip)) continue;
    const range = /^(npm:|file:|git|github:|https?:|link:|workspace:)/.test(rangeRaw) ? "latest" : rangeRaw;
    if (findInstalled(chain, name, range)) continue;
    if (++counter.n > max) throw new Error(`依赖太多（超过 ${max} 个包），已停止安装`);
    o.progress?.(`安装依赖 ${name}`);
    const { meta, registry } = await resolvePackage(name, range, o);
    // 放在最外层的 node_modules（大家都找得到）；那里已经有别的版本就放在需要它的包自己的 node_modules 里
    const outer = chain[chain.length - 1];
    const placeNm = fs.existsSync(path.join(outer, ...name.split("/"))) ? chain[0] : outer;
    const dest = path.join(placeNm, ...name.split("/"));
    const files = untgz(await downloadTarball(meta, o, registry));
    fs.rmSync(dest, { recursive: true, force: true });
    writeFiles(dest, files);
    const sub = chain.slice(chain.indexOf(placeNm));
    await installDeps(dest, meta.dependencies ?? {}, o, [path.join(dest, "node_modules"), ...sub], counter);
  }
  return counter.n;
}

/** 把一个 npm 包（指定版本）装到 dest 目录（包的内容直接放在 dest 里），再装它的依赖。返回包的 package.json */
export async function installNpmPackage(name: string, version: string, dest: string, o: NpmOpts = {}): Promise<Record<string, any>> {
  o.progress?.(`下载 ${name}@${version}`);
  const { meta, registry } = await resolvePackage(name, version, o);
  const files = untgz(await downloadTarball(meta, o, registry));
  fs.rmSync(dest, { recursive: true, force: true });
  writeFiles(dest, files);
  const pkg = JSON.parse(fs.readFileSync(path.join(dest, "package.json"), "utf8"));
  await installDeps(dest, pkg.dependencies ?? {}, o);
  return pkg;
}

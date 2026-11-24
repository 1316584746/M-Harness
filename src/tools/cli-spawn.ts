import { spawn, type ChildProcessWithoutNullStreams, type SpawnOptions } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * 启动官方 CLI（lark-cli / meegle / dws）的统一入口。解决三个桌面端常见问题：
 *
 * 1. Windows 下 `spawn("meegle")`（不经 shell）只会找 .exe，而 npm 装出来的是 meegle.cmd 垫片 → ENOENT。
 * 2. 桌面端进程的 PATH 往往不含 npm 全局目录（从图标启动 / 装完后才启动 / macOS GUI 的精简 PATH）。
 * 3. .cmd 垫片经 shell 启动会丢参数里的引号（JSON 参数会坏），所以能识别的垫片直接用 node 跑它指向的脚本。
 */

const WIN = process.platform === "win32";
const WIN_EXTS = [".exe", ".com", ".cmd", ".bat"];

/** `npm prefix -g` 的结果（异步探测后缓存） */
let npmPrefix: string | undefined;

/**
 * 随安装包一起发的 CLI（lark-cli / meegle / dws）所在目录，同事不用装 Node / npm 也能直接用。
 * 顺序：HARNESS_CLI_DIR（手动指定）→ 打包后的 resources/cli → 开发时的 build/cli。找不到返回 undefined。
 */
export function bundledCliDir(): string | undefined {
  const res = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  // 开发时：源码（src/tools）和打包后的主进程（out/main）距项目根都是两级；再兜底看一眼当前目录
  const dev = typeof __dirname === "string" ? path.resolve(__dirname, "..", "..", "build", "cli") : undefined;
  const tries = [process.env.HARNESS_CLI_DIR, res && path.join(res, "cli"), dev, path.join(process.cwd(), "build", "cli")];
  for (const t of tries) {
    try {
      if (t && fs.statSync(t).isDirectory()) return t;
    } catch {
      /* 下一个 */
    }
  }
  return undefined;
}

/** 把随包 CLI 目录追加进当前进程的 PATH：模型通过 shell 工具直接执行 `lark-cli ...` 时也能找到（不覆盖用户自己装的版本） */
export function ensureBundledCliOnPath(): string | undefined {
  const dir = bundledCliDir();
  if (!dir) return undefined;
  const key = Object.keys(process.env).find(k => k.toLowerCase() === "path") ?? "PATH";
  const parts = (process.env[key] ?? "").split(path.delimiter).filter(Boolean);
  const same = (a: string, b: string) => (WIN ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!parts.some(p => same(p, dir))) process.env[key] = [...parts, dir].join(path.delimiter);
  return dir;
}

/** 除了 PATH 之外，CLI 常见的安装位置 */
export function extraBinDirs(): string[] {
  const d: string[] = [];
  if (npmPrefix) d.push(WIN ? npmPrefix : path.join(npmPrefix, "bin"));
  if (WIN) {
    if (process.env.APPDATA) d.push(path.join(process.env.APPDATA, "npm"));
  } else {
    d.push(path.join(os.homedir(), ".npm-global", "bin"), path.join(os.homedir(), ".local", "bin"), "/usr/local/bin", "/opt/homebrew/bin");
  }
  const b = bundledCliDir();
  if (b) d.push(b); // 随包版本永远排最后：用户自己装的 / 用 npm 升级过的优先
  return d;
}

const isFile = (p: string) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

function candidates(base: string): string[] {
  if (!WIN) return [base];
  return path.extname(base) ? [base] : WIN_EXTS.map(e => base + e);
}

/** 把命令名解析成可执行文件的完整路径（找不到就原样返回，交给 spawn 报 ENOENT） */
export function resolveBin(bin: string): string {
  if (/[\\/]/.test(bin)) {
    for (const c of candidates(path.resolve(bin))) if (isFile(c)) return c;
    return bin;
  }
  const bundled = bundledCliDir();
  const isBundled = (p: string) => !!bundled && (WIN ? p.toLowerCase() === bundled.toLowerCase() : p === bundled);
  const dirs = [...(process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(p => !isBundled(p)), ...extraBinDirs()].filter(Boolean);
  for (const dir of dirs) for (const c of candidates(path.join(dir, bin))) if (isFile(c)) return c;
  return bin;
}

/** 读 npm 生成的 .cmd 垫片，取出它实际运行的 JS 脚本（认不出就返回 null） */
function shimScript(cmdFile: string): string | null {
  try {
    const txt = fs.readFileSync(cmdFile, "utf8");
    const m = /"%dp0%\\(node_modules\\[^"\r\n]+?)"\s+%\*/i.exec(txt) ?? /"%~dp0\\(node_modules\\[^"\r\n]+?)"\s+%\*/i.exec(txt);
    if (!m) return null;
    const script = path.join(path.dirname(cmdFile), m[1]);
    return isFile(script) ? script : null;
  } catch {
    return null;
  }
}

/** 兜底：.cmd 只能经 shell 时，给每个参数加引号并去掉 shell 元字符 */
const quoteWin = (s: string) => `"${s.replace(/["%^&|<>\r\n]/g, "")}"`;

/**
 * 启动 CLI。stdio 默认全是管道（和 spawn 一致）。
 * 调用方照常监听 'error'：找不到可执行文件时会触发 ENOENT。
 */
export function spawnCli(bin: string, args: string[], opts: SpawnOptions = {}): ChildProcessWithoutNullStreams {
  const exe = resolveBin(bin);
  if (WIN && /\.(cmd|bat)$/i.test(exe)) {
    const script = shimScript(exe);
    if (script) {
      const local = path.join(path.dirname(exe), "node.exe");
      const node = isFile(local) ? local : resolveBin("node");
      return spawn(node, [script, ...args], { windowsHide: true, ...opts, shell: false }) as ChildProcessWithoutNullStreams;
    }
    return spawn([exe, ...args].map(quoteWin).join(" "), { windowsHide: true, ...opts, shell: true }) as ChildProcessWithoutNullStreams;
  }
  return spawn(exe, args, { windowsHide: true, ...opts, shell: false }) as ChildProcessWithoutNullStreams;
}

/** 这个命令能不能被找到（返回解析出的完整路径，找不到返回 undefined） */
export function findBin(bin: string): string | undefined {
  const r = resolveBin(bin);
  return /[\\/]/.test(r) && isFile(r) ? r : undefined;
}

/**
 * 探测 npm 全局目录并补进当前进程的 PATH（让之后启动的所有子进程都能找到 npm 装的 CLI）。
 * 返回 npm 全局可执行目录；探测失败返回 undefined。装完包后用 force=true 重新探测。
 */
let probing: Promise<string | undefined> | null = null;
export function ensureNpmBinOnPath(force = false): Promise<string | undefined> {
  if (probing && !force) return probing;
  probing = new Promise<string | undefined>(resolve => {
    let out = "";
    let child;
    try {
      child = spawnCli("npm", ["prefix", "-g"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return resolve(undefined);
    }
    child.stdout?.on("data", (b: Buffer) => (out += b.toString("utf8")));
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on("error", () => (clearTimeout(timer), resolve(undefined)));
    child.on("close", code => {
      clearTimeout(timer);
      const prefix = out.trim().split(/\r?\n/).pop()?.trim();
      if (code !== 0 || !prefix) return resolve(undefined);
      npmPrefix = prefix;
      const dir = WIN ? prefix : path.join(prefix, "bin");
      const parts = (process.env.PATH ?? process.env.Path ?? "").split(path.delimiter).filter(Boolean);
      const has = parts.some(p => (WIN ? p.toLowerCase() === dir.toLowerCase() : p === dir));
      if (!has) {
        // 随包 CLI 目录要留在最后，npm 装的（用户升级过的）排在它前面
        const b = bundledCliDir();
        const i = b ? parts.findIndex(p => (WIN ? p.toLowerCase() === b.toLowerCase() : p === b)) : -1;
        if (i >= 0) parts.splice(i, 0, dir);
        else parts.push(dir);
        process.env.PATH = parts.join(path.delimiter);
      }
      resolve(dir);
    });
  });
  return probing;
}

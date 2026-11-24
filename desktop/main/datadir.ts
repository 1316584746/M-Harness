/**
 * 数据位置：配置、令牌、任务、插件、运行记录，以及界面里的对话记录（浏览器存储）都放在同一个目录下。
 * - 默认：Windows 是 D:\M-Harness-data（没有 D 盘就放用户目录下），macOS / Linux 是用户目录下的 M-Harness-data
 * - 可以在「设置 → 偏好 → 数据目录」里改；改的结果记在一个固定位置的小文件里（启动时最先读它）
 * - 目录不存在会自动创建；换目录时，下次启动先把旧数据复制过去（不删旧的）
 * - 开发模式（npm run desktop）也一样用默认目录；默认目录第一次建出来时，由主进程把项目根里已有的数据带过来
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DATA_DIR_NAME = "M-Harness-data";
/** 界面（浏览器内核）的存储放在数据目录下的这个子目录，对话记录 / 任务列表在里面 */
export const APP_STATE_DIR = "app-state";

export interface Pointer {
  dir?: string;
  /** 换目录后的第一次启动要从这里把数据复制过来 */
  migrate?: { home: string; userData: string };
}

export interface DataLayout {
  home: string;
  /** 浏览器存储目录；开发模式没改过位置时为空（沿用 Electron 默认） */
  userData?: string;
  source: "pointer" | "default" | "dev";
  defaultDir: string;
}

export interface Env {
  platform?: NodeJS.Platform;
  homedir?: string;
  exists?: (p: string) => boolean;
}

export function defaultDataDir(env: Env = {}): string {
  const platform = env.platform ?? process.platform;
  const exists = env.exists ?? fs.existsSync;
  if (platform === "win32" && exists("D:\\")) return `D:\\${DATA_DIR_NAME}`;
  return path.join(env.homedir ?? os.homedir(), DATA_DIR_NAME);
}

/** 记录「数据目录在哪」的文件：放在系统的应用数据目录下一个固定的名字里，和数据目录本身无关 */
export const pointerFile = (appData: string) => path.join(appData, "M-Harness-boot", "data-location.json");

export function readPointer(appData: string): Pointer {
  try {
    const j = JSON.parse(fs.readFileSync(pointerFile(appData), "utf8").replace(/^\uFEFF/, ""));
    const out: Pointer = {};
    if (typeof j?.dir === "string" && j.dir.trim()) out.dir = j.dir;
    if (typeof j?.migrate?.home === "string" && typeof j?.migrate?.userData === "string") out.migrate = { home: j.migrate.home, userData: j.migrate.userData };
    return out;
  } catch {
    return {};
  }
}

export function writePointer(appData: string, p: Pointer): void {
  const f = pointerFile(appData);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, JSON.stringify(p, null, 2) + "\n", "utf8");
}

export function resolveLayout(o: { packaged: boolean; cwd: string; appData: string; /** 环境变量 HARNESS_DATA_DIR：自动化测试等场景强制指定，忽略一切记录 */ forced?: string } & Env): DataLayout {
  const defaultDir = defaultDataDir(o);
  if (o.forced?.trim()) return { home: path.resolve(o.forced), source: "dev", defaultDir };
  const p = readPointer(o.appData);
  if (p.dir) return { home: path.resolve(p.dir), userData: path.join(path.resolve(p.dir), APP_STATE_DIR), source: "pointer", defaultDir };
  // 没改过位置就用默认目录（开发模式也一样，设置里显示的「当前」和「默认」才一致）
  return { home: defaultDir, userData: path.join(defaultDir, APP_STATE_DIR), source: "default", defaultDir };
}

/** 目录不存在就创建（含子目录）；建不出来会抛错，由调用方退回到系统默认位置 */
export function ensureDirs(l: DataLayout): void {
  fs.mkdirSync(l.home, { recursive: true });
  if (l.userData) fs.mkdirSync(l.userData, { recursive: true });
}

/** 数据目录里属于「用户数据」的文件和子目录（项目根里的源码、node_modules 不在其中，所以从开发目录迁移也不会把代码带过去） */
export const HOME_FILES = [
  "harness.config.json",
  ".env",
  "connections.json",
  "connection-secrets.json",
  "plugin-consent.json",
  "plugin-repos.json",
  "plugin-db-grants.json",
  "plugin-ai.json",
  "dsh-consent.json",
  "automations.json",
  "defects.json",
  "workbench-cache.json",
  "home-cache.json",
  "models-cache.json",
  "db-audit.jsonl",
  "db-audit.jsonl.1",
  ".host-storage.json",
];
export const HOME_DIRS = [".traces", "daily", "plugins", "plugin-data", "tasks", "skills", "dsh"];
/** 浏览器存储里要带走的（对话记录、任务列表、界面设置都在 Local Storage / IndexedDB） */
export const STATE_ITEMS = ["Local Storage", "IndexedDB", "Session Storage", "Preferences"];

const same = (a: string, b: string) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

function copyItem(src: string, dst: string, copied: string[]): void {
  if (!fs.existsSync(src) || fs.existsSync(dst)) return; // 新目录里已经有的不覆盖
  try {
    fs.cpSync(src, dst, { recursive: true, force: false, errorOnExist: false });
    copied.push(path.basename(src));
  } catch {
    // 个别文件被占用时跳过，不挡启动
  }
}

/** 把旧位置的用户数据复制到新位置；旧文件原样保留 */
export function migrateData(from: { home: string; userData: string }, to: DataLayout): string[] {
  const copied: string[] = [];
  if (!same(from.home, to.home)) {
    for (const f of HOME_FILES) copyItem(path.join(from.home, f), path.join(to.home, f), copied);
    for (const d of HOME_DIRS) copyItem(path.join(from.home, d), path.join(to.home, d), copied);
  }
  if (to.userData && !same(from.userData, to.userData)) {
    for (const s of STATE_ITEMS) copyItem(path.join(from.userData, s), path.join(to.userData, s), copied);
  }
  return copied;
}

export interface DataDirInfo {
  /** 当前正在用的数据目录 */
  current: string;
  /** 默认位置 */
  defaultDir: string;
  isDefault: boolean;
  /** 浏览器存储（对话记录等）所在目录 */
  stateDir: string;
}

/** 检查并登记新的数据目录；真正切换在重启后（那时先迁数据） */
export function requestDataDir(appData: string, cur: { home: string; userData: string }, dir: string): { ok: boolean; error?: string; same?: boolean } {
  const target = (dir ?? "").trim();
  if (!target || !path.isAbsolute(target)) return { ok: false, error: "请选一个完整的目录路径" };
  const abs = path.resolve(target);
  if (same(abs, cur.home)) return { ok: true, same: true };
  if (fs.existsSync(abs) && !fs.statSync(abs).isDirectory()) return { ok: false, error: "这个路径是个文件，不是目录" };
  try {
    fs.mkdirSync(abs, { recursive: true });
    fs.accessSync(abs, fs.constants.W_OK);
  } catch (e: any) {
    return { ok: false, error: `不能在这里创建 / 写入：${e?.code ?? e?.message ?? e}` };
  }
  const rel = path.relative(cur.home, abs);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) return { ok: false, error: "新目录不能放在当前数据目录里面" };
  writePointer(appData, { dir: abs, migrate: { home: cur.home, userData: cur.userData } });
  return { ok: true };
}

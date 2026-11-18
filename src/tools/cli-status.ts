import { spawn } from "node:child_process";

/**
 * 设置页「集成」卡片用：检测官方 CLI（lark-cli / meegle / dws）的版本、登录身份、可用更新。
 * 只执行固定的只读子命令，不经过模型。
 */

export interface CliSpec {
  bin: string;
  binArgs?: string[];
}

export interface CliStatus {
  installed: boolean;
  version?: string;
  authenticated: boolean;
  /** 登录的账号名 */
  user?: string;
  /** 飞书 open_id（lark-cli） */
  openId?: string;
  detail?: string;
}

export interface UpdateInfo {
  /** 该 CLI 是否提供更新检查 */
  supported: boolean;
  ok: boolean;
  current?: string;
  latest?: string;
  hasUpdate?: boolean;
  url?: string;
  message: string;
}

function decode(buf: Buffer): string {
  const utf8 = buf.toString("utf8");
  if (process.platform === "win32" && utf8.includes("\uFFFD")) {
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch {
      /* ignore */
    }
  }
  return utf8;
}

/** 执行固定参数的 CLI。Windows 下 npm 装出来的 .cmd/.bat 垫片需要经 shell 才能启动（参数都是写死的常量，不含用户输入） */
export function runCli(spec: CliSpec, args: string[], timeoutMs = 20_000): Promise<{ code: number | null; out: string; err: string; spawnError?: string }> {
  return new Promise(resolve => {
    const viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(spec.bin);
    const argv = [...(spec.binArgs ?? []), ...args];
    const q = (s: string) => `"${s.replace(/["%^&|<>\r\n]/g, "")}"`;
    const child = viaShell ? spawn([spec.bin, ...argv].map(q).join(" "), { shell: true, windowsHide: true }) : spawn(spec.bin, argv, { shell: false, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout?.on("data", (b: Buffer) => out.length < 400 && out.push(b));
    child.stderr?.on("data", (b: Buffer) => err.length < 400 && err.push(b));
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", e => {
      clearTimeout(timer);
      resolve({ code: -1, out: "", err: "", spawnError: e.message });
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, out: decode(Buffer.concat(out)).trim(), err: decode(Buffer.concat(err)).trim() });
    });
  });
}

const VERSION_RE = /v?(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/;
export const parseVersion = (s: string): string | undefined => VERSION_RE.exec(s)?.[1];

function json(s: string): any | null {
  const i = s.indexOf("{");
  if (i < 0) return null;
  try {
    return JSON.parse(s.slice(i));
  } catch {
    return null;
  }
}

const missing = (spec: CliSpec, hint: string): CliStatus => ({ installed: false, authenticated: false, detail: `没有找到 ${spec.bin}。${hint}` });

/** 版本比较：a < b 返回 true */
export function olderThan(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map(n => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) < (pb[i] ?? 0);
  return false;
}

// ───────────── 飞书 lark-cli ─────────────

export async function larkStatus(spec: CliSpec): Promise<CliStatus> {
  const v = await runCli(spec, ["--version"], 10_000);
  if (v.spawnError) return missing(spec, "请确认已安装 lark-cli 并在 PATH 里，或在配置里填对路径。");
  const version = parseVersion(v.out || v.err);
  const a = await runCli(spec, ["auth", "status"], 15_000);
  const j = json(a.out);
  if (!j) return { installed: true, version, authenticated: false, detail: (a.err || a.out).slice(0, 200) || "无法读取登录状态" };
  const user = j.identities?.user;
  const bot = j.identities?.bot;
  const userOk = !!user?.openId && user?.available !== false;
  const botOk = bot?.status === "ready";
  return {
    installed: true,
    version,
    authenticated: userOk || botOk,
    user: user?.userName || undefined,
    openId: user?.openId || undefined,
    detail: userOk || botOk ? (botOk ? undefined : "只有用户身份可用，机器人身份未就绪（长连接通道需要 bot）") : "未登录，请在终端执行 lark-cli auth login",
  };
}

export async function larkCheckUpdate(spec: CliSpec): Promise<UpdateInfo> {
  const r = await runCli(spec, ["update", "--check", "--json"], 30_000);
  if (r.spawnError) return { supported: true, ok: false, message: `无法运行 ${spec.bin}` };
  const j = json(r.out);
  if (!j) return { supported: true, ok: false, message: (r.err || r.out).slice(0, 160) || "检查更新失败" };
  const hasUpdate = j.action === "update_available" || (!!j.latest_version && !!j.current_version && olderThan(j.current_version, j.latest_version));
  return {
    supported: true,
    ok: j.ok !== false,
    current: j.current_version,
    latest: j.latest_version,
    hasUpdate,
    url: j.url,
    message: hasUpdate ? `有新版本 ${j.latest_version}（当前 ${j.current_version}），在终端执行 lark-cli update 升级` : `已是最新版本 ${j.current_version ?? ""}`.trim(),
  };
}

// ───────────── 钉钉 dws ─────────────

export async function dwsStatus(spec: CliSpec): Promise<CliStatus & { latest?: string; hasUpdate?: boolean }> {
  const a = await runCli(spec, ["auth", "status"], 20_000);
  if (a.spawnError) return missing(spec, "安装：npm install -g dingtalk-workspace-cli，然后执行 dws auth login。");
  const j = json(a.out);
  const vc = j?.version_check;
  const version = parseVersion(vc?.current ?? "") ?? parseVersion((await runCli(spec, ["--version"], 10_000)).out);
  if (!j) return { installed: true, version, authenticated: false, detail: (a.err || a.out).slice(0, 200) || "无法读取登录状态" };
  const user = [j.user_name, j.userName, j.nick, j.name, j.user?.name, j.user?.nick, j.identity?.name].find(x => typeof x === "string" && x);
  return {
    installed: true,
    version,
    authenticated: !!j.authenticated,
    user,
    latest: parseVersion(vc?.latest ?? ""),
    hasUpdate: vc?.status === "update_available" || (!!vc?.latest && !!vc?.current && olderThan(parseVersion(vc.current) ?? "0.0.0", parseVersion(vc.latest) ?? "0.0.0")),
    detail: j.authenticated ? undefined : "未登录，请在终端执行 dws auth login",
  };
}

export async function dwsCheckUpdate(spec: CliSpec): Promise<UpdateInfo> {
  const s = await dwsStatus(spec);
  if (!s.installed) return { supported: true, ok: false, message: s.detail ?? "未安装" };
  return {
    supported: true,
    ok: true,
    current: s.version,
    latest: s.latest,
    hasUpdate: !!s.hasUpdate,
    message: s.hasUpdate ? `有新版本 ${s.latest}（当前 ${s.version}），在终端执行 dws upgrade 升级` : `已是最新版本 ${s.version ?? ""}`.trim(),
  };
}

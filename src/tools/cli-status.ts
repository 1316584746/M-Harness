import { ensureNpmBinOnPath, extraBinDirs, findBin, spawnCli } from "./cli-spawn";

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
  /** 飞书机器人（智能体）身份是否就绪（lark-cli） */
  botReady?: boolean;
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

/** 执行固定参数的 CLI（命令名解析、npm 全局目录兜底、.cmd 垫片处理都在 spawnCli 里） */
export function runCli(spec: CliSpec, args: string[], timeoutMs = 20_000): Promise<{ code: number | null; out: string; err: string; spawnError?: string }> {
  return new Promise(resolve => {
    const argv = [...(spec.binArgs ?? []), ...args];
    const child = spawnCli(spec.bin, argv);
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

/** 各 CLI 对应的 npm 包（固定常量，不接受外部输入） */
export const CLI_PACKAGES = {
  lark: "@larksuite/cli",
  meegle: "@lark-project/meegle",
  dws: "dingtalk-workspace-cli",
} as const;

export interface InstallResult {
  ok: boolean;
  /** 安装/升级命令的输出（截尾） */
  output: string;
  error?: string;
}

/** 各 CLI 默认的命令名 */
export const CLI_BINS = { lark: "lark-cli", meegle: "meegle", dws: "dws" } as const;

/**
 * 用 npm 全局安装（或升级到最新）官方 CLI。需要本机有 Node / npm。
 * 装完会校验「真的能找到可执行文件」：找不到就如实告诉用户装到了哪、怎么办，不会报「成功」却检测不到。
 */
export async function installCli(kind: string, bin?: string, timeoutMs = 300_000): Promise<InstallResult> {
  const r = await npmInstall(kind, timeoutMs);
  if (!r.ok) return r;
  // 装完重新探测 npm 全局目录并补进 PATH，当前进程立刻就能用
  const dir = await ensureNpmBinOnPath(true);
  const name = bin ?? (CLI_BINS as Record<string, string>)[kind];
  if (findBin(name)) return r;
  const where = dir ?? extraBinDirs()[0] ?? "npm 全局目录";
  return {
    ok: false,
    output: r.output,
    error: `已安装，但在 ${where} 里没找到 ${name} 的可执行文件。请确认该目录存在，并把它加入系统 PATH（或在设置里填 ${name} 的完整路径），然后点「检测」`,
  };
}

function npmInstall(kind: string, timeoutMs: number): Promise<InstallResult> {
  const pkg = (CLI_PACKAGES as Record<string, string>)[kind];
  if (!pkg) return Promise.resolve({ ok: false, output: "", error: `未知集成：${kind}` });
  return new Promise(resolve => {
    const child = spawnCli("npm", ["install", "-g", `${pkg}@latest`]);
    const chunks: Buffer[] = [];
    const push = (b: Buffer) => chunks.length < 400 && chunks.push(b);
    child.stdout?.on("data", push);
    child.stderr?.on("data", push);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    const tail = () => decode(Buffer.concat(chunks)).trim().slice(-1500);
    child.on("error", e => {
      clearTimeout(timer);
      resolve({ ok: false, output: "", error: `无法运行 npm：${e.message}。请先安装 Node.js（含 npm）` });
    });
    child.on("close", code => {
      clearTimeout(timer);
      const output = tail();
      if (code === 0) return resolve({ ok: true, output });
      const notFound = /not recognized|command not found|不是内部或外部命令|找不到/i.test(output);
      const perm = /EACCES|EPERM|permission/i.test(output);
      resolve({
        ok: false,
        output,
        error: notFound ? "没有找到 npm，请先安装 Node.js（含 npm）" : perm ? "权限不足：请用管理员身份运行，或改用 `npm config set prefix` 指向可写目录" : `安装失败（退出码 ${code}）`,
      });
    });
  });
}

// ───────────── 一键登录 ─────────────

export interface LoginHooks {
  /** 拿到授权链接（调用方负责在浏览器打开 / 展示） */
  onUrl(url: string, userCode?: string): void;
  /** 阶段提示 */
  onStep?(text: string): void;
}

export interface LoginResult {
  ok: boolean;
  message: string;
}

const URL_RE = /https?:\/\/[^\s"'<>，。）)]+/g;
const urlsIn = (s: string) => s.match(URL_RE) ?? [];

/** 流式执行：边输出边回调，直到进程结束（登录这类要等用户在浏览器里操作的命令用） */
export function streamCli(spec: CliSpec, args: string[], onText: (s: string) => void, timeoutMs: number): Promise<{ code: number | null; out: string; spawnError?: string }> {
  return new Promise(resolve => {
    const child = spawnCli(spec.bin, [...(spec.binArgs ?? []), ...args]);
    let all = "";
    const feed = (b: Buffer) => {
      const t = decode(b);
      all = (all + t).slice(-20_000);
      onText(t);
    };
    child.stdout?.on("data", feed);
    child.stderr?.on("data", feed);
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.on("error", e => {
      clearTimeout(timer);
      resolve({ code: -1, out: "", spawnError: e.message });
    });
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code, out: all.trim() });
    });
  });
}

const LOGIN_TIMEOUT = 10 * 60_000;

async function loggedIn(kind: string, spec: CliSpec): Promise<boolean> {
  try {
    if (kind === "lark") return (await larkStatus(spec)).authenticated;
    if (kind === "dws") return (await dwsStatus(spec)).authenticated;
    const a = await runCli(spec, ["auth", "status"], 15_000);
    return !!(json(a.out) ?? json(a.err))?.authenticated;
  } catch {
    return false;
  }
}

/** 把 CLI 的失败输出整理成一两句人话（优先取 JSON 里的 message / hint，否则取最后两行） */
function explainFailure(out: string): string {
  const j = json(out);
  const m = j?.error?.message ?? j?.message;
  if (typeof m === "string" && m) return [m, j?.error?.hint].filter(x => typeof x === "string" && x).join("：").slice(0, 200);
  const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  return lines.slice(-2).join(" ").slice(-160);
}

/**
 * 登录流程结束后的结论。不能只看退出码：有的 CLI 在「部分权限没授予」时也返回非零，但账号其实已经登录了。
 * 所以非零时再查一次真实登录状态，已登录就算成功。
 */
async function finishLogin(kind: string, spec: CliSpec, p: { code: number | null; out: string }): Promise<LoginResult> {
  if (p.code === 0) return { ok: true, message: "登录成功" };
  if (await loggedIn(kind, spec)) return { ok: true, message: "已登录（CLI 提示有部分权限没有授予，用到时会再提示授权）" };
  return { ok: false, message: `登录未完成：${explainFailure(p.out) || "已取消或超时"}` };
}

async function larkLogin(spec: CliSpec, hooks: LoginHooks): Promise<LoginResult> {
  let j: any = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await runCli(spec, ["auth", "login", "--no-wait", "--json"], 30_000);
    if (r.spawnError) return { ok: false, message: `无法运行 ${spec.bin}` };
    j = json(r.out) ?? json(r.err); // lark-cli 的错误 JSON 走 stderr
    if (j?.ok === false && j.error?.subtype === "not_configured" && attempt === 0) {
      // 首次使用：先在浏览器里完成应用配置（官方的 config init --new），再回来登录
      hooks.onStep?.("首次使用，请先在浏览器里完成应用配置…");
      let opened = false;
      const c = await streamCli(
        spec,
        ["config", "init", "--new"],
        t => {
          const u = !opened && urlsIn(t)[0];
          if (u) {
            opened = true;
            hooks.onUrl(u);
          }
        },
        LOGIN_TIMEOUT,
      );
      if (c.code !== 0) return { ok: false, message: `应用配置未完成：${c.out.slice(-200) || "已取消或超时"}` };
      continue;
    }
    if (!j) return { ok: false, message: (r.err || r.out).slice(0, 200) || "无法发起登录" };
    break;
  }
  if (j?.ok === false) return { ok: false, message: [j.error?.message, j.error?.hint].filter(Boolean).join("：") || "无法发起登录" };
  const url: string | undefined = j.verification_url_complete ?? j.verification_uri_complete ?? j.verification_url ?? j.verification_uri ?? urlsIn(JSON.stringify(j))[0];
  const code: string | undefined = j.device_code;
  if (!url || !code) return { ok: false, message: "没有拿到授权链接" };
  hooks.onUrl(url, j.user_code);
  hooks.onStep?.("请在浏览器里完成授权…");
  const p = await streamCli(spec, ["auth", "login", "--device-code", code], () => {}, LOGIN_TIMEOUT);
  return finishLogin("lark", spec, p);
}

async function meegleLogin(spec: CliSpec, hooks: LoginHooks, host = "https://project.feishu.cn"): Promise<LoginResult> {
  const r = await runCli(spec, ["auth", "login", "--device-code", "--phase", "init", "--host", host], 30_000);
  if (r.spawnError) return { ok: false, message: `无法运行 ${spec.bin}` };
  const j = json(r.out) ?? json(r.err);
  if (!j?.device_code || !j.client_id) return { ok: false, message: (j?.error?.message ?? (r.err || r.out)).slice(0, 200) || "无法发起登录" };
  hooks.onUrl(j.verification_uri_complete ?? j.verification_uri, j.user_code);
  hooks.onStep?.("请在浏览器里完成授权…");
  const p = await streamCli(spec, ["auth", "login", "--device-code", "--phase", "poll", "--client-id", j.client_id, "--device-code-value", j.device_code, "--host", host], () => {}, LOGIN_TIMEOUT);
  return finishLogin("meegle", spec, p);
}

async function dwsLogin(spec: CliSpec, hooks: LoginHooks): Promise<LoginResult> {
  let opened = false;
  const p = await streamCli(
    spec,
    ["auth", "login", "--no-browser"],
    t => {
      const u = !opened && urlsIn(t).find(x => /dingtalk\.(com|io)/.test(x));
      if (u) {
        opened = true;
        hooks.onUrl(u);
        hooks.onStep?.("请在浏览器里完成授权…");
      }
    },
    LOGIN_TIMEOUT,
  );
  if (p.spawnError) return { ok: false, message: `无法运行 ${spec.bin}` };
  return finishLogin("dws", spec, p);
}

/** 一键登录：发起官方设备授权 / OAuth 流程，拿到链接交给调用方打开，等用户授权完成。阻塞时间取决于用户（最长 10 分钟） */
export function loginCli(kind: string, spec: CliSpec, hooks: LoginHooks, opts?: { meegleHost?: string }): Promise<LoginResult> {
  if (kind === "lark") return larkLogin(spec, hooks);
  if (kind === "meegle") return meegleLogin(spec, hooks, opts?.meegleHost);
  if (kind === "dws") return dwsLogin(spec, hooks);
  return Promise.resolve({ ok: false, message: `未知集成：${kind}` });
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

/** lark-cli 里有没有这个名字的配置（profile）；`lark-cli profile list` 输出 JSON 数组 */
export async function larkProfileExists(spec: CliSpec, name: string): Promise<boolean> {
  const r = await runCli({ bin: spec.bin }, ["profile", "list"], 15_000);
  const s = r.out || r.err;
  const a = s.indexOf("[");
  const b = s.lastIndexOf("]");
  if (a < 0 || b <= a) return false;
  try {
    const list = JSON.parse(s.slice(a, b + 1));
    return Array.isArray(list) && list.some((p: any) => p?.name === name);
  } catch {
    return false;
  }
}

/**
 * 新建一个专属飞书机器人，存成名为 name 的独立配置（`config init --new --name`，追加而不是替换，不动本机已有的配置）。
 * 会阻塞到用户在浏览器里确认完成；确认链接通过 hooks.onUrl 交给界面。
 */
export async function larkCreateProfile(spec: CliSpec, name: string, hooks: LoginHooks): Promise<LoginResult> {
  let opened = false;
  const c = await streamCli(
    { bin: spec.bin },
    ["config", "init", "--new", "--name", name],
    t => {
      const u = !opened && urlsIn(t)[0];
      if (u) {
        opened = true;
        hooks.onUrl(u);
      }
    },
    LOGIN_TIMEOUT,
  );
  if (c.spawnError) return { ok: false, message: `无法运行 ${spec.bin}` };
  if (c.code !== 0 && !(await larkProfileExists(spec, name))) return { ok: false, message: `机器人创建未完成：${c.out.slice(-200) || "已取消或超时"}` };
  return { ok: true, message: "机器人已创建" };
}

export async function larkStatus(spec: CliSpec): Promise<CliStatus> {
  const v = await runCli(spec, ["--version"], 10_000);
  if (v.spawnError) return missing(spec, "请确认已安装 lark-cli 并在 PATH 里，或在配置里填对路径。");
  const version = parseVersion(v.out || v.err);
  const a = await runCli(spec, ["auth", "status"], 15_000);
  const j = json(a.out) ?? json(a.err);
  // 首次使用还没初始化应用配置：给人话，点「登录」会自动引导完成
  if (j?.error?.subtype === "not_configured") return { installed: true, version, authenticated: false, detail: "尚未完成首次配置，点「登录」会引导你在浏览器里完成" };
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
    botReady: botOk,
    detail: userOk || botOk ? (botOk ? undefined : "只有用户身份可用，机器人身份未就绪（长连接通道需要 bot）") : "未登录，请在终端执行 lark-cli auth login",
  };
}

export async function larkCheckUpdate(spec: CliSpec): Promise<UpdateInfo> {
  const r = await runCli(spec, ["update", "--check", "--json"], 30_000);
  if (r.spawnError) return { supported: true, ok: false, message: `无法运行 ${spec.bin}` };
  const j = json(r.out) ?? json(r.err);
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
  const j = json(a.out) ?? json(a.err);
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

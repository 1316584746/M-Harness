import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool } from "../core/types";
import { parseVersion } from "./cli-status";

/**
 * 飞书项目（Meegle / Lark Project）工具：封装官方 meegle CLI。
 * 身份用的是本机 meegle 已登录的账号（meegle auth login），Key 不经过本程序。
 *
 * 为了不给模型任意执行命令的能力，只开放白名单里的子命令；
 * 读类（查询）归 read 风险，写类（评论、建/改工作项、流转节点）归 write 风险，
 * 因此办公通道默认只读时，写类工具会被护栏直接拒绝。
 */

export interface FeishuProjectConfig {
  /** meegle 可执行文件，默认走 PATH 里的 meegle */
  bin: string;
  binArgs?: string[];
  timeoutSec?: number;
  /** 是否启用写类工具（评论、创建/修改工作项、节点流转），默认关闭 */
  write?: boolean;
  /** 默认空间：用户没指明空间时，模型默认查这个空间 */
  defaultSpace?: { key: string; name?: string };
}

/** "域 动作" 白名单 */
export const READ_COMMANDS = [
  "mywork todo",
  "project search",
  "workitem get",
  "workitem query",
  "workitem meta-types",
  "workitem meta-fields",
  "workitem meta-roles",
  "workitem meta-create-fields",
  "workitem list-op-records",
  "comment list",
  "relation meta-definitions",
  "relation list",
  "workflow get-node",
  "workflow list-state-transitions",
  "user me",
  "user search",
  "url parse",
];

export const WRITE_COMMANDS = ["comment add", "workitem create", "workitem update", "workflow transition"];

const KEY_RE = /^[a-z][a-z0-9-]*$/;
const MAX_OUT = 200_000;

type ArgVal = string | number | boolean | Array<string | number | boolean | Record<string, unknown>> | Record<string, unknown>;

/** 把 {"project-key": "x", set: ["a=1"]} 转成 --project-key=x --set=a=1 */
export function toFlags(args: Record<string, ArgVal> | undefined): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(args ?? {})) {
    const key = k.replace(/^--/, "").replace(/_/g, "-");
    if (!KEY_RE.test(key)) throw new Error(`非法参数名：${k}`);
    const vals = Array.isArray(v) ? v : [v];
    for (const x of vals) {
      if (x === true) out.push(`--${key}`);
      else if (x === false || x === undefined || x === null) continue;
      else out.push(`--${key}=${typeof x === "object" ? JSON.stringify(x) : String(x)}`);
    }
  }
  return out;
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

/** 执行一次 meegle 命令（不经过 shell，参数逐个传递，避免注入） */
export function runMeegle(cfg: FeishuProjectConfig, argv: string[], signal: AbortSignal): Promise<string> {
  return new Promise(resolve => {
    const child = spawn(cfg.bin, [...(cfg.binArgs ?? []), ...argv], { shell: false, windowsHide: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (b: Buffer) => {
      if (size < MAX_OUT) {
        out.push(b);
        size += b.length;
      }
    });
    child.stderr.on("data", (b: Buffer) => err.length < 200 && err.push(b));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, (cfg.timeoutSec ?? 60) * 1000);
    const onAbort = () => child.kill();
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", e => {
      clearTimeout(timer);
      resolve(`启动 ${cfg.bin} 失败：${e.message}。请确认已安装飞书项目 CLI（meegle）并在设置里填对路径。`);
    });
    child.on("close", code => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const stdout = decode(Buffer.concat(out)).trim();
      const stderr = decode(Buffer.concat(err)).trim();
      if (timedOut) return resolve(`[超时已终止] ${stdout || stderr}`);
      if (code !== 0) return resolve(`meegle 退出码 ${code}\n${stderr || stdout}`);
      resolve(stdout || stderr || "（无输出）");
    });
  });
}

function split(command: string): [string, string] {
  const parts = command.trim().split(/\s+/);
  if (parts.length !== 2) throw new Error(`命令格式应为「域 动作」，如 workitem query，收到：${command}`);
  return [parts[0], parts[1]];
}

const ArgsSchema = z
  .record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.unknown())])), z.record(z.string(), z.unknown())]),
  )
  .optional()
  .describe('命令参数，键是参数名（不带 --），如 {"project-key":"xxx","mql":"SELECT ..."}；可重复的参数传数组；--set 传 ["字段=值"]');

export function feishuProjectTools(cfg: FeishuProjectConfig): Tool[] {
  const ds = cfg.defaultSpace;
  const spaceHint = ds?.key ? `默认空间：${(ds.name ?? "").replace(/\s+/g, " ")}（project-key=${ds.key.replace(/\s+/g, "")}）；用户没有指明空间时，查询、创建都用这个空间，不用再 project search。` : "";
  const tools: Tool[] = [
    {
      name: "feishu_project_inspect",
      description: "查看飞书项目某个命令的参数说明，如 workitem.query、comment.add。不确定参数时先调用它。",
      risk: "read",
      schema: z.object({ command: z.string().describe('如 "workitem.query" 或 "workitem query"') }),
      async run({ command }, ctx) {
        const [d, a] = split(command.replace(".", " "));
        const full = `${d} ${a}`;
        if (!READ_COMMANDS.includes(full) && !WRITE_COMMANDS.includes(full)) throw new Error(`不支持的命令：${full}`);
        return runMeegle(cfg, ["inspect", `${d}.${a}`], ctx.signal);
      },
    },
    {
      name: "feishu_project_my_todo",
      description: "查看我在飞书项目里的待办 / 已办 / 逾期 / 本周待办（跨空间）。",
      risk: "read",
      schema: z.object({
        action: z.enum(["todo", "done", "overdue", "this_week"]).default("todo").describe("todo 待办、done 已办、overdue 逾期、this_week 本周待办"),
        page: z.number().int().min(1).optional().describe("页码，每页 50 条"),
      }),
      async run({ action, page }, ctx) {
        const flags = [`--action=${action}`];
        if (page) flags.push(`--page-num=${page}`);
        return runMeegle(cfg, ["mywork", "todo", ...flags], ctx.signal);
      },
    },
    {
      name: "feishu_project_read",
      description: `只读查询飞书项目。可用命令：${READ_COMMANDS.join("、")}。常见流程：project search 找空间 project_key → workitem meta-types 看工作项类型 → workitem query（MQL）或 workitem get 查详情。参数不清楚先用 feishu_project_inspect。${spaceHint}`,
      risk: "read",
      schema: z.object({ command: z.string().describe('"域 动作"，如 "workitem query"'), args: ArgsSchema }),
      async run({ command, args }, ctx) {
        const [d, a] = split(command);
        if (!READ_COMMANDS.includes(`${d} ${a}`)) throw new Error(`不在只读白名单内：${d} ${a}。可用：${READ_COMMANDS.join("、")}`);
        return runMeegle(cfg, [d, a, ...toFlags(args as any)], ctx.signal);
      },
    },
  ];

  if (cfg.write) {
    tools.push({
      name: "feishu_project_write",
      description: `修改飞书项目数据（会以我的身份生效，调用前需要我确认）。可用命令：${WRITE_COMMANDS.join("、")}。创建工作项前先用 feishu_project_read 查 workitem meta-create-fields / meta-roles；改字段用 --set "字段key=值"。${spaceHint}`,
      risk: "write",
      schema: z.object({ command: z.string().describe('"域 动作"，如 "comment add"'), args: ArgsSchema }),
      async run({ command, args }, ctx) {
        const [d, a] = split(command);
        if (!WRITE_COMMANDS.includes(`${d} ${a}`)) throw new Error(`不在写入白名单内：${d} ${a}。可用：${WRITE_COMMANDS.join("、")}`);
        return runMeegle(cfg, [d, a, ...toFlags(args as any)], ctx.signal);
      },
    });
  }
  return tools;
}

export interface FeishuProjectStatus {
  installed: boolean;
  authenticated: boolean;
  host?: string;
  version?: string;
  /** 登录的账号名 */
  user?: string;
  detail?: string;
}

/** 供设置页展示：meegle 是否可用、版本、登录账号 */
export async function feishuProjectStatus(cfg: FeishuProjectConfig): Promise<FeishuProjectStatus> {
  const c = { ...cfg, timeoutSec: 15 };
  const text = await runMeegle(c, ["auth", "status"], new AbortController().signal);
  if (/^启动 .* 失败/.test(text)) return { installed: false, authenticated: false, detail: text };
  const version = parseVersion(await runMeegle(c, ["version"], new AbortController().signal));
  try {
    const j = JSON.parse(text);
    let user: string | undefined;
    if (j.authenticated) {
      try {
        const me = JSON.parse(await runMeegle(c, ["user", "me"], new AbortController().signal));
        user = me.name_cn || me.name_en || me.name || undefined;
      } catch {
        /* 取不到名字不影响使用 */
      }
    }
    return { installed: true, authenticated: !!j.authenticated, host: j.host, version, user, detail: j.authenticated ? undefined : "未登录，请在终端执行 meegle auth login" };
  } catch {
    return { installed: true, version, authenticated: false, detail: text.slice(0, 200) };
  }
}

export interface FeishuSpace {
  name: string;
  key: string;
  simpleName?: string;
}

/** 当前账号最近访问过的空间（meegle project search 不带关键词时的返回） */
export async function feishuProjectSpaces(cfg: FeishuProjectConfig): Promise<{ ok: boolean; spaces?: FeishuSpace[]; error?: string }> {
  const text = await runMeegle({ ...cfg, timeoutSec: 30 }, ["project", "search", "--auto-paginate"], new AbortController().signal);
  try {
    const j = JSON.parse(text);
    const spaces: FeishuSpace[] = (j.projects ?? []).filter((p: any) => p?.project_key).map((p: any) => ({ name: p.name ?? p.project_key, key: p.project_key, simpleName: p.simple_name }));
    return { ok: true, spaces };
  } catch {
    return { ok: false, error: text.slice(0, 200) };
  }
}

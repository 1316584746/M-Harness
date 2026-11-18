import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool } from "../core/types";
import { toFlags } from "./feishu-project";

/**
 * 钉钉项目管理工具：封装官方 dws CLI（dingtalk-workspace-cli）。
 * dws 没有独立的「项目」产品，钉钉里做项目管理主要靠：
 *   - 待办（todo）：任务、子任务、执行人 / 参与人、截止时间、优先级、评论、标签、提醒
 *   - AI 表格（aitable）：用多维表做需求 / 缺陷 / 排期看板
 * 身份用本机 dws 已登录的账号（dws auth login），密钥不经过本程序。
 *
 * 只开放白名单里的子命令；读类归 read 风险，写类归 write 风险（办公通道默认只读时会被护栏拒绝）。
 * 删除类命令（任务 / 评论 / 记录 / 表）一律不开放。
 */

export interface DingtalkProjectConfig {
  bin: string;
  binArgs?: string[];
  timeoutSec?: number;
  /** 是否启用写类工具，默认关闭 */
  write?: boolean;
}

export const DT_READ_COMMANDS = [
  "contact user get-self",
  "aisearch person",
  "todo task list",
  "todo task get",
  "todo task list-sub",
  "todo task list-attachment",
  "todo comment list",
  "todo tag list",
  "aitable base list",
  "aitable base search",
  "aitable base get",
  "aitable table get",
  "aitable field get",
  "aitable view get",
  "aitable record query",
];

export const DT_WRITE_COMMANDS = [
  "todo task create",
  "todo task create-sub",
  "todo task update",
  "todo task done",
  "todo task add-executor",
  "todo task remove-executor",
  "todo task add-participant",
  "todo task remove-participant",
  "todo task add-reminder",
  "todo comment add",
  "todo tag create",
  "todo tag add",
  "aitable record create",
  "aitable record update",
];

const CMD_RE = /^[a-z][a-z-]*( [a-z][a-z-]*){1,3}$/;
const MAX_OUT = 200_000;

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

/** 执行一次 dws 命令（不经过 shell，参数逐个传递，避免注入） */
export function runDws(cfg: DingtalkProjectConfig, argv: string[], signal: AbortSignal): Promise<string> {
  return new Promise(resolve => {
    const viaShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(cfg.bin);
    const all = [...(cfg.binArgs ?? []), ...argv];
    // .cmd 垫片必须经 shell；此时给每个参数加引号并去掉 shell 元字符（用户内容里的这些字符会被丢弃）
    const q = (s: string) => `"${s.replace(/["%^&|<>\r\n]/g, "")}"`;
    const child = viaShell ? spawn([cfg.bin, ...all].map(q).join(" "), { shell: true, windowsHide: true }) : spawn(cfg.bin, all, { shell: false, windowsHide: true });
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
      resolve(`启动 ${cfg.bin} 失败：${e.message}。请确认已安装钉钉 CLI（npm install -g dingtalk-workspace-cli）并在设置里填对路径。`);
    });
    child.on("close", code => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      const stdout = decode(Buffer.concat(out)).trim();
      const stderr = decode(Buffer.concat(err)).trim();
      if (timedOut) return resolve(`[超时已终止] ${stdout || stderr}`);
      if (code !== 0) return resolve(`dws 退出码 ${code}\n${stderr || stdout}`);
      resolve(stdout || stderr || "（无输出）");
    });
  });
}

function parseCommand(command: string): string[] {
  const c = command.trim().replace(/\s+/g, " ");
  if (!CMD_RE.test(c)) throw new Error(`命令格式应为「产品 [子域] 动作」，如 todo task list，收到：${command}`);
  return c.split(" ");
}

const ArgsSchema = z
  .record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number(), z.boolean(), z.record(z.string(), z.unknown())])), z.record(z.string(), z.unknown())]))
  .optional()
  .describe('命令参数，键是参数名（不带 --），如 {"title":"修复线上Bug","executors":"userId1,userId2","due":"2026-03-20T18:00:00+08:00","priority":40}；开关类参数传 true；值为 false / true 的参数（如 status）请传字符串 "false" / "true"');

/** 在命令后追加 --format json（调用方没指定时） */
function withJson(args: string[], extra: string[]): string[] {
  return extra.some(a => a.startsWith("--format")) ? [...args, ...extra] : [...args, ...extra, "--format=json"];
}

export function dingtalkProjectTools(cfg: DingtalkProjectConfig): Tool[] {
  const tools: Tool[] = [
    {
      name: "dingtalk_project_inspect",
      description: "查看钉钉某个命令的参数说明（dws <命令> --help），如 todo task create、aitable record query。不确定参数时先调用它。",
      risk: "read",
      schema: z.object({ command: z.string().describe('如 "todo task create"') }),
      async run({ command }, ctx) {
        const parts = parseCommand(command);
        const full = parts.join(" ");
        if (!DT_READ_COMMANDS.includes(full) && !DT_WRITE_COMMANDS.includes(full)) throw new Error(`不支持的命令：${full}`);
        return runDws(cfg, [...parts, "--help"], ctx.signal);
      },
    },
    {
      name: "dingtalk_project_read",
      description: `只读查询钉钉项目管理数据（待办任务 / AI 表格）。可用命令：${DT_READ_COMMANDS.join("、")}。常见流程：contact user get-self 取我的 userId → todo task list 看我的待办（--status false 只看未完成）→ todo task get 看详情；按姓名找人用 aisearch person（--query 姓名 --dimension name）；多维表看板：aitable base search 找表 → aitable table get 取数据表 → aitable record query 读记录。参数不清楚先用 dingtalk_project_inspect。`,
      risk: "read",
      schema: z.object({ command: z.string().describe('"产品 子域 动作"，如 "todo task list"'), args: ArgsSchema }),
      async run({ command, args }, ctx) {
        const parts = parseCommand(command);
        const full = parts.join(" ");
        if (!DT_READ_COMMANDS.includes(full)) throw new Error(`不在只读白名单内：${full}。可用：${DT_READ_COMMANDS.join("、")}`);
        return runDws(cfg, withJson(parts, toFlags(args as any)), ctx.signal);
      },
    },
  ];

  if (cfg.write) {
    tools.push({
      name: "dingtalk_project_write",
      description: `修改钉钉项目管理数据（会以我的身份生效，调用前需要我确认）。可用命令：${DT_WRITE_COMMANDS.join("、")}。创建待办必须有执行人 executors（userId，没指定就用我自己的）；时间用 ISO-8601 带时区；优先级 10低/20普通/30较高/40紧急。不支持删除。`,
      risk: "write",
      schema: z.object({ command: z.string().describe('"产品 子域 动作"，如 "todo task create"'), args: ArgsSchema }),
      async run({ command, args }, ctx) {
        const parts = parseCommand(command);
        const full = parts.join(" ");
        if (!DT_WRITE_COMMANDS.includes(full)) throw new Error(`不在写入白名单内：${full}。可用：${DT_WRITE_COMMANDS.join("、")}`);
        return runDws(cfg, withJson(parts, toFlags(args as any)), ctx.signal);
      },
    });
  }
  return tools;
}

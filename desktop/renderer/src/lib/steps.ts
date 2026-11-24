import type { HarnessEvent } from "../../../shared/api";

export type ToolStatus = "running" | "ok" | "blocked" | "denied";

export interface ToolRun {
  name: string;
  args: unknown;
  output?: string;
  ms?: number;
  status: ToolStatus;
  /** 被护栏拦截 / 用户拒绝的原因 */
  reason?: string;
  /** 经过人工审批（true=通过） */
  approved?: boolean;
}

export interface Step {
  n: number;
  ms?: number;
  tokens?: number;
  /** 模型在这一步给出的文字（调用工具前的说明，或最终回答） */
  text?: string;
  tools: ToolRun[];
}

export type LogKind = "thinking" | "text" | "tool" | "status" | "error";
export interface LogEntry {
  kind: LogKind;
  text: string;
}

/** 过程日志最多保留多少条（太长的任务只留最近的，思考内容单条也限长） */
const LOG_MAX = 400;
const THINK_MAX = 6000;

export interface RunView {
  provider?: string;
  input?: string;
  steps: Step[];
  /** 外部 Agent 的过程输出（纯文本，兼容旧展示） */
  progress: string[];
  /** 外部 Agent 的过程输出（带类别：思考 / 回复 / 工具 / 状态 / 错误；相邻的思考片段已合并） */
  log: LogEntry[];
  notes: string[];
  done?: { reason: string; text?: string; error?: string };
  toolCount: number;
  tokens: number;
  /** 外部 Agent（Cursor / 命令行 Agent）跑的：没有「模型步数 / token」这些概念，只统计工具调用和耗时 */
  external?: boolean;
  /** 总耗时：有时间戳时用首尾差，否则用各步耗时累加 */
  totalMs?: number;
  /** 当前正在做什么（运行中展示） */
  activity?: string;
}

/** 把扁平的事件流整理成"步骤 → 工具调用"的结构，供界面展示 */
export function buildRunView(events: HarnessEvent[], timestamps?: number[]): RunView {
  const view: RunView = { steps: [], progress: [], log: [], notes: [], toolCount: 0, tokens: 0 };
  const stepOf = (n: number): Step => {
    let s = view.steps.find(x => x.n === n);
    if (!s) {
      s = { n, tools: [] };
      view.steps.push(s);
    }
    return s;
  };
  const approvals = new Map<string, boolean>();
  let sumMs = 0;

  for (const e of events) {
    switch (e.type) {
      case "run_start":
        view.provider = e.provider;
        view.input = e.input;
        view.activity = "准备中…";
        break;
      case "model_call":
        stepOf(e.step);
        view.activity = "思考中…";
        break;
      case "model_reply": {
        const s = stepOf(e.step);
        s.ms = e.ms;
        s.tokens = e.tokens;
        s.text = e.reply.message.content || undefined;
        view.tokens += e.tokens;
        sumMs += e.ms;
        if (e.reply.toolCalls?.length) view.activity = `准备调用 ${e.reply.toolCalls.map(c => c.name).join("、")}…`;
        break;
      }
      case "approval":
        approvals.set(e.name, e.approved);
        view.activity = e.approved ? `已批准 ${e.name}` : `已拒绝 ${e.name}`;
        break;
      case "tool_call": {
        const t: ToolRun = { name: e.name, args: e.args, status: "running" };
        if (approvals.has(e.name)) {
          t.approved = approvals.get(e.name);
          approvals.delete(e.name);
        }
        stepOf(e.step).tools.push(t);
        view.toolCount++;
        view.activity = `正在执行 ${e.name}…`;
        break;
      }
      case "tool_blocked": {
        const approvedDenied = approvals.get(e.name) === false;
        approvals.delete(e.name);
        stepOf(e.step).tools.push({
          name: e.name,
          args: undefined,
          status: approvedDenied ? "denied" : "blocked",
          reason: e.reason,
          approved: approvedDenied ? false : undefined,
        });
        view.toolCount++;
        break;
      }
      case "tool_result": {
        const s = stepOf(e.step);
        const t = [...s.tools].reverse().find(x => x.name === e.name && x.status === "running");
        if (t) {
          t.status = "ok";
          t.output = e.output;
          t.ms = e.ms;
        }
        sumMs += e.ms;
        view.activity = "思考中…";
        break;
      }
      case "agent_progress": {
        const kind: LogKind = e.kind ?? "text";
        view.external = true;
        // 外部 Agent 的工具调用开始行：「🔧 名称 参数」（结果行是缩进的 ✓ / ✗，不重复算）
        if (/^🔧\s/.test(e.line)) view.toolCount++;
        view.progress.push(e.line);
        const last = view.log[view.log.length - 1];
        if (kind === "thinking" && last?.kind === "thinking") {
          // 思考是一小段一小段流过来的：接在上一段后面，合成一整段
          last.text = (last.text + e.line).slice(-THINK_MAX);
        } else {
          view.log.push({ kind, text: e.line });
          if (view.log.length > LOG_MAX) view.log.splice(0, view.log.length - LOG_MAX);
        }
        view.activity = kind === "thinking" ? "思考中…" : kind === "error" ? "遇到错误…" : e.line.replace(/\s+/g, " ").trim().slice(0, 60);
        break;
      }
      case "context_trim":
        view.notes.push(`上下文压缩：${e.before} → ${e.after} token，丢弃 ${e.dropped} 条早期消息`);
        break;
      case "done":
        view.done = { reason: e.reason, text: e.text, error: e.error };
        view.activity = undefined;
        break;
    }
  }

  view.totalMs = timestamps && timestamps.length > 1 ? timestamps[timestamps.length - 1] - timestamps[0] : sumMs || undefined;
  view.steps.sort((a, b) => a.n - b.n);
  return view;
}

/** token 数：532 / 1.2 万 / 123 万 */
export function fmtTokens(n: number): string {
  if (n < 10_000) return String(Math.round(n));
  const w = n / 10_000;
  return `${w < 100 ? w.toFixed(1).replace(/\.0$/, "") : Math.round(w)} 万`;
}

export function fmtMs(ms: number | undefined): string {
  if (ms === undefined) return "";
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
}

/** 工具参数的一行摘要：命令 / 路径 / 网址优先 */
export function argSummary(name: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const pick = a.command ?? a.path ?? a.url;
  if (typeof pick === "string") return pick;
  const s = JSON.stringify(args ?? {});
  return s === "{}" ? "" : s;
}

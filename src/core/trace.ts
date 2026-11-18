import fs from "node:fs";
import path from "node:path";
import type { Emit, HarnessEvent } from "./types";

export interface TraceLine {
  ts: number;
  runId: string;
  event: HarnessEvent;
}

/** 把事件追加写入 <dir>/<runId>.jsonl，返回 emit 函数与文件路径 */
export function createJsonlTrace(dir: string, runId: string): { emit: Emit; file: string } {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${runId}.jsonl`);
  const emit: Emit = event => {
    fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), runId, event } satisfies TraceLine) + "\n");
  };
  return { emit, file };
}

/** 合并多个订阅者 */
export function fanout(...sinks: Array<Emit | undefined>): Emit {
  const list = sinks.filter((s): s is Emit => !!s);
  return e => {
    for (const s of list) {
      try {
        s(e);
      } catch {
        /* 订阅者异常不能影响主流程 */
      }
    }
  };
}

export function readTrace(file: string): TraceLine[] {
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map(l => JSON.parse(l) as TraceLine);
}

export function newRunId(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 单行摘要，用于控制台 / replay */
export function formatEvent(e: HarnessEvent): string {
  const cut = (s: string, n = 160) => (s.length > n ? s.slice(0, n) + "…" : s).replace(/\n/g, "⏎");
  switch (e.type) {
    case "run_start":
      return `▶ run ${e.runId} provider=${e.provider} input=${cut(e.input, 80)}`;
    case "model_call":
      return `· [${e.step}] 调用模型 (${e.messages.length} 条消息)`;
    case "model_reply":
      return `· [${e.step}] 模型回复 ${e.ms}ms ${e.tokens}tok ${e.reply.toolCalls?.length ? `→ ${e.reply.toolCalls.length} 个工具调用` : cut(e.reply.message.content, 80)}`;
    case "tool_call":
      return `🔧 [${e.step}] ${e.name} ${cut(JSON.stringify(e.args), 120)}`;
    case "tool_blocked":
      return `⛔ [${e.step}] ${e.name} 被拦截：${e.reason}`;
    case "approval":
      return `🙋 [${e.step}] ${e.name} 审批${e.approved ? "通过" : "被拒"}`;
    case "tool_result":
      return `   [${e.step}] ${e.name} ✓ ${e.ms}ms ${cut(e.output, 100)}`;
    case "agent_progress":
      return `  … ${cut(e.line, 140)}`;
    case "context_trim":
      return `✂ 上下文压缩 ${e.before}→${e.after} tok，丢弃 ${e.dropped} 条`;
    case "done":
      return `■ 结束：${e.reason}${e.error ? " " + e.error : ""}${e.text ? " — " + cut(e.text, 100) : ""}`;
  }
}

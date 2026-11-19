import type { HarnessEvent } from "../../../shared/api";
import { argSummary } from "./steps";

/** 事件流里「工作过程」中的一行：思考 / 工具调用 / 状态 / 错误 */
export type FlowItem =
  | { kind: "think"; at: number; text: string }
  | { kind: "tool"; at: number; name: string; arg: string; status: "running" | "ok" | "fail"; ms?: number; output?: string }
  | { kind: "status" | "error"; at: number; text: string };

/** 一段：AI 先说一句话（say），再做一串工作（items）——和聊天里「说明 + 工作过程」一样 */
export interface FlowSeg {
  at: number;
  say?: string;
  items: FlowItem[];
}

const TOOL_START = /^🔧\s*(\S+)\s?([\s\S]*)$/;
const TOOL_OK = /^\s*✓\s*(\S+)(?:\s*→\s*([\s\S]*))?$/;
const TOOL_FAIL = /^\s*✗\s*(\S+)\s*(?:失败)?[：:]?\s*([\s\S]*)$/;

/** 工具参数的一行摘要：`{"command":"ls"}` → `$ ls`（参数可能被截断，解析不了就用正则抠） */
export function toolArgLine(name: string, arg: string): string {
  const s = arg.trim();
  if (!s) return "";
  const grab = (k: string) => new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(s)?.[1];
  const un = (v: string) => v.replace(/\\n/g, " ").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  const cmd = grab("command");
  if (cmd) return `$ ${un(cmd)}`;
  const other = grab("path") ?? grab("url") ?? grab("pattern") ?? grab("query");
  if (other) return un(other);
  return s.startsWith("{") || s.startsWith("[") ? s : name === "shell" ? `$ ${s}` : s;
}

/** 把一轮的事件按时间整理成「说明 + 工作过程」的段落；times 与 events 一一对应（缺失时用 fallback 时间） */
export function buildFlow(events: HarnessEvent[], times: number[] | undefined, fallbackAt = 0): FlowSeg[] {
  const segs: FlowSeg[] = [];
  const at = (i: number) => (times && times.length === events.length ? times[i] : fallbackAt);
  const cur = (t: number): FlowSeg => segs[segs.length - 1] ?? (segs.push({ at: t, items: [] }), segs[0]);
  // 命令行 Agent 的输出是一行一条（要补换行）；Cursor SDK 的回复是一小段一小段的增量（直接首尾相接）
  const lineMode = events.some(e => e.type === "agent_progress" && e.kind === "status" && e.line.startsWith("已启动 "));
  const say = (text: string, t: number, sep: string) => {
    const c = segs[segs.length - 1];
    if (c && !c.items.length) c.say = c.say ? c.say + sep + text : text;
    else segs.push({ at: t, say: text, items: [] });
  };
  const lastRunning = (s: FlowSeg | undefined, name: string) => {
    if (!s) return undefined;
    for (let k = s.items.length - 1; k >= 0; k--) {
      const it = s.items[k];
      if (it.kind === "tool" && it.status === "running" && (it.name === name || !name)) return it;
    }
    return undefined;
  };
  /** 工具结果可能落在后一段（中间插了说明），从后往前找 */
  const findRunning = (name: string) => {
    for (let k = segs.length - 1; k >= 0; k--) {
      const t = lastRunning(segs[k], name);
      if (t) return t;
    }
    return undefined;
  };

  events.forEach((e, i) => {
    const t = at(i);
    switch (e.type) {
      case "agent_progress": {
        const kind = e.kind ?? "text";
        if (kind === "text") {
          say(e.line, t, lineMode ? "\n" : "");
        } else if (kind === "thinking") {
          const c = cur(t);
          const last = c.items[c.items.length - 1];
          if (last?.kind === "think") last.text = (last.text + e.line).slice(-6000);
          else c.items.push({ kind: "think", at: t, text: e.line });
        } else if (kind === "tool") {
          const ok = TOOL_OK.exec(e.line);
          const start = TOOL_START.exec(e.line);
          if (ok) {
            const tool = findRunning(ok[1]);
            if (tool) Object.assign(tool, { status: "ok", ms: Math.max(0, t - tool.at), output: ok[2] });
            else cur(t).items.push({ kind: "tool", at: t, name: ok[1], arg: "", status: "ok", output: ok[2] });
          } else if (start) cur(t).items.push({ kind: "tool", at: t, name: start[1], arg: start[2], status: "running" });
        } else if (kind === "error") {
          const f = TOOL_FAIL.exec(e.line);
          const tool = f && findRunning(f[1]);
          if (tool) Object.assign(tool, { status: "fail", ms: Math.max(0, t - tool.at), output: f![2] || e.line.trim() });
          else cur(t).items.push({ kind: "error", at: t, text: e.line.trim() });
        }
        // 状态行（已创建 / 已提交 / 运行结束）不是「步骤」，不进工作过程
        break;
      }
      case "model_reply": {
        const text = e.reply.message.content?.trim();
        if (text) say(text, t, "\n\n");
        break;
      }
      case "tool_call":
        cur(t).items.push({ kind: "tool", at: t, name: e.name, arg: argSummary(e.name, e.args), status: "running" });
        break;
      case "tool_result": {
        const tool = findRunning(e.name);
        if (tool) Object.assign(tool, { status: "ok", ms: e.ms, output: e.output });
        break;
      }
      case "tool_blocked":
        cur(t).items.push({ kind: "tool", at: t, name: e.name, arg: "", status: "fail", output: e.reason });
        break;
      default:
        break;
    }
  });
  return segs;
}

/** 一段「工作过程」的统计：几步、用了多久（最后一段还在跑时算到 now） */
export function segStats(seg: FlowSeg, endAt: number): { steps: number; ms: number } {
  const first = seg.items[0]?.at ?? seg.at;
  return { steps: seg.items.length, ms: Math.max(0, endAt - first) };
}

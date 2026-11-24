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
  const cmd = grab("command") ?? grab("cmd");
  if (cmd) return `$ ${un(cmd)}`;
  // 搜索类：「模式  在哪搜」；读 / 写 / 改文件类：文件路径
  const pat = grab("pattern") ?? grab("regex") ?? grab("query") ?? grab("glob_pattern") ?? grab("globPattern") ?? grab("searchTerm");
  const where = grab("path") ?? grab("file_path") ?? grab("filePath") ?? grab("target_file") ?? grab("targetFile") ?? grab("target_directory") ?? grab("directory") ?? grab("file");
  if (pat && where) return `${un(pat)}  ·  ${un(where)}`;
  const other = pat ?? where ?? grab("url");
  if (other) return un(other);
  return s.startsWith("{") || s.startsWith("[") ? s : name === "shell" ? `$ ${s}` : s;
}

export type ToolKind = "read" | "search" | "edit" | "run" | "other";

/** 工具大类（给图标和「读取了几个文件 · 搜索了几次」的小结用）：按名字认，认不出的算 other */
export function toolKind(name: string): ToolKind {
  const n = name.toLowerCase();
  if (/(^|[_-])(grep|glob|search|find|rg|ls|list|semsearch|codebase)/.test(n) || /search|grep|glob/.test(n)) return "search";
  if (/(^|[_-])(read|cat|view)/.test(n)) return "read";
  if (/(edit|write|patch|apply|replace|create|delete|remove|mv|rename)/.test(n)) return "edit";
  if (/(shell|bash|exec|command|run|terminal|powershell|cmd)/.test(n)) return "run";
  return "other";
}

/** 一段工作过程的小结：「读取 3 个文件 · 搜索 2 次 · 执行 1 条命令 · 修改 1 个文件」，没有可归类的就返回空 */
export function itemsSummary(items: FlowItem[]): string {
  const c: Record<ToolKind, number> = { read: 0, search: 0, edit: 0, run: 0, other: 0 };
  for (const it of items) if (it.kind === "tool") c[toolKind(it.name)]++;
  const parts: string[] = [];
  if (c.read) parts.push(`读取 ${c.read} 个文件`);
  if (c.search) parts.push(`搜索 ${c.search} 次`);
  if (c.edit) parts.push(`修改 ${c.edit} 处`);
  if (c.run) parts.push(`执行 ${c.run} 条命令`);
  if (c.other) parts.push(`其他 ${c.other} 个操作`);
  return parts.join(" · ");
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

/**
 * 一轮中途失败（超时 / 中断 / 出错）后，给「继续」用的进度摘要：已经说过的话、读过的文件、搜过的内容、跑过的命令。
 * 重试是新开一个 Agent，它看不到上一轮的上下文，靠这份摘要接着做，不用从头再读一遍。总长度有上限。
 */
export function progressDigest(events: HarnessEvent[], times?: number[], maxChars = 6000): string {
  const segs = buildFlow(events, times, 0);
  const says = segs.map(s => s.say?.replace(/\s+/g, " ").trim()).filter((x): x is string => !!x);
  const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];
  const items = segs.flatMap(s => s.items).filter((x): x is Extract<FlowItem, { kind: "tool" }> => x.kind === "tool" && x.status !== "fail");
  const line = (it: Extract<FlowItem, { kind: "tool" }>) => toolArgLine(it.name, it.arg).replace(/\s+/g, " ").slice(0, 160);
  const reads = uniq(items.filter(it => toolKind(it.name) === "read").map(line));
  const searches = uniq(items.filter(it => toolKind(it.name) === "search").map(line));
  const runs = uniq(items.filter(it => toolKind(it.name) === "run").map(line));
  const edits = uniq(items.filter(it => toolKind(it.name) === "edit").map(line));
  const part = (title: string, xs: string[], n: number) => (xs.length ? `${title}（${xs.length}）：\n${xs.slice(0, n).map(x => `- ${x}`).join("\n")}${xs.length > n ? `\n- …另有 ${xs.length - n} 条` : ""}` : "");
  const out = [
    says.length ? `上次过程中说过的话（按时间）：\n${says.slice(-12).map(x => `- ${x.slice(0, 200)}`).join("\n")}` : "",
    part("已读过的文件", reads, 80),
    part("已搜索过", searches, 40),
    part("已执行过的命令", runs, 20),
    part("已修改 / 写入过", edits, 20),
  ]
    .filter(Boolean)
    .join("\n\n");
  return out.length > maxChars ? out.slice(0, maxChars) + "\n…（已截断）" : out;
}

/**
 * 「推进动作」的事件流只留简短进度：AI 最后写出来的整份产物会显示在左边，这里不再重复贴一遍。
 * - 跑完后：最后那段只有说明、没有后续步骤的文字就是产物本身，去掉；
 * - 太长的说明（多半是在写产物）：运行中写成「正在撰写产物」，其余的截成一行。
 */
export function briefSegs(segs: FlowSeg[], running: boolean, max = 160): FlowSeg[] {
  const out: FlowSeg[] = [];
  segs.forEach((s, k) => {
    if (!s.say) return void out.push(s);
    const trailing = k === segs.length - 1 && !s.items.length;
    if (trailing && !running) return;
    if (s.say.length <= max) return void out.push(s);
    const say = trailing ? "正在撰写产物…（完成后显示在左侧）" : s.say.replace(/\s+/g, " ").trim().slice(0, 60) + "…";
    out.push({ ...s, say });
  });
  return out;
}

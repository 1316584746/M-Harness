import type { Emit, Msg } from "./types";

/** 粗略 token 估算：ASCII 约 4 字符/token，非 ASCII（中文等）约 1 字符/token */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) (ch.charCodeAt(0) < 128 ? ascii++ : other++);
  return Math.ceil(ascii / 4) + other;
}

export function messagesTokens(msgs: Msg[]): number {
  return msgs.reduce((n, m) => {
    let t = estimateTokens(m.content) + 4;
    if (m.toolCalls) t += estimateTokens(JSON.stringify(m.toolCalls));
    return n + t;
  }, 0);
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.7);
  const tail = max - head;
  return `${s.slice(0, head)}\n…[已截断 ${s.length - max} 字符]…\n${s.slice(-tail)}`;
}

export interface ContextOptions {
  /** 上下文 token 预算 */
  maxTokens: number;
  /** 工具输出单条上限（字符） */
  maxToolOutput?: number;
}

/**
 * 上下文管理：
 * 1. 保留 system；
 * 2. 以 user 消息为界把对话切成"回合"，超预算时整回合从最旧开始丢弃（保证 assistant.toolCalls 与 tool 结果成对）；
 * 3. 丢弃处插入一条占位说明；
 * 4. 若只剩最后一个回合仍超预算，则压缩其中较长的 tool 输出。
 */
export class ContextManager {
  constructor(private opts: ContextOptions, private emit?: Emit) {}

  get maxToolOutput() {
    return this.opts.maxToolOutput ?? 8000;
  }

  fit(messages: Msg[]): Msg[] {
    const budget = this.opts.maxTokens;
    const before = messagesTokens(messages);
    if (before <= budget) return messages;

    const system = messages[0]?.role === "system" ? [messages[0]] : [];
    const rest = messages.slice(system.length);
    const turns: Msg[][] = [];
    for (const m of rest) {
      if (m.role === "user" || turns.length === 0) turns.push([m]);
      else turns[turns.length - 1].push(m);
    }

    let dropped = 0;
    while (turns.length > 1 && messagesTokens([...system, ...turns.flat()]) > budget) {
      dropped += turns.shift()!.length;
    }

    let kept = turns.flat();
    if (messagesTokens([...system, ...kept]) > budget) {
      kept = kept.map(m => (m.role === "tool" ? { ...m, content: truncate(m.content, 1500) } : m));
    }

    const note: Msg[] =
      dropped > 0
        ? [{ role: "system", content: `（为控制上下文长度，已省略更早的 ${dropped} 条历史消息）` }]
        : [];
    const out = [...system, ...note, ...kept];
    this.emit?.({ type: "context_trim", before, after: messagesTokens(out), dropped });
    return out;
  }
}

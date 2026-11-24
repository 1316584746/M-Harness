import type { HarnessEvent } from "../core/types";
import { chunkText } from "./types";

/** 群里「流式」回复：先发一条「处理中」，过程中编辑同一条消息，做完把它改成最终答案 */
export interface StreamIO {
  /** 发一条新消息，返回它的 id（拿不到 id 就没法编辑，返回 undefined） */
  send(text: string): Promise<string | undefined>;
  /** 编辑已发的消息，成功返回 true */
  /** final：这是最后一次（改成最终答案） */
  edit(id: string, text: string, final?: boolean, failed?: boolean): Promise<boolean>;
  /** 另发一条新消息（超长的后半段、编辑失败时的兜底） */
  reply(text: string): Promise<void>;
}

export interface StreamHandle {
  update(text: string): void;
  /** failed：这一轮没做完（失败 / 中断），卡片用红色 */
  finish(text: string, failed?: boolean): Promise<void>;
}

/**
 * 飞书限制：同一条消息最多编辑 20 次、频率也有上限。所以过程中最多编辑 maxEdits 次、两次之间至少隔 minIntervalMs，
 * 最后一次（改成最终答案）不占这个额度；编辑失败就不再编辑，最终答案改成另发新消息，保证一定能收到。
 */
export class ReplyStream implements StreamHandle {
  private id?: string;
  private edits = 0;
  private lastAt = 0;
  private latest = "";
  private sentText = "";
  private broken = false;
  private timer?: NodeJS.Timeout;
  private chain: Promise<void> = Promise.resolve();

  constructor(
    private io: StreamIO,
    private opts: { minIntervalMs?: number; maxEdits?: number; chunk?: number; now?: () => number } = {},
  ) {}

  private get min() {
    return this.opts.minIntervalMs ?? 2000;
  }
  private get max() {
    return this.opts.maxEdits ?? 15;
  }
  private now() {
    return (this.opts.now ?? Date.now)();
  }

  /** 发出第一条「处理中」；拿不到消息 id 返回 false（调用方退回整条发送） */
  async start(initial = "⏳ 收到，正在处理…"): Promise<boolean> {
    try {
      this.id = await this.io.send(initial);
    } catch {
      this.id = undefined;
    }
    this.sentText = initial;
    this.lastAt = this.now();
    return !!this.id;
  }

  update(text: string): void {
    this.latest = text;
    if (this.broken || !this.id || this.edits >= this.max || text === this.sentText) return;
    const wait = this.lastAt + this.min - this.now();
    if (wait <= 0) return this.flush();
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flush();
      }, wait);
      this.timer.unref?.();
    }
  }

  private flush(): void {
    const text = this.latest.length > (this.opts.chunk ?? 3500) ? this.latest.slice(-(this.opts.chunk ?? 3500)) : this.latest;
    if (this.broken || !this.id || text === this.sentText) return;
    this.edits++;
    this.lastAt = this.now();
    this.sentText = text;
    const id = this.id;
    this.chain = this.chain.then(async () => {
      if (this.broken) return;
      try {
        if (!(await this.io.edit(id, text, false))) this.broken = true;
      } catch {
        this.broken = true;
      }
    });
  }

  async finish(text: string, failed = false): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.chain;
    const parts = chunkText(text, this.opts.chunk ?? 3500);
    if (this.id && !this.broken) {
      let ok = false;
      try {
        ok = await this.io.edit(this.id, parts[0], true, failed);
      } catch {
        ok = false;
      }
      if (ok) {
        for (const p of parts.slice(1)) await this.io.reply(p);
        return;
      }
      this.broken = true;
    }
    await this.io.reply(text); // 编辑不了：整条另发，保证对方一定能收到
  }
}

/** 把运行过程中的事件整理成「处理中」那条消息的内容：当前在干什么 + 已经写出来的回答 */
export class ProgressText {
  private status = "⏳ 正在处理…";
  private answer = "";

  /** 有变化返回新的内容，没变化返回 undefined */
  feed(e: HarnessEvent): string | undefined {
    const before = this.render();
    switch (e.type) {
      case "agent_progress":
        if (e.kind === "text") {
          this.answer += e.line;
          this.status = "✍️ 正在回答…";
        } else if (e.kind === "thinking") this.status = "💭 思考中…";
        else if (e.kind === "tool") this.status = `🔧 ${short(e.line, 80)}`;
        else if (e.kind === "status") this.status = `⏳ ${short(e.line, 80)}`;
        break;
      case "tool_call":
        this.status = `🔧 调用 ${e.name}`;
        break;
      case "model_call":
        this.status = "💭 思考中…";
        break;
      default:
        break;
    }
    const after = this.render();
    return after === before ? undefined : after;
  }

  private render(): string {
    return this.answer.trim() ? `${this.status}\n\n${this.answer.trim()}` : this.status;
  }
}

const short = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

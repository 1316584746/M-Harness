import type { HarnessEvent } from "../core/types";
import { chunkText } from "./types";

/** 卡片上除正文以外要展示的东西：标题、被问的问题、工具调用清单、耗时、模型 */
export interface CardMeta {
  /** 卡片标题（任务名）；没有就只显示状态 */
  title?: string;
  /** 这一轮被问的问题（卡片上方引用一行） */
  question?: string;
  /** 模型名（卡片底部） */
  model?: string;
  /** 已发生的工具调用（每次一行，只保留最近的） */
  tools?: string[];
  /** 工具调用总次数 */
  toolCount?: number;
  /** 这一轮耗时（毫秒），做完才有 */
  ms?: number;
}

/** 群里「流式」回复：先发一条「处理中」，过程中编辑同一条消息，做完把它改成最终答案 */
export interface StreamIO {
  /** 发一条新消息，返回它的 id（拿不到 id 就没法编辑，返回 undefined） */
  send(text: string, meta?: CardMeta): Promise<string | undefined>;
  /** 编辑已发的消息，成功返回 true */
  /** final：这是最后一次（改成最终答案） */
  edit(id: string, text: string, final?: boolean, failed?: boolean, meta?: CardMeta): Promise<boolean>;
  /** 另发一条新消息（超长的后半段、编辑失败时的兜底） */
  reply(text: string): Promise<void>;
}

export interface StreamHandle {
  /** 更新卡片上正文以外的内容（工具清单等）；下一次编辑时带上。不支持卡片的实现可以不提供 */
  setMeta?(m: CardMeta): void;
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
  private meta: CardMeta;
  private startedAt: number;

  constructor(
    private io: StreamIO,
    private opts: { minIntervalMs?: number; maxEdits?: number; chunk?: number; now?: () => number; meta?: CardMeta } = {},
  ) {
    this.meta = { ...(opts.meta ?? {}) };
    this.startedAt = (opts.now ?? Date.now)();
  }

  setMeta(m: CardMeta): void {
    this.meta = { ...this.meta, ...m };
  }

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
      this.id = await this.io.send(initial, this.meta);
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
    const meta = { ...this.meta }; // 这一刻的快照（排队编辑期间 meta 可能又变了）
    this.chain = this.chain.then(async () => {
      if (this.broken) return;
      try {
        if (!(await this.io.edit(id, text, false, undefined, meta))) this.broken = true;
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
        ok = await this.io.edit(this.id, parts[0], true, failed, { ...this.meta, ms: this.now() - this.startedAt });
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
  private tools: string[] = [];
  private toolCount = 0;

  /** 工具调用清单（卡片里「思考与工具」折叠面板用）：只保留最近 40 条，总次数另算 */
  meta(): CardMeta {
    return { tools: this.tools.slice(-40), toolCount: this.toolCount };
  }

  private addTool(line: string): void {
    this.toolCount++;
    this.tools.push(short(line, 140));
  }

  /** 有变化返回新的内容，没变化返回 undefined */
  feed(e: HarnessEvent): string | undefined {
    const before = this.render();
    switch (e.type) {
      case "agent_progress":
        if (e.kind === "text") {
          this.answer += e.line;
          this.status = "✍️ 正在回答…";
        } else if (e.kind === "thinking") this.status = "💭 思考中…";
        else if (e.kind === "tool") {
          this.status = `🔧 ${short(e.line, 80)}`;
          // 外部 Agent 的工具行：「🔧 名字 参数」是一次新调用；「✓ / ✗」是上一次的结果，不另计（失败的记一笔）
          const t = e.line.trim();
          if (t.startsWith("🔧")) this.addTool(t);
          else if (t.startsWith("✗")) this.tools.push(short(`⚠️ ${t}`, 140));
        }
        else if (e.kind === "status") this.status = `⏳ ${short(e.line, 80)}`;
        break;
      case "tool_call":
        this.status = `🔧 调用 ${e.name}`;
        this.addTool(`🔧 ${e.name}`);
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

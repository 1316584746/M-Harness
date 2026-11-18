import type { Runtime } from "../runtime";
import type { Msg } from "../core/types";
import type { IncomingMessage } from "./types";

interface Session {
  history: Msg[];
  provider?: string;
  queue: Promise<void>;
  controller?: AbortController;
}

const HELP = [
  "可用指令：",
  "/models  查看可切换的模型 / Agent",
  "/model <名称>  切换当前会话使用的模型 / Agent",
  "/reset  清空当前会话上下文",
  "/stop  中断正在执行的任务",
  "/help  查看帮助",
  "其余内容会作为任务交给当前模型处理。",
].join("\n");

const MAX_HISTORY = 40;

/** 每个会话一份上下文 + 串行队列 + 独立的模型选择；指令在这里解析 */
export class SessionManager {
  private sessions = new Map<string, Session>();

  constructor(private rt: Runtime, private log: (s: string) => void = console.log) {}

  private get(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) this.sessions.set(id, (s = { history: [], queue: Promise.resolve() }));
    return s;
  }

  handle(msg: IncomingMessage): Promise<void> {
    const s = this.get(msg.conversationId);
    const text = msg.text.trim();

    // 指令即时处理，不排队（/stop 必须能打断正在跑的任务）
    if (text.startsWith("/")) return this.command(s, msg, text);

    s.queue = s.queue.then(() => this.runOne(s, msg)).catch(() => {});
    return s.queue;
  }

  private async command(s: Session, msg: IncomingMessage, text: string) {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();
    let out: string;
    switch (cmd.toLowerCase()) {
      case "/help":
        out = HELP;
        break;
      case "/models": {
        const cur = s.provider ?? this.rt.config.defaultProvider;
        out = this.rt.registry
          .names()
          .map(n => `${n === cur ? "👉" : "  "} ${n} — ${this.rt.registry.describe(n)}`)
          .join("\n");
        break;
      }
      case "/model":
        if (!arg) out = `当前：${s.provider ?? this.rt.config.defaultProvider}`;
        else if (!this.rt.registry.has(arg)) out = `没有名为 ${arg} 的模型，发送 /models 查看可用列表`;
        else {
          s.provider = arg;
          out = `已切换到 ${arg}（${this.rt.registry.describe(arg)}）`;
        }
        break;
      case "/reset":
        s.history = [];
        out = "已清空上下文。";
        break;
      case "/stop":
        if (s.controller) {
          s.controller.abort();
          out = "已发送中断。";
        } else out = "当前没有正在执行的任务。";
        break;
      default:
        out = `未知指令 ${cmd}\n\n${HELP}`;
    }
    await this.safeReply(msg, out);
  }

  private async runOne(s: Session, msg: IncomingMessage) {
    const provider = s.provider ?? this.rt.config.defaultProvider;
    s.controller = new AbortController();
    try {
      const r = await this.rt.runTask({
        input: msg.text,
        provider,
        history: s.history,
        mode: "channel",
        signal: s.controller.signal,
      });
      this.log(`[${msg.channel}] ${msg.userId} → ${provider} ${r.reason} steps=${r.steps} tok=${r.tokens} trace=${r.traceFile}`);
      if (r.reason === "final" || r.reason === "max_steps") s.history = r.messages.slice(-MAX_HISTORY);
      const body =
        r.reason === "final"
          ? r.text || "（模型没有返回内容）"
          : `任务未完成：${r.error ?? r.reason}${r.text ? "\n" + r.text : ""}`;
      await this.safeReply(msg, body);
    } catch (e: any) {
      this.log(`[${msg.channel}] 运行异常：${e?.message ?? e}`);
      await this.safeReply(msg, `出错了：${e?.message ?? e}`);
    } finally {
      s.controller = undefined;
    }
  }

  private async safeReply(msg: IncomingMessage, text: string) {
    try {
      await msg.reply(text);
    } catch (e: any) {
      this.log(`[${msg.channel}] 回复失败：${e?.message ?? e}`);
    }
  }
}

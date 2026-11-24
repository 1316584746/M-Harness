import type { Runtime } from "../runtime";
import type { Msg } from "../core/types";
import type { IncomingMessage } from "./types";
import type { CardAction } from "./cards";
import { ApprovalGate, approvalPrompt, groupSystem, replyBody, replyModeOf, type GroupResolver } from "./group-task";
import { ProgressText } from "./stream";

interface Session {
  history: Msg[];
  provider?: string;
  queue: Promise<void>;
  controller?: AbortController;
  /** 下一轮开全新的外部 Agent 会话（/reset 之后） */
  fresh?: boolean;
  /** 上一轮这个群绑定的任务 id（没绑定 = 空串；还没跑过 = undefined）：换绑到别的需求就清掉上下文，免得串到上一个需求 */
  bound?: string;
  /** 正在跑 + 排队中的消息数 */
  waiting: number;
  /** 各发送人排队中的消息数（访客限额用） */
  bySender: Map<string, number>;
}

/** 访客在一个会话里最多同时排几条；排队超过多久就作废 */
const MAX_QUEUED_PER_GUEST = 2;
const QUEUE_EXPIRE_MS = 30 * 60_000;

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

  constructor(
    private rt: Runtime,
    private log: (s: string) => void = console.log,
    /** 需求群 ⇄ 任务：群绑定了任务就按这个需求答、能查关联仓库的代码 */
    private groups?: GroupResolver,
    private gate = new ApprovalGate(),
  ) {}

  private get(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) this.sessions.set(id, (s = { history: [], queue: Promise.resolve(), waiting: 0, bySender: new Map() }));
    return s;
  }

  handle(msg: IncomingMessage): Promise<void> {
    const s = this.get(msg.conversationId);
    const text = msg.text.trim();

    // 正在等主人确认某个改动：这条是「确认 / 取消」的话直接处理，不排队（任务正卡在等它）
    if (this.gate.tryResolve(msg.conversationId, msg.userId, text)) return Promise.resolve();

    // 指令即时处理，不排队（/stop 必须能打断正在跑的任务）
    if (text.startsWith("/")) return this.command(s, msg, text);

    void msg.react?.("Get"); // 先应答「收到了」（排队时也立刻有反应），做完再点 DONE
    // 前面还有活没干完：告诉对方在排队（访客每人最多排 2 条，排太久的作废），别让人以为没收到
    if (s.waiting > 0) {
      const mine = s.bySender.get(msg.userId) ?? 0;
      if (msg.guest && mine >= MAX_QUEUED_PER_GUEST) {
        void this.safeReply(msg, `你前面已经有 ${mine} 个问题在排队了，等答完再问吧。`);
        return Promise.resolve();
      }
      void this.safeReply(msg, `收到，在排队了：前面还有 ${s.waiting} 个，答完就答你。`);
    }
    const at = Date.now();
    s.waiting++;
    s.bySender.set(msg.userId, (s.bySender.get(msg.userId) ?? 0) + 1);
    s.queue = s.queue
      .then(async () => {
        if (Date.now() - at > QUEUE_EXPIRE_MS) {
          await this.safeReply(msg, "久等了，排队太久已作废，麻烦重新问一次。");
          return;
        }
        await this.runOne(s, msg);
      })
      .catch(() => {})
      .finally(() => {
        s.waiting--;
        const n = (s.bySender.get(msg.userId) ?? 1) - 1;
        if (n > 0) s.bySender.set(msg.userId, n);
        else s.bySender.delete(msg.userId);
      });
    return s.queue;
  }

  /** 点了卡片上的按钮（目前只有「确认 / 取消」某个待确认的动作） */
  handleAction(a: CardAction): boolean {
    const v = a.value;
    if (v && typeof v === "object" && v.k === "mh-approval" && typeof v.t === "string") return this.gate.resolveToken(v.t, a.operator, v.v === "yes");
    return false;
  }

  private notified = new Map<string, number>();

  private async command(s: Session, msg: IncomingMessage, text: string) {
    const [cmd, ...rest] = text.split(/\s+/);
    const arg = rest.join(" ").trim();
    let out: string;
    // 群里的访客只能看帮助和模型列表；切模型 / 清上下文 / 中断任务只有机器人的主人能做
    if (msg.guest && !["/help", "/models"].includes(cmd.toLowerCase())) {
      return this.safeReply(msg, "这个指令只有机器人的主人能用。直接 @我 提问就行，发 /help 看帮助。");
    }
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
        s.fresh = true; // 外部 Agent 也开全新上下文
        out = "已清空上下文。";
        break;
      case "/stop": {
        // 群里的任务可能是交给任务对话在跑的（不在这里的 controller 里），也要能中断
        const stopped = msg.chatId ? !!this.groups?.stop?.(msg.chatId) : false;
        if (s.controller || stopped) {
          this.gate.cancel(msg.conversationId);
          s.controller?.abort();
          out = "已发送中断。";
        } else out = "当前没有正在执行的任务。";
        break;
      }
      default:
        out = `未知指令 ${cmd}\n\n${HELP}`;
    }
    await this.safeReply(msg, out);
  }

  private async runOne(s: Session, msg: IncomingMessage) {
    let provider = s.provider ?? this.rt.config.defaultProvider;
    if (msg.guest) {
      // 外部 Agent 不受只读护栏约束，不能给群里的访客用
      const g = this.rt.guestProvider(provider);
      if (!g) {
        await this.safeReply(msg, "群里提问需要一个「模型」类的 provider（外部 Agent 无法限制只读），目前没有可用的，请联系机器人的主人。");
        return;
      }
      provider = g;
    }
    // 群绑定了需求任务：按这个需求答，工作区用关联仓库；主人改代码走「群里回复确认」，访客只读
    const bind = msg.isGroup && msg.chatId ? this.groups?.binding(msg.chatId) : undefined;
    const repoPath = bind ? bind.repos.map(n => this.groups?.repoPath(n)).find((p): p is string => !!p) : undefined;
    const ownerInTaskGroup = !!bind && !msg.guest;
    // 这个群同时绑了好几个任务：群里的提问只会进第一个，说一声（每个群半小时最多提示一次）
    const sib = bind && msg.chatId ? this.groups?.siblings?.(msg.chatId) ?? [] : [];
    if (bind && msg.chatId && sib.length > 1 && Date.now() - (this.notified.get(msg.chatId) ?? 0) > 30 * 60_000) {
      this.notified.set(msg.chatId, Date.now());
      void this.safeReply(msg, `这个群同时绑定了 ${sib.length} 个任务（${sib.slice(0, 4).map(t => `「${t}」`).join("")}${sib.length > 4 ? "等" : ""}），群里的 @ 只会进第一个——这条进了「${bind.title}」。想让群只对应一个任务，请到其它任务的「需求群」弹窗取消关联或换绑。`);
    }
    // 绑定了需求的群：按任务里选的回复方式（跟随全局 → 看全局设置）决定是边做边改同一条消息，还是做完整条发
    // 群主在绑定了需求的群里说话：优先交给这个任务自己的对话（带任务完整的上下文 / 产物 / 工具），结果由桌面端发回群里；接不了才在这里答
    if (bind && ownerInTaskGroup && this.groups?.dispatch && (await this.groups.dispatch(bind, msg).catch(() => false))) return;
    const mode = bind ? replyModeOf(bind, this.groups?.defaultReply?.()) : "whole";
    const stream = mode === "stream" && msg.stream ? await msg.stream().catch(() => undefined) : undefined;
    const prog = stream ? new ProgressText() : undefined;
    const boundId = bind?.taskId ?? "";
    if (s.bound !== undefined && s.bound !== boundId) {
      s.history = [];
      s.fresh = true;
    }
    s.bound = boundId;
    s.controller = new AbortController();
    const fresh = s.fresh;
    s.fresh = false;
    try {
      const r = await this.rt.runTask({
        input: bind && msg.guest ? `【群成员提问】${msg.text}` : msg.text,
        ...(msg.images?.length ? { images: msg.images } : {}),
        provider,
        history: s.history,
        // 主人在绑定了需求的群里：按配置里的护栏走（写 / 执行要问），问就在群里问；其余一律办公通道的只读
        mode: ownerInTaskGroup ? "local" : "channel",
        ...(ownerInTaskGroup ? { approve: (q: { tool: { name: string }; args: unknown; reason: string }) => this.gate.ask(msg.conversationId, msg.userId, approvalPrompt(q), t => msg.reply(t), msg.approvalCard) } : {}),
        ...(bind ? { system: groupSystem(bind, !!msg.guest, this.rt.config.system), ...(repoPath ? { workspace: repoPath } : {}) } : {}),
        guest: msg.guest,
        ...(stream && prog ? { emit: e => { const t = prog.feed(e); if (t) stream.update(t); } } : {}),
        // 同一个会话续接同一个外部 Agent：不用每条消息都重新创建（创建 + 提交要好几秒），它也记得之前聊过什么
        // 会话标识 = 哪个群 + 绑定的哪个需求 + 是否访客：不同群、不同需求、主人和访客互不串
        sessionKey: `${msg.conversationId}${bind ? `#${bind.taskId}` : ""}${msg.guest ? ":guest" : ""}`,
        freshSession: fresh,
        signal: s.controller.signal,
      });
      this.log(`[${msg.channel}] ${msg.userId} → ${provider} ${r.reason} steps=${r.steps} tok=${r.tokens} trace=${r.traceFile}`);
      if (r.reason === "final" || r.reason === "max_steps") s.history = r.messages.slice(-MAX_HISTORY);
      const body = replyBody(r);
      if (stream) await stream.finish(body, r.reason !== "final").catch(e => this.log(`[${msg.channel}] 回复失败：${e?.message ?? e}`));
      else await this.safeReply(msg, body);
      if (r.reason === "final") await msg.react?.("DONE");
    } catch (e: any) {
      this.log(`[${msg.channel}] 运行异常：${e?.message ?? e}`);
      const err = `出错了：${e?.message ?? e}`;
      if (stream) await stream.finish(err, true).catch(() => {});
      else await this.safeReply(msg, err);
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

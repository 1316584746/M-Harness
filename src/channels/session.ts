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
  /** 用 /任务 选定的任务：选定后这个会话里的所有对话都交给这个任务，直到 /退出 */
  focus?: { taskId: string; title: string };
  /** 刚列出来、等着回复编号的任务清单（10 分钟内回复数字有效） */
  picking?: { ids: string[]; at: number };
  /** 各发送人排队中的消息数（访客限额用） */
  bySender: Map<string, number>;
}

/** 访客在一个会话里最多同时排几条；排队超过多久就作废 */
const MAX_QUEUED_PER_GUEST = 2;
const QUEUE_EXPIRE_MS = 30 * 60_000;
const PICK_EXPIRE_MS = 10 * 60_000;
/** /任务 清单最多列这么多项，多的用关键字搜 */
const MAX_LIST = 20;

const HELP = [
  "可用指令：",
  "/models  查看可切换的模型 / Agent",
  "/model <名称>  切换当前会话使用的模型 / Agent",
  "/reset  清空当前会话上下文",
  "/stop  中断正在执行的任务",
  "任务（或 /任务）  列出桌面端里进行中的任务，回复编号选定；选定后所有对话都围绕这个任务（/任务 关键字 可搜索）",
  "退出  结束当前选定的任务，回到普通对话（也可以发 退出任务 或 /退出）",
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
    // 中文输入法常打出全角斜杠「／任务」，按半角处理
    let text = msg.text.trim().replace(/^／/, "/");
    // 不带斜杠也认：整条消息就是「任务」「我的任务」「任务 3」→ /任务；选定任务期间整条是「退出」「退出任务」→ /退出。
    // 只认整条消息等于这几个词，免得把正常提问（比如「任务进度怎么样」）当成指令
    if (!msg.guest) {
      const n = /^任务\s*(\d{1,3})$/.exec(text);
      if (/^(任务|任务列表|任务清单|我的任务)$/.test(text)) text = "/任务";
      else if (n) text = `/任务 ${n[1]}`;
      else if (/^退出任务$/.test(text) || (s.focus && /^退出$/.test(text))) text = "/退出";
    }

    // 正在等主人确认某个改动：这条是「确认 / 取消」的话直接处理，不排队（任务正卡在等它）
    if (this.gate.tryResolve(msg.conversationId, msg.userId, text)) return Promise.resolve();

    // 指令即时处理，不排队（/stop 必须能打断正在跑的任务）
    if (text.startsWith("/")) return this.command(s, msg, text);

    // 刚列出任务清单：回复一个数字 = 选这一项（10 分钟内有效）
    if (!msg.guest && s.picking && /^\d{1,3}$/.test(text)) {
      if (Date.now() - s.picking.at <= PICK_EXPIRE_MS) return this.pick(s, msg, Number(text));
      s.picking = undefined;
    }
    s.picking = undefined; // 回的不是编号，这份清单作废
    // 选定了任务：这个会话里的话都交给它（群里已经绑了需求的，仍按群绑定的需求走）
    if (s.focus && !msg.guest && !(msg.isGroup && msg.chatId && this.groups?.binding(msg.chatId))) return this.focusRun(s, msg);

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
      case "/任务":
      case "/任务列表":
      case "/task":
      case "/tasks":
        out = this.tasksCommand(s, msg, arg);
        break;
      case "/退出":
      case "/退出任务":
      case "/exit":
      case "/quit":
        if (s.focus) {
          out = `已退出任务「${s.focus.title}」，回到普通对话。想再选任务发「任务」。`;
          s.focus = undefined;
        } else out = "当前没有选定任务。发「任务」可以看任务列表。";
        s.picking = undefined;
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

  /** 编号清单文本；当前选定的任务前面打 👉 */
  private listText(s: Session, shown: { taskId: string; title: string; repos: string[] }[], total: number, head: string): string {
    s.picking = { ids: shown.map(t => t.taskId), at: Date.now() };
    const lines = shown.map((t, i) => `${s.focus?.taskId === t.taskId ? "👉" : "  "}${i + 1}. ${t.title}${t.repos.length ? `（${t.repos.slice(0, 2).join("、")}${t.repos.length > 2 ? "等" : ""}）` : ""}`);
    const more = total > shown.length ? `\n还有 ${total - shown.length} 个没列出，发「/任务 关键字」搜索。` : "";
    return `${head}\n${lines.join("\n")}${more}\n\n回复编号选定任务；选定后你在这里说的话都交给它处理，发「退出」结束。`;
  }

  /** /任务：不带参数 = 列清单；带数字 = 选这一项；带文字 = 按标题搜 */
  private tasksCommand(s: Session, msg: IncomingMessage, arg: string): string {
    const bind = msg.isGroup && msg.chatId ? this.groups?.binding(msg.chatId) : undefined;
    if (bind) return `这个群已经绑定了任务「${bind.title}」，群里的对话本来就围绕它。想切换任务，请到和机器人的单聊里发「任务」。`;
    const all = this.groups?.tasks?.() ?? [];
    if (!all.length) return "桌面端里还没有进行中的任务。（M-Harness 窗口要开着，任务才会同步过来。）";
    if (/^\d{1,3}$/.test(arg)) return this.select(s, Number(arg));
    if (arg) {
      const kw = arg.toLowerCase();
      const hit = all.filter(t => t.title.toLowerCase().includes(kw));
      if (!hit.length) return `没有标题里带「${arg}」的任务。发「任务」看全部。`;
      if (hit.length === 1) return this.choose(s, hit[0]);
      return this.listText(s, hit.slice(0, MAX_LIST), hit.length, `标题里带「${arg}」的任务有 ${hit.length} 个：`);
    }
    return this.listText(s, all.slice(0, MAX_LIST), all.length, `进行中的任务共 ${all.length} 个（最近更新的在前）：`);
  }

  /** 按编号选：优先用刚列出来的那份清单，没有就按当前全部任务的顺序 */
  private select(s: Session, n: number): string {
    const all = this.groups?.tasks?.() ?? [];
    const ids = s.picking && Date.now() - s.picking.at <= PICK_EXPIRE_MS ? s.picking.ids : all.slice(0, MAX_LIST).map(t => t.taskId);
    const t = n >= 1 && n <= ids.length ? all.find(x => x.taskId === ids[n - 1]) : undefined;
    if (!t) return n >= 1 && n <= ids.length ? "这个任务已经不在进行中的任务里了，发「任务」重新看清单。" : `没有第 ${n} 项，发「任务」看清单。`;
    return this.choose(s, t);
  }

  private choose(s: Session, t: { taskId: string; title: string }): string {
    s.focus = { taskId: t.taskId, title: t.title };
    s.picking = undefined;
    return `已选定任务「${t.title}」。接下来你在这里说的话都会交给这个任务处理（带它的需求、产物和上下文），发 /stop 可以中断正在跑的，发「退出」结束。`;
  }

  private pick(s: Session, msg: IncomingMessage, n: number): Promise<void> {
    return this.safeReply(msg, this.select(s, n));
  }

  /** 选定了任务：这条话交给桌面端里这个任务自己的对话去跑，过程和结果由桌面端发回来 */
  private async focusRun(s: Session, msg: IncomingMessage): Promise<void> {
    const f = s.focus!;
    const b = this.groups?.tasks?.().find(t => t.taskId === f.taskId);
    if (!b) {
      s.focus = undefined;
      return this.safeReply(msg, `任务「${f.title}」已经不在进行中了（完成或删除了），已退出。发「任务」重新选。`);
    }
    void msg.react?.("Get");
    const ok = await (this.groups?.dispatch?.({ ...b, groupId: msg.chatId ?? "" }, msg) ?? Promise.resolve(false)).catch(() => false);
    if (!ok) await this.safeReply(msg, `没能交给任务「${f.title}」：M-Harness 窗口要开着、任务也要还在。稍后再试，或发「退出」结束。`);
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
    // 卡片上要展示的：任务名当标题、被问的问题、模型名（工具清单随运行过程更新）
    const model = this.rt.registry.modelOf(provider);
    const stream = mode === "stream" && msg.stream ? await msg.stream({ ...(bind?.title ? { title: bind.title } : {}), question: msg.text, ...(model ? { model } : {}) }).catch(() => undefined) : undefined;
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
        ...(stream && prog ? { emit: e => { const t = prog.feed(e); stream.setMeta?.(prog.meta()); if (t) stream.update(t); } } : {}),
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

/**
 * 需求群 ⇄ 任务：群绑定了一个任务（需求）后，群里的提问按这个需求来答，能查关联仓库的代码；
 * 机器人主人在群里让改代码时，每个写文件 / 执行命令的动作要主人在群里回复「确认」才执行。
 */

import type { IncomingMessage } from "./types";

/** 一个已绑定需求群的任务（由桌面端把任务和群的关系同步给主进程） */
export interface TaskGroupBinding {
  /** 飞书群 id（oc_ 开头） */
  groupId: string;
  taskId: string;
  title: string;
  /** 发给 AI 的任务说明：需求、链接、关联仓库、任务上下文 */
  briefing: string;
  /** 关联的仓库名（配置里 repos 的名字），第一个作为工作区 */
  repos: string[];
  /** 群里 AI 的回复方式：global = 跟随全局设置 */
  reply?: "global" | "stream" | "whole";
}

export interface GroupResolver {
  binding(chatId: string): TaskGroupBinding | undefined;
  /** 仓库名 → 本机路径 */
  repoPath(name: string): string | undefined;
  /** 全局默认的回复方式（任务里选「跟随全局」时用）；不提供按 stream */
  defaultReply?(): "stream" | "whole";
  /**
   * 群主在绑定了需求的群里说话：交给这个任务自己的对话去处理（带任务完整上下文，结果由调用方发回群里）。
   * 返回 true = 已接手；false = 接不了（界面没开 / 任务不在了），由会话自己在主进程里答
   */
  dispatch?(b: TaskGroupBinding, msg: IncomingMessage): Promise<boolean>;
  /** 这个群绑定的所有任务标题（绑了不止一个时，群里的提问只会进第一个，要告诉大家） */
  siblings?(chatId: string): string[];
  /** 群主在群里发 /stop：中断这个群正在跑的任务；返回有没有东西被中断 */
  stop?(chatId: string): boolean;
}

/** 这个群这一轮该怎么回：任务里选了流式 / 整条就按任务的，选「跟随全局」看全局默认（不写 = 流式） */
export function replyModeOf(b: TaskGroupBinding, def?: "stream" | "whole"): "stream" | "whole" {
  return b.reply && b.reply !== "global" ? b.reply : def ?? "stream";
}

/** 运行结果 → 发到群里的文字 */
export function replyBody(r: { reason: string; text?: string; error?: string }): string {
  if (r.reason === "aborted") return `已中断。${r.text ? "\n" + r.text : ""}`;
  return r.reason === "final" ? r.text || "（模型没有返回内容）" : `任务未完成：${r.error ?? r.reason}${r.text ? "\n" + r.text : ""}`;
}

/** 群里这一轮的系统提示：围绕绑定的需求回答；访客只读，主人改动要确认 */
export function groupSystem(b: TaskGroupBinding, guest: boolean, base?: string): string {
  const rules = [
    "你现在在飞书需求群里，这个群绑定了下面这个需求任务。群成员的提问请围绕它回答。",
    b.briefing,
    "回答规则：",
    "- 简短直接，适合在群里读；提到代码时给出 仓库/路径:行号。",
    "- 查代码只用上面关联的仓库；查不到就明确说「没查到」，不要编。",
    guest
      ? "- 现在提问的是群成员：你只能读，不能改文件、不能执行命令；对方要你改代码时，告诉他需要机器人的主人来发起。"
      : "- 现在说话的是机器人的主人：要改代码时，先用一两句话说清楚要改什么，再动手；每个写文件 / 执行命令的动作都会让主人在群里回复「确认」后才执行，被取消就不要再重试同一个动作。",
  ];
  return [base, rules.join("\n")].filter(Boolean).join("\n\n");
}

const YES = /^(确认|确定|同意|执行|好|好的|是|可以|y|yes|ok)[!！。.\s]*$/i;
const NO = /^(取消|拒绝|不用|不要|否|不|算了|n|no)[!！。.\s]*$/i;

/** 把一句回复判成 确认 / 取消 / 都不是 */
export function parseVerdict(text: string): "yes" | "no" | undefined {
  const t = text.trim();
  if (YES.test(t)) return "yes";
  if (NO.test(t)) return "no";
  return undefined;
}

interface Pending {
  owner: string;
  token: string;
  resolve: (ok: boolean) => void;
  timer: NodeJS.Timeout;
  /** 确认卡片（有的话）：结果出来后把按钮换成结论 */
  settle?: (verdict: "yes" | "no" | "timeout", by?: string) => void;
}

/** 确认请求的卡片形式：open 发出带按钮的卡片，返回「把卡片改成结论」的函数；发不出来返回 undefined（退回文字提示） */
export interface ApprovalCardIO {
  open(token: string, prompt: string): Promise<((verdict: "yes" | "no" | "timeout", by?: string) => void) | undefined>;
}

let tokenSeq = 0;

/** 在飞书里用「点按钮 / 回复 确认、取消」代替桌面端的审批弹窗；一个会话同一时间只挂一个待确认的动作 */
export class ApprovalGate {
  private pending = new Map<string, Pending>();

  constructor(private timeoutMs = 120_000) {}

  private finish(conv: string, p: Pending, verdict: "yes" | "no" | "timeout", by?: string) {
    if (this.pending.get(conv) !== p) return;
    clearTimeout(p.timer);
    this.pending.delete(conv);
    try {
      p.settle?.(verdict, by);
    } catch {
      /* 改卡片失败不影响结果 */
    }
    p.resolve(verdict === "yes");
  }

  /** 发出确认请求并等主人回复（点卡片按钮或回复文字）；超时按取消 */
  ask(conv: string, owner: string, prompt: string, send: (text: string) => Promise<void>, card?: ApprovalCardIO): Promise<boolean> {
    this.cancel(conv); // 前一个还没回的，作废
    return new Promise<boolean>(resolve => {
      const token = `a${Date.now().toString(36)}${++tokenSeq}`;
      const p: Pending = { owner, token, resolve, timer: undefined as unknown as NodeJS.Timeout };
      p.timer = setTimeout(() => {
        const hadCard = !!p.settle;
        this.finish(conv, p, "timeout");
        if (!hadCard) void send("⏱ 2 分钟没收到回复，按「取消」处理。").catch(() => {});
      }, this.timeoutMs);
      p.timer.unref?.();
      this.pending.set(conv, p);
      const text = () =>
        void send(prompt).catch(() => {
          // 提示都发不出去，主人根本看不到：别干等，按取消
          this.cancel(conv);
        });
      if (!card) return text();
      card
        .open(token, prompt)
        .then(settle => {
          if (this.pending.get(conv) !== p) return settle?.("no"); // 等卡片发出来的这会儿已经有结果了
          if (settle) p.settle = settle;
          else text();
        })
        .catch(() => this.pending.get(conv) === p && text());
    });
  }

  has(conv: string): boolean {
    return this.pending.has(conv);
  }

  /**
   * 收到消息时先问一下：它是不是对待确认动作的回复？是就吃掉（返回 true，不再当成提问）。
   * 只有发起人的「确认 / 取消」算数；别人在这时说「确认」也吃掉但不生效，免得被当成一条提问。
   */
  tryResolve(conv: string, sender: string, text: string): boolean {
    const p = this.pending.get(conv);
    if (!p) return false;
    const v = parseVerdict(text);
    if (!v) return false;
    if (sender !== p.owner) return true;
    this.finish(conv, p, v);
    return true;
  }

  /** 点了卡片上的按钮：只认发起人；token 对不上（已经过期 / 已处理）返回 false */
  resolveToken(token: string, operator: string, yes: boolean): boolean {
    for (const [conv, p] of this.pending) {
      if (p.token !== token) continue;
      if (p.owner !== operator) return false;
      this.finish(conv, p, yes ? "yes" : "no");
      return true;
    }
    return false;
  }

  /** 作废待确认（按取消处理） */
  cancel(conv: string): void {
    const p = this.pending.get(conv);
    if (p) this.finish(conv, p, "no");
  }
}

/** 给主人看的确认提示 */
export function approvalPrompt(req: { tool: { name: string }; args: unknown; reason: string }): string {
  let args = "";
  try {
    args = JSON.stringify(req.args);
  } catch {
    args = String(req.args);
  }
  if (args.length > 600) args = args.slice(0, 600) + "…";
  return ["⚠️ **需要你确认**", `- 动作：\`${req.tool.name}\``, `- 参数：\`${args}\``, `- 原因：${req.reason}`, "", "回复「确认」执行，回复「取消」跳过（2 分钟没回复按取消）"].join("\n");
}

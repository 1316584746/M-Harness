/** 飞书消息卡片（处理中 / 答案卡是卡片 JSON 2.0，确认卡是经典 JSON 1.0；直接用 `im +messages-reply --msg-type interactive` 发、`PATCH /im/v1/messages/:id` 改） */

import type { CardMeta } from "./stream";

type Template = "blue" | "green" | "orange" | "red" | "grey";

const clip = (s: string, n = 3500) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

function card(title: string, template: Template, elements: unknown[]): string {
  return JSON.stringify({
    config: { wide_screen_mode: true, update_multi: true },
    header: { template, title: { tag: "plain_text", content: title } },
    elements,
  });
}

/** 卡片里的小段文字：去掉会被当成标签的尖括号、换行压成空格、超长截断 */
const oneLine = (s: string, n: number) => {
  const t = s.replace(/[<>]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** 3m36s / 42s */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}

/**
 * 处理过程 / 最终答案卡（卡片 JSON 2.0，因为折叠面板和 markdown 表格只有 2.0 支持）：
 * - 标题 = 任务名，副标题 = 状态；进行中蓝色「处理中…」，做完变绿「已完成」，没做完（失败 / 中断）变红「未完成」
 * - 先引用一行被问的问题，再是折叠的「思考与工具 · N 次工具调用」（进行中展开看实时进度，做完自动收起）
 * - 然后是正文（markdown：表格、行内代码、列表都能渲染）
 * - 底部一行小灰字：耗时 · 模型
 */
export function progressCard(text: string, done = false, failed = false, meta: CardMeta = {}): string {
  const state = failed ? "未完成" : done ? "已完成" : "处理中…";
  const template: Template = failed ? "red" : done ? "green" : "blue";
  const finished = done || failed;
  const md = (content: string, extra: Record<string, unknown> = {}) => ({ tag: "markdown", content, ...extra });
  const title = meta.title ? oneLine(meta.title, 40) : "";
  const elements: unknown[] = [];

  if (meta.question?.trim()) elements.push(md(`<font color='grey'>💬 ${oneLine(meta.question, 200)}</font>`));

  const tools = meta.tools ?? [];
  const n = meta.toolCount ?? tools.length;
  if (n > 0) {
    const hidden = n - tools.filter(t => t.startsWith("🔧")).length;
    const lines = tools.map(t => `\`${t.replace(/[`<>]/g, "'")}\``);
    if (hidden > 0 && tools.length > 0) lines.unshift(`<font color='grey'>（更早的 ${hidden} 次调用已省略）</font>`);
    elements.push({
      tag: "collapsible_panel",
      expanded: !finished,
      header: { title: md(`<font color='grey'>思考与工具 · ${n} 次工具调用</font>`) },
      border: { color: "grey", corner_radius: "6px" },
      vertical_spacing: "4px",
      padding: "4px 8px 4px 8px",
      elements: [md(lines.join("\n") || "…")],
    });
  }

  elements.push(md(clip(text) || "…"));

  if (finished && (meta.ms !== undefined || meta.model)) {
    const foot = [meta.ms !== undefined ? fmtDuration(meta.ms) : "", meta.model ? oneLine(meta.model, 60) : ""].filter(Boolean).join(" · ");
    elements.push(md(`<font color='grey'>${foot}</font>`, { text_size: "notation" }));
  }

  return JSON.stringify({
    schema: "2.0",
    config: { update_multi: true },
    header: {
      template,
      title: { tag: "plain_text", content: title || state },
      ...(title ? { subtitle: { tag: "plain_text", content: state } } : {}),
    },
    body: { elements },
  });
}

export interface ApprovalCardValue {
  k: "mh-approval";
  t: string;
  v: "yes" | "no";
}

/** 需要群主确认的动作：两个按钮（点了由 card.action.trigger 回传），也可以直接回复「确认 / 取消」 */
export function approvalCard(prompt: string, token: string): string {
  const btn = (label: string, v: "yes" | "no", type: "primary" | "danger" | "default"): unknown => ({
    tag: "button",
    text: { tag: "plain_text", content: label },
    type,
    value: { k: "mh-approval", t: token, v } satisfies ApprovalCardValue,
  });
  return card("需要你确认", "orange", [
    { tag: "markdown", content: clip(prompt.replace(/\n*回复「确认」[^\n]*$/, ""), 2500) },
    { tag: "action", actions: [btn("确认执行", "yes", "primary"), btn("取消", "no", "danger")] },
    { tag: "note", elements: [{ tag: "plain_text", content: "也可以直接回复「确认」或「取消」；2 分钟没回复按取消" }] },
  ]);
}

/** 确认结果：按钮去掉，换成结论 */
export function approvalDoneCard(prompt: string, verdict: "yes" | "no" | "timeout", by?: string): string {
  const label = verdict === "yes" ? "✅ 已确认，继续执行" : verdict === "no" ? "🚫 已取消" : "⏱ 超时未回复，按取消处理";
  return card(verdict === "yes" ? "已确认" : "已取消", verdict === "yes" ? "green" : "grey", [
    { tag: "markdown", content: clip(prompt.replace(/\n*回复「确认」[^\n]*$/, ""), 2500) },
    { tag: "markdown", content: `${label}${by ? `（${by}）` : ""}` },
  ]);
}

export interface CardAction {
  operator: string;
  messageId: string;
  chatId?: string;
  value: any;
}

const str = (...v: unknown[]) => v.find((x): x is string => typeof x === "string" && !!x);

/** 解析 `card.action.trigger` 事件（lark-cli 输出的字段名不固定，几种写法都认） */
export function parseCardAction(ev: any): CardAction | undefined {
  if (!ev || typeof ev !== "object") return undefined;
  const e = ev.event && typeof ev.event === "object" ? ev.event : undefined;
  const ctx = e?.context && typeof e.context === "object" ? e.context : undefined;
  const op = (ev.operator && typeof ev.operator === "object" ? ev.operator : undefined) ?? (e?.operator && typeof e.operator === "object" ? e.operator : undefined);
  const operator = str(ev.operator_id, ev.operatorOpenId, op?.open_id, op?.operator_id, op?.user_id);
  const act = (ev.action && typeof ev.action === "object" ? ev.action : undefined) ?? (e?.action && typeof e.action === "object" ? e.action : undefined);
  let value: unknown = "action_value" in ev ? ev.action_value : "actionValue" in ev ? ev.actionValue : act?.value;
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      /* 不是 JSON 就原样 */
    }
  }
  if (!operator || value == null || value === "") return undefined;
  return {
    operator,
    messageId: str(ev.message_id, ev.open_message_id, ctx?.open_message_id, e?.message_id) ?? "",
    chatId: str(ev.chat_id, ev.open_chat_id, e?.chat_id, e?.open_chat_id, ctx?.open_chat_id),
    value,
  };
}

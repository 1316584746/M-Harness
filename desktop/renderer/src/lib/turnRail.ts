/** 只用到对话轮次的这几个字段（chatStore 的 Turn 满足它；单独定义是为了纯函数能脱离界面代码测试） */
export interface RailTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  status?: string;
}

export interface RailItem {
  id: string;
  /** 用户这一问 */
  ask: string;
  /** AI 的回答摘要 */
  reply: string;
}

/** 回答去掉 markdown 记号后截一小段，给悬停卡片用 */
export function plainSnippet(md: string, max = 140): string {
  // 流式输出时每个字都会重算一遍所有轮次的摘要：只看开头一段，免得很长的回答把界面拖慢
  const s = md
    .slice(0, 6000)
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[#>*_~|-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? s.slice(0, max) + "…" : s;
}

/** 每个用户提问一个条目：问题 + 紧跟着的回答摘要 */
export function railItems(turns: RailTurn[]): RailItem[] {
  const out: RailItem[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i]!;
    if (t.role !== "user") continue;
    const a = turns[i + 1]?.role === "assistant" ? turns[i + 1]! : undefined;
    out.push({ id: t.id, ask: plainSnippet(t.text, 80) || "（图片）", reply: a ? plainSnippet(a.text || "", 140) || (a.status === "running" ? "回答中…" : "") : "" });
  }
  return out;
}

/** 当前看到哪一问：最后一个顶部已经滚过（或贴近）视口顶部的提问 */
export function activeIndex(tops: number[], viewTop: number, slack = 80): number {
  let idx = 0;
  for (let i = 0; i < tops.length; i++) if (tops[i]! <= viewTop + slack) idx = i;
  return idx;
}

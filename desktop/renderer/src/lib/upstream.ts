/**
 * 推进动作的「上游产物」：后面的步骤直接拿到前面步骤的完整产物，不用重新翻仓库。
 * 外部 Agent 拿到的「此前对话」只有最近几条、每条截断，产物会被截掉大半，所以这里单独、完整地带上（有上限）。
 */
const UPSTREAM: Record<string, string[]> = {
  plan: ["analysis"],
  build: ["plan"],
  review: ["plan", "build"],
  dev: ["plan", "build"],
  ship: ["plan", "build"],
  release: ["plan", "build"],
};
/** 自定义动作没有固定上游：默认带最新的方案设计 */
const DEFAULT_UP = ["plan"];

export interface UpstreamRound {
  user: { step?: { id: string; name: string } };
  ai?: { status?: string; text?: string };
}

/** 单份产物和总量的上限（字符） */
export const UPSTREAM_CAP = 12_000;
export const UPSTREAM_TOTAL = 24_000;

export function upstreamBlock(rounds: UpstreamRound[], stepId: string, stepName: string): string | undefined {
  const want = UPSTREAM[stepId] ?? (stepId === "analysis" ? [] : DEFAULT_UP);
  const parts: string[] = [];
  let total = 0;
  for (const id of want) {
    const r = [...rounds].reverse().find(x => x.user.step?.id === id && x.user.step.name !== stepName && x.ai?.status === "done" && x.ai.text);
    if (!r) continue;
    let text = r.ai!.text!;
    const left = UPSTREAM_TOTAL - total;
    if (left <= 500) break;
    const cap = Math.min(UPSTREAM_CAP, left);
    if (text.length > cap) text = text.slice(0, cap) + "\n…（已截断，需要后面的内容就自己查）";
    total += text.length;
    parts.push(`### 上游产物：${r.user.step!.name}\n${text}`);
  }
  if (!parts.length) return undefined;
  return ["【上游产物】前面步骤已经产出的结果（完整内容，已经查过的结论直接用，不要重新查一遍）：", "---", parts.join("\n\n---\n\n"), "---"].join("\n");
}

/** 自动推进（Agent 的 advance_next）：核对用户有没有真的授权过，核对不过就不推、让用户手动点 */

/** 连续自动推进的上限（用户手动发一次消息 / 点一次推进后重新计数） */
export const MAX_AUTO_ADVANCE = 3;

/** 对外有副作用的步骤：用户原话里必须点名，光说「继续」「做完」不算 */
const SIDE_EFFECT: Record<string, RegExp> = {
  dev: /联调|推送|直推|push|pr\b|dev\b/i,
  ship: /提测|提交?\s*mr|合并请求|\bmr\b|ship|发给测试/i,
  release: /上线|发布|release/i,
};

const norm = (s: string) => s.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");

export interface AdvanceCheckInput {
  action: string;
  userWords: string;
  /** 用户在本任务里自己输入的话（不含点「推进」按钮套出来的模板） */
  userTexts: string[];
  /** 当前能选的步骤 id */
  stepIds: string[];
  /** 暂时不能选的步骤：id → 原因 */
  blocked: Record<string, string>;
  /** 已经连续自动推进了几步 */
  chain: number;
}

export type AdvanceVerdict = { ok: true } | { ok: false; reason: string };

export function verifyAdvance(i: AdvanceCheckInput): AdvanceVerdict {
  if (i.chain >= MAX_AUTO_ADVANCE) return { ok: false, reason: `已经连续自动推进了 ${MAX_AUTO_ADVANCE} 步，先停下来让你看看` };
  if (!i.stepIds.includes(i.action)) return { ok: false, reason: `没有「${i.action}」这一步` };
  if (i.blocked[i.action]) return { ok: false, reason: i.blocked[i.action]! };
  const words = norm(i.userWords);
  if (words.length < 2) return { ok: false, reason: "AI 没有引用你的原话" };
  if (!i.userTexts.some(t => norm(t).includes(words))) return { ok: false, reason: "AI 引用的话在你的消息里找不到" };
  const need = SIDE_EFFECT[i.action];
  if (need && !need.test(i.userWords)) return { ok: false, reason: `「${i.action}」会对外产生影响，需要你的原话里明确说出来` };
  return { ok: true };
}

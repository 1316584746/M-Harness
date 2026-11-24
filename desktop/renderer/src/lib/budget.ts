/**
 * 只读步骤的「探索预算」：外部 Agent（Cursor）一次最多调多少次工具。
 * 到数就叫停，让它基于已经读到的信息直接写产物（缺的写进「待确认」）。
 * 实测方案设计一轮能调到 70~100 次工具，大部分是重复读同一批文件、反复 grep，token 也是跟着这个涨。
 *
 * 只给不改代码的步骤设（分析 / 方案 / CR / 上线检查）；进行开发、联调、提测要真的动手，不设上限。
 * 自定义动作、自由对话也不设。
 */
export const TOOL_BUDGET: Record<string, number> = {
  analysis: 35,
  plan: 50,
  review: 40,
  release: 35,
};

export const toolBudgetFor = (stepId?: string): number | undefined => (stepId ? TOOL_BUDGET[stepId] : undefined);

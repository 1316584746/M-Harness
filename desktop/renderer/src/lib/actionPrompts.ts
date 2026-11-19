// 自带动作的提示词：写成 markdown 文件放在 src/prompts 里，构建时打进应用。
// 结构参照 Flowship：_shared.md（所有动作共用的规范）+ action-<id>.md（每个动作自己的流程和产物骨架）。
import shared from "../prompts/_shared.md?raw";
import plan from "../prompts/action-plan.md?raw";
import build from "../prompts/action-build.md?raw";
import review from "../prompts/action-review.md?raw";
import dev from "../prompts/action-dev.md?raw";
import ship from "../prompts/action-ship.md?raw";

export const SHARED_PROMPT = shared.trim();

/** 每个动作自己的那份（不含共享规范），key 是动作 id */
export const ACTION_FILES: Record<string, { file: string; body: string }> = {
  plan: { file: "action-plan.md", body: plan.trim() },
  build: { file: "action-build.md", body: build.trim() },
  review: { file: "action-review.md", body: review.trim() },
  dev: { file: "action-dev.md", body: dev.trim() },
  ship: { file: "action-ship.md", body: ship.trim() },
};

/** 实际发给 AI 的完整提示词：共享规范 + 动作本身 */
export function builtinPrompt(id: string): string {
  const a = ACTION_FILES[id];
  return a ? `${SHARED_PROMPT}\n\n---\n\n${a.body}` : "";
}

export interface PromptVars {
  taskTitle?: string;
  taskId?: string;
  repoPath?: string;
}

/** 替换 {{taskTitle}} {{taskId}} {{repoPath}}；没给的变量原样留着 */
export function fillVars(text: string, vars: PromptVars = {}): string {
  return text.replace(/\{\{(taskTitle|taskId|repoPath)\}\}/g, (m, k: keyof PromptVars) => vars[k] ?? m);
}

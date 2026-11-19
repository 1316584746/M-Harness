import { builtinPrompt, fillVars, type PromptVars } from "./actionPrompts";
export interface ActionItem {
  id: string;
  name: string;
  prompt: string;
  description?: string;
  /** 在推进任务 / 输入框「/」菜单里隐藏 */
  hidden?: boolean;
  /** 绑定的技能名：绑了就用「技能 + 产出要求」生成提示词，不再用 prompt */
  skill?: string;
  /** 产出要求（选填）：这一步最后要交什么 */
  output?: string;
  /** 推进输入框里的提示（选填）：告诉使用者该填什么 */
  placeholder?: string;
}

export interface BuiltinStep {
  id: string;
  slug: string;
  name: string;
  description: string;
  prompt: string;
  /** 提示词来自哪个文件 */
  file?: string;
}

/** 通用的几步：软件自带（可以隐藏、调顺序，不能删）。提示词来自 src/prompts/*.md */
export const BUILTIN_STEPS: BuiltinStep[] = [
  { id: "plan", slug: "plan", name: "出方案", description: "读需求扫仓库，出技术方案（不改代码）", prompt: builtinPrompt("plan"), file: "action-plan.md" },
  { id: "build", slug: "build", name: "改代码", description: "按方案或指令改代码并自检", prompt: builtinPrompt("build"), file: "action-build.md" },
  { id: "review", slug: "review", name: "复核", description: "换个视角对账、找问题（不改代码）", prompt: builtinPrompt("review"), file: "action-review.md" },
  { id: "dev", slug: "dev", name: "联调", description: "推改动到联调分支（直推）或生成 PR 链接", prompt: builtinPrompt("dev"), file: "action-dev.md" },
  { id: "ship", slug: "ship", name: "提测", description: "推分支并准备提测 MR（目标是测试分支）", prompt: builtinPrompt("ship"), file: "action-ship.md" },
];

/** 没写指令时，自带动作里的 {{input}} 用这句代替 */
export const EMPTY_INPUT = "（没有额外指令，按上面的流程做。）";
export interface ActionPrefs {
  /** 自带步骤的顺序（id 列表，没列到的排在后面） */
  order?: string[];
  /** 隐藏的自带步骤 id */
  hidden?: string[];
}

type Cfg = Record<string, any> | null | undefined;

/** 自带步骤：按设置里的顺序排好，并标出有没有被隐藏 */
export function builtinSteps(cfg: Cfg): Array<BuiltinStep & { hidden: boolean }> {
  const prefs = (cfg?.actionPrefs ?? {}) as ActionPrefs;
  const order = prefs.order ?? [];
  const rank = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? order.length + BUILTIN_STEPS.findIndex(b => b.id === id) : i;
  };
  return [...BUILTIN_STEPS].sort((a, b) => rank(a.id) - rank(b.id)).map(b => ({ ...b, hidden: (prefs.hidden ?? []).includes(b.id) }));
}

/** 自定义动作（设置 → ACTIONS 里配的），保持设置里的顺序 */
export function customActions(cfg: Cfg): ActionItem[] {
  return ((cfg?.actions ?? []) as ActionItem[]).filter(a => a && a.id && a.name);
}

/** 推进任务 / 「/」菜单里能看到的：没被隐藏的 */
export function visibleSteps(cfg: Cfg): { builtins: BuiltinStep[]; custom: ActionItem[] } {
  return { builtins: builtinSteps(cfg).filter(b => !b.hidden), custom: customActions(cfg).filter(a => !a.hidden) };
}

/** 数组里把第 i 项和相邻项换位置（越界不动） */
export function moveItem<T>(list: T[], i: number, dir: -1 | 1): T[] {
  const j = i + dir;
  if (i < 0 || j < 0 || i >= list.length || j >= list.length) return list;
  const out = [...list];
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** 绑了技能的动作：按「技能 + 产出要求」生成提示词模板（{{input}} 留给你填的指令） */
export function skillTemplate(a: { skill: string; output?: string }): string {
  const out = a.output?.trim();
  return [`请使用技能「${a.skill}」完成这件事：先读取该技能的完整说明，再严格按说明执行。`, out ? `## 产出要求\n\n${out}` : "", "## 本次指令\n\n{{input}}"].filter(Boolean).join("\n\n");
}

/** 动作的提示词模板：绑了技能的用生成的，否则用自己写的 prompt */
export function templateOf(a: { prompt: string; skill?: string; output?: string }): string {
  return a.skill?.trim() ? skillTemplate({ skill: a.skill.trim(), output: a.output }) : a.prompt;
}

/** 把动作的提示词模板和你写的指令合成一条要发出去的话；vars 替换 {{taskTitle}} 等占位符 */
export function composeStep(a: { prompt: string; file?: string; skill?: string; output?: string } | null, input: string, vars: PromptVars = {}): string {
  const text = input.trim();
  if (!a) return text;
  const p = fillVars(templateOf(a).trim(), vars);
  if (!p) return text;
  if (p.includes("{{input}}")) return p.split("{{input}}").join(text || (a.file || a.skill ? EMPTY_INPUT : "")).trim();
  return text ? `${p}\n\n${text}` : p;
}

/** 现在做不了的自带步骤：id → 原因。联调要送到联调分支，关联的仓库里一个都没配就没法做 */
export function blockedSteps(cfg: Cfg, repoNames: string[]): Record<string, string> {
  const repos = (cfg?.repos ?? {}) as Record<string, { branches?: { integration?: string } }>;
  if (!repoNames.length) return { dev: "还没有关联代码仓库，联调不知道往哪个仓库送" };
  if (!repoNames.some(n => repos[n]?.branches?.integration?.trim())) return { dev: "关联的仓库里都没有配联调分支（设置 → 代码仓库 → 分支约定）" };
  return {};
}

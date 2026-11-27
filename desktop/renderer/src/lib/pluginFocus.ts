/**
 * 宿主想让插件界面直接停在某个地方、只看一部分数据（目前只有「上下文洞察」用）：
 *  - focus.tab：打开后切到哪个标签页；focus.hide：要藏掉的界面部分（CSS 选择器）。
 *    通过 init 的 context.focus 告诉插件页面，注入的脚本负责切标签和藏。
 *  - scope：只看这几次运行（一段对话的所有运行）。插件后台那边只会看到这几次运行的 trace，
 *    所以它统计的就是这段对话，不会混进别的对话（见 desktop/main/plugin-scope.ts）。
 */
export type PluginFocus = { tab?: string; hide?: string[] };
export type PluginScope = { key: string; runs: string[] };

/** 对话标识 → 临时目录名可以用的 key */
export const scopeKeyOf = (id: string) => String(id).replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "chat";

/** 一段对话里每一轮的运行 id（旧记录没存运行 id，但存了 trace 文件路径，文件名就是运行 id） */
export function runIdsOf(turns: { runId?: string; traceFile?: string }[]): string[] {
  const out: string[] = [];
  for (const t of turns) {
    const id = t.runId || (t.traceFile ? t.traceFile.replace(/^.*[\\/]/, "").replace(/\.jsonl$/, "") : "");
    if (id && !out.includes(id)) out.push(id);
  }
  return out;
}

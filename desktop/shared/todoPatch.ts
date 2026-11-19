import type { TodoChildDTO, TodoItemDTO } from "./api";

/** 子任务在飞书项目里改过之后，界面和本地缓存里要跟着变的字段 */
export type ChildChange = Partial<Pick<TodoChildDTO, "done" | "start" | "end" | "days">>;

/**
 * 把一个子任务的改动套到待办列表上：只换这一个子任务，需求的起止日期按所有带日期的子项重新算
 * （和读取时 groupFeishu 的算法一致：取各子项日期的并集）。没找到就原样返回。
 */
export function patchChild(items: TodoItemDTO[], wid: string, childId: string, change: ChildChange): TodoItemDTO[] {
  return items.map(t => {
    if (t.id !== wid || !t.children?.some(c => c.id === childId && c.kind === "subtask")) return t;
    const children = t.children.map(c => (c.id === childId && c.kind === "subtask" ? { ...c, ...change } : c));
    const dated = children.filter(c => c.start !== undefined || c.end !== undefined);
    if (!dated.length) return { ...t, children };
    const start = Math.min(...dated.map(c => c.start ?? c.end!));
    const end = Math.max(...dated.map(c => c.end ?? c.start!));
    return { ...t, children, start, end, due: end };
  });
}

/** 首页「今日待办」：从「待办 Todo」插件的数据里挑出今天要关心的事 */

export const TODO_PLUGIN_ID = "com.lwai.todo";

export type TodoKind = "overdue" | "today" | "start" | "doing";

export interface TodoItem {
  id: string;
  title: string;
  priority: "high" | "medium" | "low";
  /** overdue：截止日早于今天；today：今天截止；start：今天开始；doing：已经开始、还没到截止日（进行中） */
  kind: TodoKind;
  /** 截止时间（overdue / today）或开始时间（start），ISO 字符串，原样来自插件 */
  at?: string;
  /** 今天截止的任务，截止时间已经过了 */
  late?: boolean;
  /** 逾期天数（overdue） */
  days?: number;
  group?: string;
  /** 子任务进度 */
  sub?: { done: number; total: number };
}

export interface HomeTodosDTO {
  /** none：没装插件；untrusted：装了但还没确认信任（后台没法运行）；error：读取失败 */
  state: "none" | "untrusted" | "error" | "ok";
  items: TodoItem[];
  error?: string;
}

const RANK = { high: 0, medium: 1, low: 2 } as const;

function dayStart(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function parse(s: unknown): Date | undefined {
  if (typeof s !== "string" || !s) return undefined;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** 没做完、而且今天要关心的：已逾期、今天截止、今天开始、进行中（已开始还没截止）。逾期最前，然后按截止时间，再按优先级 */
export function pickTodayTodos(data: unknown, now: Date = new Date()): TodoItem[] {
  const d = (data && typeof data === "object" ? data : {}) as { tasks?: unknown; groups?: unknown };
  const groups = new Map<string, string>();
  if (Array.isArray(d.groups)) for (const g of d.groups as Array<{ id?: unknown; name?: unknown }>) if (typeof g?.id === "string" && typeof g.name === "string") groups.set(g.id, g.name);
  const today = dayStart(now);
  const out: Array<TodoItem & { sort: number }> = [];
  if (!Array.isArray(d.tasks)) return [];
  for (const t of d.tasks as Array<Record<string, unknown>>) {
    if (!t || typeof t !== "object" || t.done === true || typeof t.title !== "string" || !t.title.trim()) continue;
    const due = parse(t.dueAt);
    const start = parse(t.startAt);
    const pr = t.priority === "high" || t.priority === "low" ? t.priority : "medium";
    const subs = Array.isArray(t.subtasks) ? (t.subtasks as Array<{ done?: unknown }>) : [];
    const base = {
      id: String(t.id ?? `${t.title}-${out.length}`),
      title: t.title.trim().slice(0, 200),
      priority: pr as TodoItem["priority"],
      group: typeof t.groupId === "string" ? groups.get(t.groupId) : undefined,
      sub: subs.length ? { done: subs.filter(s => s?.done === true).length, total: subs.length } : undefined,
    };
    if (due && dayStart(due) < today) {
      out.push({ ...base, kind: "overdue", at: String(t.dueAt), days: Math.round((today - dayStart(due)) / 86_400_000), sort: due.getTime() });
    } else if (due && dayStart(due) === today) {
      out.push({ ...base, kind: "today", at: String(t.dueAt), late: due.getTime() < now.getTime(), sort: due.getTime() });
    } else if (start && dayStart(start) === today) {
      out.push({ ...base, kind: "start", at: String(t.startAt), sort: start.getTime() });
    } else if (start && dayStart(start) < today && (!due || dayStart(due) > today)) {
      // 前几天就开始了、还没到截止日：进行中的事项，每天都该在首页看到
      out.push({ ...base, kind: "doing", ...(due ? { at: String(t.dueAt) } : {}), sort: due ? due.getTime() : Number.MAX_SAFE_INTEGER });
    }
  }
  const order = { overdue: 0, today: 1, start: 2, doing: 3 } as const;
  return out.sort((a, b) => order[a.kind] - order[b.kind] || RANK[a.priority] - RANK[b.priority] || a.sort - b.sort).map(({ sort: _s, ...rest }) => rest);
}

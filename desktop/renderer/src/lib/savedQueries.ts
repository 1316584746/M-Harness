/** 保存下来的 SQL 查询（数据库页左边「查询」里的）。只存在本机界面的 localStorage，不进配置文件 */

export interface SavedQuery {
  id: string;
  connId: string;
  name: string;
  sql: string;
  database?: string;
  schema?: string;
  updated: number;
}

const KEY = "harness.db.queries.v1";
const EVENT = "harness:db-queries-changed";

export function listQueries(): SavedQuery[] {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(v) ? v.filter(q => q && typeof q.id === "string" && typeof q.connId === "string" && typeof q.sql === "string") : [];
  } catch {
    return [];
  }
}

function write(list: SavedQuery[]): void {
  localStorage.setItem(KEY, JSON.stringify(list));
  window.dispatchEvent(new Event(EVENT));
}

/** 新建或按 id 更新；返回保存后的那条 */
export function saveQuery(q: Omit<SavedQuery, "id" | "updated"> & { id?: string }): SavedQuery {
  const list = listQueries();
  const cur = q.id ? list.find(x => x.id === q.id) : undefined;
  const next: SavedQuery = { ...q, id: cur?.id ?? `sq_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, updated: Date.now() };
  write(cur ? list.map(x => (x.id === cur.id ? next : x)) : [...list, next]);
  return next;
}

export function removeQuery(id: string): void {
  write(listQueries().filter(q => q.id !== id));
}

/** 连接删了：它的查询一起清掉 */
export function pruneQueries(connIds: Set<string>): void {
  const list = listQueries();
  const keep = list.filter(q => connIds.has(q.connId));
  if (keep.length !== list.length) write(keep);
}

export const onQueriesChanged = (cb: () => void): (() => void) => {
  window.addEventListener(EVENT, cb);
  return () => window.removeEventListener(EVENT, cb);
};

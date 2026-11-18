import { runDws, type DingtalkProjectConfig } from "./dingtalk-project";
import { runMeegle, type FeishuProjectConfig } from "./feishu-project";

/**
 * 工作台：把飞书项目、钉钉待办里「我的待办」拉到一起展示。
 * 只执行固定的只读命令（mywork todo / todo task list），不经过模型。
 * 两个 CLI 的返回结构没有稳定文档，这里按常见字段名宽松解析。
 */

export interface TodoItem {
  id: string;
  title: string;
  source: "feishu" | "dingtalk";
  /** 截止时间（毫秒时间戳） */
  due?: number;
  overdue?: boolean;
  /** 排期开始 / 结束（当天 0 点的毫秒时间戳；没有排期的待办为空） */
  start?: number;
  end?: number;
  /** 所在节点（飞书项目的「技术排期」之类） */
  node?: string;
  /** 补充信息：状态 / 类型 / 空间 */
  sub?: string;
  url?: string;
  /** 进行中的需求（飞书项目：我名下有进行中的节点 / 子任务） */
  active?: boolean;
  /** 我在这个需求下的节点和子任务 */
  children?: TodoChild[];
}

/** 需求下属于我的一个节点或子任务 */
export interface TodoChild {
  id: string;
  title: string;
  kind: "node" | "subtask";
  /** 子任务所在的节点 */
  parent?: string;
  start?: number;
  end?: number;
  done?: boolean;
  /** 这一项本身正在进行中 */
  active?: boolean;
  /** 人天 */
  days?: number;
  /** 负责人 */
  owner?: string;
}

export interface TodoSource {
  enabled: boolean;
  ok: boolean;
  items: TodoItem[];
  total?: number;
  error?: string;
  /** 当前登录的账号（飞书项目的待办都是这个人的） */
  user?: string;
}

const TITLE_KEYS = ["work_item_name", "workItemName", "subject", "title", "name", "summary", "content"];
const ID_KEYS = ["work_item_id", "workItemId", "taskId", "task_id", "todoId", "id"];
const DUE_KEYS = ["dueTime", "due_time", "due", "deadline", "end_time", "endTime", "planEndTime", "plan_end_time"];
const URL_KEYS = ["url", "link", "detailUrl", "detail_url"];
const LIST_KEYS = ["list", "items", "todoCards", "todos", "tasks", "result", "data", "results"];

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

function pick(o: unknown, keys: string[]): unknown {
  if (!isObj(o)) return undefined;
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return undefined;
}

/** 秒 / 毫秒时间戳或日期字符串 → 毫秒 */
export function toMs(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string" && v.trim()) {
    if (/^\d{9,13}$/.test(v.trim())) return toMs(Number(v.trim()));
    const d = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(v.trim());
    if (d) return new Date(Number(d[1]), Number(d[2]) - 1, Number(d[3])).getTime(); // 纯日期按本地当天 0 点
    const t = Date.parse(v);
    if (Number.isFinite(t)) return t;
  }
  return undefined;
}

/** 在返回值里找「对象数组」：先按常见键名，再广度优先 */
export function findList(json: unknown): Array<Record<string, unknown>> {
  const objs = (a: unknown): a is Array<Record<string, unknown>> => Array.isArray(a) && a.length > 0 && a.every(isObj);
  if (Array.isArray(json)) return objs(json) ? json : [];
  const queue: unknown[] = [json];
  for (let depth = 0; depth < 4 && queue.length; depth++) {
    const next: unknown[] = [];
    for (const node of queue) {
      if (!isObj(node)) continue;
      for (const k of LIST_KEYS) if (objs(node[k])) return node[k] as Array<Record<string, unknown>>;
      for (const v of Object.values(node)) {
        if (objs(v)) return v;
        next.push(v);
      }
    }
    queue.length = 0;
    queue.push(...next);
  }
  return [];
}

export function extractTodos(json: unknown, source: TodoItem["source"], now = Date.now()): TodoItem[] {
  const out: TodoItem[] = [];
  for (const o of findList(json)) {
    const info = pick(o, ["work_item_info", "workItemInfo"]) ?? o;
    const title = pick(info, TITLE_KEYS) ?? pick(o, TITLE_KEYS);
    if (typeof title !== "string" || !title.trim()) continue;
    const id = String(pick(info, ID_KEYS) ?? pick(o, ID_KEYS) ?? title);
    const due = toMs(pick(o, DUE_KEYS) ?? pick(info, DUE_KEYS));
    const state = pick(o, ["state_info"]);
    const subRaw = (isObj(state) ? pick(state, ["end_state_key_name", "state_name", "name"]) : undefined) ?? pick(o, ["project_name", "projectName", "work_item_type_name"]) ?? pick(info, ["work_item_type_name", "work_item_type_key"]);
    const url = pick(o, URL_KEYS) ?? pick(info, URL_KEYS);
    const sch = pick(o, ["schedule"]);
    const start = toMs(isObj(sch) ? pick(sch, ["start_time", "startTime"]) : pick(o, ["startTime", "start_time", "planStartTime", "plan_start_time"]));
    const end = isObj(sch) ? toMs(pick(sch, ["end_time", "endTime"])) : undefined;
    const nodeInfo = pick(o, ["node_info"]);
    const node = isObj(nodeInfo) ? pick(nodeInfo, ["node_name", "name"]) : undefined;
    out.push({
      id,
      title: title.trim(),
      source,
      due,
      start,
      end,
      node: typeof node === "string" ? node : undefined,
      overdue: due !== undefined && due < now ? true : undefined,
      sub: typeof subRaw === "string" ? subRaw : undefined,
      url: typeof url === "string" && /^https?:\/\//.test(url) ? url : undefined,
    });
  }
  return out;
}

export function parseJson(text: string): unknown | null {
  const i = text.search(/[[{]/);
  if (i < 0) return null;
  try {
    return JSON.parse(text.slice(i));
  } catch {
    return null;
  }
}

const sig = () => new AbortController().signal;

/** mywork todo 返回的一行：一个需求下的一个节点 / 一个子任务（我负责的） */
export interface FsRow {
  wid: string;
  title: string;
  project?: string;
  projectKey?: string;
  node?: string;
  nodeKey?: string;
  subId?: string;
  start?: number;
  end?: number;
}

export const rowKey = (r: FsRow) => `${r.wid}|${r.nodeKey ?? ""}|${r.subId ?? ""}`;

export function feishuRows(json: unknown): FsRow[] {
  const out: FsRow[] = [];
  for (const o of findList(json)) {
    const info = pick(o, ["work_item_info", "workItemInfo"]);
    const title = pick(info, TITLE_KEYS);
    const wid = pick(info, ID_KEYS);
    if (typeof title !== "string" || !title.trim() || wid === undefined) continue;
    const sch = pick(o, ["schedule"]);
    const node = pick(pick(o, ["node_info"]), ["node_name", "name"]);
    const nodeKey = pick(pick(o, ["node_info"]), ["node_state_key"]);
    const sub = pick(pick(o, ["sub_task_info"]), ["id"]);
    const pk = pick(o, ["project_key"]);
    const pn = pick(o, ["project_name", "projectName"]);
    out.push({
      wid: String(wid),
      title: title.trim(),
      project: typeof pn === "string" ? pn : undefined,
      projectKey: typeof pk === "string" ? pk : undefined,
      node: typeof node === "string" ? node : undefined,
      nodeKey: typeof nodeKey === "string" ? nodeKey : undefined,
      subId: sub === undefined ? undefined : String(sub),
      start: toMs(isObj(sch) ? pick(sch, ["start_time", "startTime"]) : undefined),
      end: toMs(isObj(sch) ? pick(sch, ["end_time", "endTime"]) : undefined),
    });
  }
  return out;
}

/** 子任务的名字 / 所属节点（来自 workflow get-node，mywork 里子任务没有名字） */
export interface SubInfo {
  name: string;
  wid?: string;
  parent?: string;
  start?: number;
  end?: number;
  done?: boolean;
  /** 人天 */
  days?: number;
  /** 负责人的 user_key */
  owners?: string[];
}

/**
 * 把 mywork 的行按「需求」聚合：
 * - 同一个需求只出现一次，我负责的节点 / 子任务放在 children 里
 * - 需求的起止日期取各子项日期的并集
 * - active：我在 in_progress 范围里有行的需求
 */
export function groupFeishu(all: FsRow[], active: FsRow[], overdue: FsRow[], subs: Map<string, SubInfo>, me: { key?: string; name?: string } = {}): TodoItem[] {
  const activeKeys = new Set(active.map(rowKey));
  const overdueWids = new Set(overdue.map(r => r.wid));
  const rows = new Map<string, FsRow>();
  for (const r of [...all, ...active, ...overdue]) if (!rows.has(rowKey(r))) rows.set(rowKey(r), r);
  const byWid = new Map<string, FsRow[]>();
  for (const r of rows.values()) byWid.set(r.wid, [...(byWid.get(r.wid) ?? []), r]);

  const out: TodoItem[] = [];
  for (const [wid, rs] of byWid) {
    const children: TodoChild[] = [];
    let start: number | undefined;
    let end: number | undefined;
    const span = (a?: number, b?: number) => {
      const lo = a ?? b;
      const hi = b ?? a;
      if (lo !== undefined) start = start === undefined ? lo : Math.min(start, lo);
      if (hi !== undefined) end = end === undefined ? hi : Math.max(end, hi);
    };
    for (const r of rs) {
      const act = activeKeys.has(rowKey(r)) || undefined;
      if (r.subId) {
        const s = subs.get(r.subId);
        const c: TodoChild = { id: r.subId, title: s?.name || "子任务", kind: "subtask", parent: s?.parent, start: s?.start ?? r.start, end: s?.end ?? r.end, done: s?.done, active: act, days: s?.days, owner: me.name };
        children.push(c);
        span(c.start, c.end);
      } else if (r.node) {
        children.push({ id: r.nodeKey ?? r.node, title: r.node, kind: "node", start: r.start, end: r.end, active: act });
        span(r.start, r.end);
      } else span(r.start, r.end);
    }
    // mywork 只列没做完的；我名下已经做完的子任务也要看到（来自 get-node）
    if (me.key) {
      const have = new Set(children.map(c => c.id));
      for (const [id, s] of subs) {
        if (s.wid !== wid || have.has(id) || !s.owners?.includes(me.key)) continue;
        const c: TodoChild = { id, title: s.name, kind: "subtask", parent: s.parent, start: s.start, end: s.end, done: s.done, days: s.days, owner: me.name };
        children.push(c);
        span(c.start, c.end);
      }
    }
    children.sort((a, b) => (a.kind === b.kind ? (a.start ?? Infinity) - (b.start ?? Infinity) : a.kind === "node" ? -1 : 1));
    const first = rs[0];
    const isActive = rs.some(r => activeKeys.has(rowKey(r)));
    const nodeChild = children.find(c => c.kind === "node" && c.active) ?? children.find(c => c.kind === "node");
    const subChild = children.find(c => c.kind === "subtask" && c.parent);
    out.push({
      id: wid,
      title: first.title,
      source: "feishu",
      start,
      end,
      due: end,
      node: nodeChild?.title ?? subChild?.parent,
      overdue: overdueWids.has(wid) ? true : undefined,
      sub: first.project,
      active: isActive || undefined,
      children: children.length ? children : undefined,
    });
  }
  return out;
}

const subCache = new Map<string, { at: number; subs: Map<string, SubInfo> }>();
const SUB_TTL = 3 * 60_000;

/** 读一个需求的全部节点，取出子任务的名字（失败就返回空，界面显示「子任务」） */
async function fetchSubs(cfg: FeishuProjectConfig, wid: string, projectKey: string | undefined): Promise<Map<string, SubInfo>> {
  const hit = subCache.get(wid);
  if (hit && Date.now() - hit.at < SUB_TTL) return hit.subs;
  const subs = new Map<string, SubInfo>();
  let ok = false;
  for (let page = 1; page <= 3; page++) {
    const text = await runMeegle(cfg, ["workflow", "get-node", ...(projectKey ? [`--project-key=${projectKey}`] : []), `--work-item-id=${wid}`, "--need-sub-task", `--page-num=${page}`, "--format=json"], sig());
    const j = parseJson(text);
    if (!isObj(j) || !Array.isArray(j.list)) break;
    ok = true;
    for (const n of j.list) {
      if (!isObj(n) || !Array.isArray(n.sub_tasks)) continue;
      const parent = pick(n.basic, ["name"]);
      for (const s of n.sub_tasks) {
        const id = pick(s, ["sub_task_id"]);
        const name = pick(s, ["sub_task_name"]);
        if (id === undefined || typeof name !== "string") continue;
        const pts = pick(s, ["points"]);
        let owners: string[] = [];
        try {
          const raw = pick(s, ["owner"]);
          const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
          if (Array.isArray(arr)) owners = arr.map(o => (isObj(o) ? String(pick(o, ["username", "user_key"]) ?? "") : "")).filter(Boolean);
        } catch {
          /* 负责人解析不了就当没有 */
        }
        subs.set(String(id), {
          name,
          wid,
          parent: typeof parent === "string" ? parent : undefined,
          start: toMs(pick(s, ["estimate_start_date"])),
          end: toMs(pick(s, ["estimate_end_date"])),
          done: pick(s, ["is_finished"]) === true,
          days: typeof pts === "number" && pts > 0 ? pts : undefined,
          owners,
        });
      }
    }
    if (!(isObj(j.pagination) && j.pagination.has_more === true)) break;
  }
  if (ok) subCache.set(wid, { at: Date.now(), subs });
  return subs;
}

let meCache: { at: number; id: string; name?: string; key?: string } | undefined;
/** 当前登录 meegle 的账号（名字 + user_key；缓存 10 分钟，取不到不影响待办） */
export async function whoAmI(cfg: FeishuProjectConfig): Promise<{ name?: string; key?: string }> {
  const id = JSON.stringify([cfg.bin, cfg.binArgs ?? []]); // 换了命令行（比如换账号 / 测试）不能用旧缓存
  if (meCache && meCache.id === id && Date.now() - meCache.at < 10 * 60_000) return meCache;
  const j = parseJson(await runMeegle(cfg, ["user", "me"], sig()));
  const name = isObj(j) ? pick(j, ["name_cn", "name_en", "name"]) : undefined;
  const key = isObj(j) ? pick(j, ["user_key"]) : undefined;
  meCache = { at: Date.now(), id, name: typeof name === "string" ? name : undefined, key: typeof key === "string" ? key : undefined };
  return meCache;
}

export async function fetchFeishuTodos(cfg: FeishuProjectConfig): Promise<TodoSource> {
  const c = { ...cfg, timeoutSec: 30 };
  const call = (action: string, page: number, scope?: string) => runMeegle(c, ["mywork", "todo", `--action=${action}`, ...(scope ? [`--todo-scope=${scope}`] : []), `--page-num=${page}`, "--format=json"], sig());
  /** 取一个范围的所有行（每页 20 条，最多翻 3 页） */
  const rowsOf = async (action: string, scope?: string): Promise<{ rows: FsRow[]; error?: string }> => {
    const rows: FsRow[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= 3; page++) {
      const text = await call(action, page, scope);
      const j = parseJson(text);
      if (j === null) return { rows, error: page === 1 ? text.slice(0, 200) : undefined };
      const list = feishuRows(j).filter(r => !seen.has(rowKey(r)));
      list.forEach(r => seen.add(rowKey(r)));
      rows.push(...list);
      if (findList(j).length < 20 || list.length === 0) break;
    }
    return { rows };
  };
  // 全部待办里既有进行中的、也有还没开始的；再单独取「进行中」和「逾期」做标记
  const [all, active, overdue, user] = await Promise.all([rowsOf("todo", "all"), rowsOf("todo", "in_progress"), rowsOf("overdue"), whoAmI(c).catch(() => ({}) as { name?: string; key?: string })]);
  if (all.error) return { enabled: true, ok: false, items: [], error: all.error };

  // 有子任务的需求去取子任务名（进行中的优先，最多 10 个，4 路并发）
  const activeWids = new Set(active.rows.map(r => r.wid));
  const need = new Map<string, string | undefined>();
  for (const r of [...all.rows, ...active.rows]) if ((r.subId || activeWids.has(r.wid)) && !need.has(r.wid)) need.set(r.wid, r.projectKey);
  const order = [...need.entries()].sort((a, b) => Number(activeWids.has(b[0])) - Number(activeWids.has(a[0]))).slice(0, 10);
  const subs = new Map<string, SubInfo>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, order.length) }, async () => {
      while (next < order.length) {
        const [wid, pk] = order[next++];
        for (const [k, v] of await fetchSubs(c, wid, pk).catch(() => new Map<string, SubInfo>())) subs.set(k, v);
      }
    }),
  );
  return { enabled: true, ok: true, items: groupFeishu(all.rows, active.rows, overdue.rows, subs, user), user: user.name };
}

export async function fetchDingtalkTodos(cfg: DingtalkProjectConfig): Promise<TodoSource> {
  const text = await runDws({ ...cfg, timeoutSec: 30 }, ["todo", "task", "list", "--status=false", "--size=30", "--format=json"], sig());
  const j = parseJson(text);
  if (j === null) return { enabled: true, ok: false, items: [], error: text.slice(0, 200) };
  return { enabled: true, ok: true, items: extractTodos(j, "dingtalk") };
}

/** 排序：逾期 → 有截止时间的按时间 → 没有截止时间的 */
export function sortTodos(items: TodoItem[]): TodoItem[] {
  const rank = (t: TodoItem) => (t.overdue ? 0 : t.due ? 1 : 2);
  return [...items].sort((a, b) => rank(a) - rank(b) || (a.due ?? Infinity) - (b.due ?? Infinity));
}

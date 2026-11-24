import { runDws, type DingtalkProjectConfig } from "../../src/tools/dingtalk-project";
import { feishuProjectSpaces, runMeegle, type FeishuProjectConfig, type FeishuSpace } from "../../src/tools/feishu-project";
import { findList, parseJson, toMs, whoAmI } from "../../src/tools/workbench";
import { isClosedStatus, type Defect, type DefectActResult, type DefectsResult, type DefectTransitions } from "../shared/defects";

/**
 * 取「指派给我的缺陷」：
 * - 飞书项目：遍历我能进的空间，找到「缺陷 / bug」类工作项，用 MQL 查当前负责人是我、还没关闭的
 * - 钉钉：我的未完成待办
 * 都是固定的只读命令，不经过模型。状态流转是用户在界面里点出来的，也是固定命令。
 */

const sig = () => new AbortController().signal;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const FEISHU_HOST = "project.feishu.cn";

// ───────────── 飞书项目 ─────────────

interface Field {
  text?: string;
  key?: string;
  users?: string[];
}

function userName(u: unknown): string | undefined {
  if (!isObj(u)) return undefined;
  const n = u.name_cn || u.name_en || u.name || u.email;
  return typeof n === "string" && n ? n : undefined;
}

/** MQL 返回的字段值有好几种包装（string_value / key_label_value / user_value_list …），统一成文本 */
export function fieldOf(value: unknown): Field {
  if (!isObj(value)) return {};
  if (typeof value.string_value === "string") return { text: value.string_value };
  if (typeof value.long_value === "number" || typeof value.double_value === "number") return { text: String(value.long_value ?? value.double_value) };
  if (isObj(value.key_label_value)) return { text: String(value.key_label_value.label ?? ""), key: String(value.key_label_value.key ?? "") };
  if (Array.isArray(value.key_label_value_list)) {
    const l = value.key_label_value_list.filter(isObj);
    return { text: l.map(x => String(x.label ?? "")).join("、"), key: l[0] ? String(l[0].key ?? "") : undefined };
  }
  if (isObj(value.user_value)) {
    const n = userName(value.user_value);
    return { text: n, users: n ? [n] : [] };
  }
  if (Array.isArray(value.user_value_list)) {
    const users = value.user_value_list.map(userName).filter((x): x is string => !!x);
    return { text: users.join("、"), users };
  }
  return {};
}

export interface TypeRef {
  key: string;
  name: string;
}

/** MQL 结果行 → 缺陷。只认含 moql_field_list 的行，其余结构一律忽略 */
export function parseDefectRows(json: unknown, space: FeishuSpace, type: TypeRef): Defect[] {
  const rows: unknown[] = [];
  if (isObj(json) && isObj(json.data)) for (const v of Object.values(json.data)) if (Array.isArray(v)) rows.push(...v);
  if (!rows.length && isObj(json) && Array.isArray(json.list)) rows.push(...json.list);
  const out: Defect[] = [];
  for (const r of rows) {
    if (!isObj(r) || !Array.isArray(r.moql_field_list)) continue;
    const f: Record<string, Field> = {};
    for (const x of r.moql_field_list) if (isObj(x) && typeof x.key === "string") f[x.key] = fieldOf(x.value);
    const id = f.work_item_id?.text;
    const title = f.name?.text;
    if (!id || !title) continue;
    const status = f.work_item_status?.text || "未知";
    out.push({
      id,
      source: "feishu",
      title,
      space: space.name,
      spaceKey: space.key,
      spaceSimple: space.simpleName,
      typeKey: type.key,
      typeName: type.name,
      status,
      statusKey: f.work_item_status?.key || undefined,
      priority: f.priority?.text || undefined,
      severity: f.severity?.text || undefined,
      reporter: f.owner?.text || undefined,
      assignees: f.current_status_operator?.users?.length ? f.current_status_operator.users : undefined,
      created: toMs(f.start_time?.text),
      updated: toMs(f.updated_at?.text),
      url: `https://${FEISHU_HOST}/${space.simpleName || space.key}/${type.key}/detail/${id}`,
    });
  }
  return out;
}

const BASE_FIELDS = ["work_item_id", "name", "work_item_status", "priority", "severity", "owner", "current_status_operator", "start_time", "updated_at"];
const REQUIRED = new Set(["work_item_id", "name", "work_item_status", "current_status_operator"]);
const bt = (s: string) => "`" + s.replace(/[`\r\n]/g, "") + "`";
const q = (s: string) => `'${s.replace(/['\r\n\\]/g, "")}'`;

/** 查一个空间的一类缺陷。个别空间的自定义类型没有某个字段（如严重程度）：去掉它重试 */
export async function queryDefects(cfg: FeishuProjectConfig, space: FeishuSpace, type: TypeRef, who?: string): Promise<{ items?: Defect[]; error?: string }> {
  let fields = [...BASE_FIELDS];
  const me = who ? q(who) : "current_login_user()";
  for (let i = 0; i < 4; i++) {
    const mql = `SELECT ${fields.map(bt).join(", ")} FROM ${bt(space.key)}.${bt(type.name)} WHERE array_contains(${bt("current_status_operator")}, ${me}) ORDER BY ${bt("updated_at")} DESC LIMIT 50`;
    const text = await runMeegle(cfg, ["workitem", "query", `--project-key=${space.key}`, `--mql=${mql}`, "--format=json"], sig());
    const j = parseJson(text);
    const err = j === null ? text.slice(0, 200) : isObj(j) && isObj(j.error) ? String(j.error.message ?? "查询失败") : undefined;
    if (!err) return { items: parseDefectRows(j, space, type) };
    const m = /,\s*label:([\w-]+)\./.exec(err);
    if (m && fields.includes(m[1]) && !REQUIRED.has(m[1])) {
      fields = fields.filter(x => x !== m[1]);
      continue;
    }
    return { error: err.replace(/^error=\w+,message=/, "").slice(0, 160) };
  }
  return { error: "查询字段不匹配" };
}

const META_TTL = 30 * 60_000;
let meta: { at: number; id: string; list: Array<{ space: FeishuSpace; types: TypeRef[] }> } | undefined;
export const resetDefectMeta = () => (meta = undefined);

/** 我能进的空间，以及每个空间里的「缺陷」类型（缓存 30 分钟） */
async function defectTypes(cfg: FeishuProjectConfig): Promise<{ list: Array<{ space: FeishuSpace; types: TypeRef[] }>; error?: string }> {
  const id = JSON.stringify([cfg.bin, cfg.binArgs ?? []]);
  if (meta && meta.id === id && Date.now() - meta.at < META_TTL) return { list: meta.list };
  const sp = await feishuProjectSpaces(cfg);
  if (!sp.ok || !sp.spaces) return { list: [], error: sp.error || "取不到空间列表" };
  const list: Array<{ space: FeishuSpace; types: TypeRef[] }> = [];
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, sp.spaces.length) }, async () => {
      while (next < sp.spaces!.length) {
        const space = sp.spaces![next++];
        const j = parseJson(await runMeegle(cfg, ["workitem", "meta-types", `--project-key=${space.key}`, "--format=json"], sig()));
        const types = findList(j)
          .filter(x => typeof x.type_key === "string" && typeof x.name === "string" && x.is_disable !== true && (x.type_key === "issue" || /缺陷|bug/i.test(x.name as string)))
          .map(x => ({ key: x.type_key as string, name: x.name as string }));
        if (types.length) list.push({ space, types });
      }
    }),
  );
  // 只缓存取到的结果，网络抖动取空时下次重来
  if (list.length) meta = { at: Date.now(), id, list };
  return { list };
}

export async function fetchFeishuDefects(cfg: FeishuProjectConfig, now = Date.now()): Promise<DefectsResult> {
  const c = { ...cfg, timeoutSec: 40 };
  const base = { enabled: true, source: "feishu" as const, at: now };
  const who = await whoAmI(c).catch(() => ({}) as { name?: string });
  const t = await defectTypes(c);
  if (!t.list.length) return { ...base, ok: !t.error, items: [], error: t.error, user: who.name };
  const jobs = t.list.flatMap(x => x.types.map(ty => ({ space: x.space, type: ty })));
  const items: Defect[] = [];
  const warnings: string[] = [];
  let okCount = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(4, jobs.length) }, async () => {
      while (next < jobs.length) {
        const { space, type } = jobs[next++];
        const r = await queryDefects(c, space, type, who.name);
        if (r.items) {
          okCount++;
          items.push(...r.items);
        } else warnings.push(`${space.name}：${r.error}`);
      }
    }),
  );
  if (!okCount) return { ...base, ok: false, items: [], error: warnings[0] ?? "查询失败", user: who.name };
  const open = items.filter(d => !isClosedStatus(d.status, d.statusKey)).sort((a, b) => (b.updated ?? b.created ?? 0) - (a.updated ?? a.created ?? 0));
  return { ...base, ok: true, items: open, warnings: warnings.length ? warnings : undefined, user: who.name };
}

/** 把命令行报的错翻成人话：常见的几种单独说明，其余去掉 error=…,message= 的包装 */
export function friendlyError(raw: string): string {
  const msg = raw.replace(/^error=\w+,message=/, "");
  if (/WorkItemNotFound|work item \d+ was not found|ErrnoFailedToGetWorkItemInfo/i.test(raw)) return "这个缺陷在飞书项目里已经不存在了（可能被删除或移走了），列表已刷新";
  if (/NoPermission/i.test(raw)) return "没有权限做这个状态流转，请到飞书项目里确认你是不是负责人";
  return msg.replace(/,retriable=\w+.*$/s, "").slice(0, 200);
}

/** 命令失败时的错误说明（没失败返回 undefined）。命令行出错时会把 JSON 错误体跟在「退出码」后面，要先解析出来，别把整坨 JSON 丢给用户 */
export const failed = (text: string): string | undefined => {
  const body = text.replace(/^(meegle|dws) 退出码 \d+\n?/, "");
  const j = parseJson(body) ?? parseJson(text);
  if (isObj(j) && isObj(j.error)) return friendlyError(String(j.error.message ?? "操作失败"));
  if (/^启动 .* 失败|^meegle 退出码|^dws 退出码|^\[超时已终止\]/.test(text)) {
    const m = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(body);
    return m ? friendlyError(m[1]) : body.slice(0, 200) || text.slice(0, 200);
  }
  return undefined;
};

/** 这个缺陷现在能流转到哪些状态（状态流类型才有；节点流的缺陷只能去飞书里操作） */
export async function feishuTransitions(cfg: FeishuProjectConfig, d: Defect): Promise<DefectTransitions> {
  if (!d.spaceKey || !d.typeKey) return { ok: false, items: [], error: "缺少空间信息" };
  const text = await runMeegle({ ...cfg, timeoutSec: 30 }, ["workflow", "list-state-transitions", `--project-key=${d.spaceKey}`, `--work-item-id=${d.id}`, `--work-item-type=${d.typeKey}`, "--format=json"], sig());
  const e = failed(text);
  if (e) return { ok: false, items: [], error: /state.?flow|状态流/i.test(e) ? "这个缺陷用的是节点流程，请到飞书项目里操作" : e };
  const j = parseJson(text);
  if (!isObj(j) || !Array.isArray(j.transition)) return { ok: false, items: [], error: "没有取到可流转的状态" };
  const items = j.transition
    .filter(isObj)
    .filter(x => x.id !== undefined && typeof x.state_name === "string")
    .map(x => ({ id: String(x.id), name: x.state_name as string, needsForm: Array.isArray(x.confirm_form) ? x.confirm_form.length > 0 : !!x.confirm_form || undefined }));
  return { ok: true, current: typeof j.state_name === "string" ? j.state_name : d.status, items };
}

export async function feishuTransition(cfg: FeishuProjectConfig, d: Defect, transitionId: string): Promise<DefectActResult> {
  if (!d.spaceKey) return { ok: false, error: "缺少空间信息" };
  if (!/^\d{1,20}$/.test(transitionId)) return { ok: false, error: "流转 id 不合法" };
  const text = await runMeegle({ ...cfg, timeoutSec: 30 }, ["workflow", "transition-state", `--project-key=${d.spaceKey}`, `--work-item-id=${d.id}`, `--transition-id=${transitionId}`, "--format=json"], sig());
  const e = failed(text);
  return e ? { ok: false, error: e } : { ok: true };
}

// ───────────── 钉钉 ─────────────

const pickStr = (o: Record<string, unknown>, keys: string[]): string | undefined => {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return undefined;
};

/** dws todo task list 的返回：没有稳定文档，按常见字段名宽松解析 */
export function parseDingtalkTasks(json: unknown): Defect[] {
  const out: Defect[] = [];
  for (const o of findList(json)) {
    const id = pickStr(o, ["taskId", "task_id", "todoId", "id"]);
    const title = pickStr(o, ["subject", "title", "content", "name"]);
    if (!id || !title) continue;
    if (o.done === true || o.isDone === true || o.status === true) continue;
    const creator = isObj(o.creator) ? pickStr(o.creator, ["name", "nick", "userName"]) : pickStr(o, ["creatorName", "creator_name", "createdBy"]);
    const url = pickStr(o, ["detailUrl", "detail_url", "url", "link"]);
    out.push({
      id,
      source: "dingtalk",
      title,
      status: "待处理",
      reporter: creator,
      created: toMs(o.createdTime ?? o.created_time ?? o.gmtCreate ?? o.createTime),
      updated: toMs(o.modifiedTime ?? o.modified_time ?? o.gmtModified ?? o.updateTime),
      due: toMs(o.dueTime ?? o.due_time ?? o.dueDate),
      url: url && /^https?:\/\//.test(url) ? url : undefined,
    });
  }
  return out;
}

export async function fetchDingtalkDefects(cfg: DingtalkProjectConfig, now = Date.now()): Promise<DefectsResult> {
  const base = { enabled: true, source: "dingtalk" as const, at: now };
  const text = await runDws({ ...cfg, timeoutSec: 30 }, ["todo", "task", "list", "--status=false", "--size=50", "--format=json"], sig());
  const j = parseJson(text);
  if (j === null) return { ...base, ok: false, items: [], error: text.slice(0, 200) };
  const e = failed(text);
  if (e) return { ...base, ok: false, items: [], error: e };
  return { ...base, ok: true, items: parseDingtalkTasks(j).sort((a, b) => (b.updated ?? b.created ?? 0) - (a.updated ?? a.created ?? 0)) };
}

export const DINGTALK_DONE = "done";

export function dingtalkTransitions(): DefectTransitions {
  return { ok: true, current: "待处理", items: [{ id: DINGTALK_DONE, name: "标记完成" }] };
}

export async function dingtalkTransition(cfg: DingtalkProjectConfig, d: Defect, transitionId: string): Promise<DefectActResult> {
  if (transitionId !== DINGTALK_DONE) return { ok: false, error: "钉钉待办只能标记完成" };
  if (!/^[\w.-]{1,64}$/.test(d.id)) return { ok: false, error: "待办 id 不合法" };
  const text = await runDws({ ...cfg, timeoutSec: 30 }, ["todo", "task", "done", `--task-id=${d.id}`, "--status=true", "--format=json"], sig());
  const e = failed(text);
  return e ? { ok: false, error: e } : { ok: true };
}

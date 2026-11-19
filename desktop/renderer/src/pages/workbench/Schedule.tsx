import { useMemo, useState } from "react";
import type { TodoChildDTO, TodoItemDTO } from "../../../../shared/api";
import { WEEK, WINDOW_DAYS, DAY, layoutBars, md, startOfDay, windowStart } from "../../../../shared/schedule";
import { Icon } from "../../components/Icon";

export const SOURCE_NAME: Record<TodoItemDTO["source"], string> = { feishu: "飞书项目", dingtalk: "钉钉待办" };

/** 日期 → 11/17 或 11/17 18:00（有具体时刻才带） */
function when(ms: number): string {
  const d = new Date(ms);
  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
  return hasTime ? `${md(ms)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : md(ms);
}

function range(t: TodoItemDTO): string {
  const a = t.start ?? t.end ?? t.due;
  const b = t.end ?? t.due ?? t.start;
  if (a === undefined || b === undefined) return "未排期";
  return startOfDay(a) === startOfDay(b) ? when(b) : `${when(a)} ~ ${when(b)}`;
}

function childRange(c: TodoChildDTO): string {
  const a = c.start ?? c.end;
  const b = c.end ?? c.start;
  if (a === undefined || b === undefined) return "未排期";
  return startOfDay(a) === startOfDay(b) ? when(b) : `${when(a)} ~ ${when(b)}`;
}

const toInput = (ms?: number) => {
  if (ms === undefined) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const fromInput = (s: string): number | undefined => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : undefined;
};

/** 改子任务的排期：起止日期 + 人天，保存时直接写到飞书项目 */
function SchedEditor({ init, onSave, onClose }: { init?: { start?: number; end?: number; days?: number }; onSave: (v: { start?: number; end?: number; days?: number }) => Promise<string | undefined>; onClose: () => void }) {
  const [s, setS] = useState(toInput(init?.start));
  const [e, setE] = useState(toInput(init?.end));
  const [d, setD] = useState(init?.days !== undefined ? String(init.days) : "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string>();
  const save = async () => {
    let a = fromInput(s);
    let b = fromInput(e);
    if (a !== undefined && b === undefined) b = a;
    if (b !== undefined && a === undefined) a = b;
    if (a !== undefined && b !== undefined && b < a) [a, b] = [b, a];
    const days = d.trim() === "" ? undefined : Math.max(0, Number(d));
    const v = { start: a, end: b, days: days !== undefined && Number.isFinite(days) ? days : undefined };
    if (v.start === undefined && v.days === undefined) return setErr("请填写日期或人天");
    setBusy(true);
    setErr(undefined);
    const bad = await onSave(v);
    setBusy(false);
    if (bad) setErr(bad);
    else onClose();
  };
  return (
    <div className="sched-edit" data-testid="sched-edit" onClick={ev => ev.stopPropagation()}>
      <label>
        开始 <input type="date" data-testid="sched-start" value={s} onChange={ev => setS(ev.target.value)} />
      </label>
      <label>
        结束 <input type="date" data-testid="sched-end" value={e} min={s} onChange={ev => setE(ev.target.value)} />
      </label>
      <label>
        人天 <input type="number" data-testid="sched-days" min={0} step={0.5} value={d} onChange={ev => setD(ev.target.value)} />
      </label>
      <button className="btn sm primary" data-testid="sched-save" onClick={() => void save()} disabled={busy} title="保存后直接写到飞书项目">
        {busy ? <span className="spinner" /> : null} 保存到飞书项目
      </button>
      <button className="btn sm ghost" onClick={onClose} disabled={busy}>
        取消
      </button>
      {err && (
        <span className="bad sched-err" data-testid="sched-err">
          {err}
        </span>
      )}
    </div>
  );
}

/** 需求下我负责的节点（小标签） */
function Nodes({ t }: { t: TodoItemDTO }) {
  const nodes = (t.children ?? []).filter(c => c.kind === "node");
  if (!nodes.length) return t.node ? <span className="act-node">{t.node}</span> : null;
  return (
    <>
      {nodes.map(n => (
        <span key={n.id} className={`act-node${n.active ? "" : " idle"}`} data-testid="wb-node" title={n.active ? "进行中的节点" : "我负责的节点"}>
          {n.title}
        </span>
      ))}
    </>
  );
}

/** 需求自己的排期：只显示飞书项目里的日期（需求和节点的排期要到飞书里改，这里只改子任务） */
function SelfSched({ t }: { t: TodoItemDTO }) {
  return (
    <span className="self-when" data-testid="wb-self-sched" title="需求 / 节点的排期来自飞书项目；子任务的排期可以在下面直接改">
      {range(t)}
    </span>
  );
}

/** 改子任务（完成 / 回滚 / 排期）。返回错误文字，成功返回 undefined */
export type ChildEdit = (t: TodoItemDTO, c: TodoChildDTO, change: { done?: boolean; start?: number; end?: number; days?: number }) => Promise<string | undefined>;

/** 需求下我负责的子任务：名字、负责人、人天、排期（可以在这里填） */
function Children({ t, onEdit }: { t: TodoItemDTO; onEdit: ChildEdit }) {
  const [editing, setEditing] = useState<string | null>(null);
  /** 正在写飞书的子任务：点下去马上按新状态显示，失败了再改回来 */
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [errs, setErrs] = useState<Record<string, string>>({});
  const subs = (t.children ?? []).filter(c => c.kind === "subtask");
  if (!subs.length) return null;
  const toggle = async (c: TodoChildDTO) => {
    if (c.id in pending) return;
    const want = !c.done;
    setPending(p => ({ ...p, [c.id]: want }));
    setErrs(e => {
      const { [c.id]: _x, ...rest } = e;
      return rest;
    });
    const bad = await onEdit(t, c, { done: want });
    setPending(p => {
      const { [c.id]: _x, ...rest } = p;
      return rest;
    });
    if (bad) setErrs(e => ({ ...e, [c.id]: bad }));
  };
  return (
    <div className="sub-list" data-testid="sub-list">
      {subs.map(c => {
        const done = c.id in pending ? pending[c.id] : c.done;
        const canEdit = !!(t.projectKey && c.nodeKey);
        return (
          <div key={c.id} className="sub-item">
            <div className={`sub-row${done ? " done" : ""}${c.active ? " active" : ""}`} data-testid="wb-child" data-kind={c.kind}>
              <button
                className={`sub-check${done ? " on" : ""}${c.id in pending ? " busy" : ""}`}
                data-testid="wb-child-check"
                disabled={!canEdit || c.id in pending}
                title={!canEdit ? "缺少定位信息，刷新一下再试" : done ? "已完成，点一下改回未完成（同步到飞书项目）" : "点一下标记完成（同步到飞书项目）"}
                onClick={() => void toggle(c)}
              >
                {done && <Icon name="check" size={11} strokeWidth={3} />}
              </button>
              <span className="sub-title">{c.title}</span>
              {c.parent && <span className="sub-parent">{c.parent}</span>}
              {c.active && <em className="sub-act">进行中</em>}
              {c.owner && (
                <span className="sub-owner" data-testid="wb-child-owner">
                  <i>{Array.from(c.owner)[0]}</i>
                  {c.owner}
                </span>
              )}
              <span className="sub-days" data-testid="wb-child-days">
                {c.days !== undefined ? `${c.days} 人天` : "–"}
              </span>
              <button className={`sub-when${c.start === undefined && c.end === undefined ? " none" : ""}`} data-testid="wb-child-when" disabled={!canEdit} title="点一下修改排期和人天（保存后同步到飞书项目）" onClick={() => setEditing(editing === c.id ? null : c.id)}>
                {childRange(c)}
                <Icon name="edit" size={11} />
              </button>
            </div>
            {errs[c.id] && (
              <div className="sub-err bad" data-testid="wb-child-err">
                没有同步到飞书项目：{errs[c.id]}
              </div>
            )}
            {editing === c.id && <SchedEditor init={{ start: c.start, end: c.end, days: c.days }} onSave={v => onEdit(t, c, v)} onClose={() => setEditing(null)} />}
          </div>
        );
      })}
    </div>
  );
}

/** 我的排期：只展示一个来源（飞书项目或钉钉）的待办，按天排成甘特条 */
export function Schedule({
  source,
  items,
  loaded,
  loading,
  title,
  user,
  error,
  onEdit,
  tasked,
  onTask,
}: {
  source: TodoItemDTO["source"];
  items: TodoItemDTO[];
  loaded: boolean;
  loading: boolean;
  /** 副标题：空间名 */
  title?: string;
  /** 当前登录的账号（待办都是这个人的） */
  user?: string;
  /** 读取失败的原因 */
  error?: string;
  /** 改飞书项目里的子任务（完成 / 回滚 / 排期） */
  onEdit: ChildEdit;
  /** 已经建过任务的需求（source + id） */
  tasked: Set<string>;
  /** 点击需求：在左侧创建任务；open=true 同时打开任务 */
  onTask: (t: TodoItemDTO, open: boolean) => void;
}) {
  const [weeks, setWeeks] = useState(0);
  const [open, setOpen] = useState<string | null>(null);
  const now = Date.now();
  const ws = windowStart(now, weeks);
  const days = useMemo(() => Array.from({ length: WINDOW_DAYS }, (_, i) => new Date(ws + i * DAY + 12 * 3600_000).getTime()), [ws]);
  const todayIdx = Math.round((startOfDay(now) - ws) / DAY);
  const { bars, unscheduled: noDate, outside } = useMemo(() => layoutBars(items, ws), [items, ws]);
  /** 进行中的需求（不管排没排期都列出来，带我负责的子任务）；未排期里只放没在进行中的 */
  const active = useMemo(() => items.filter(i => i.active), [items]);
  const unscheduled = useMemo(() => noDate.filter(i => !i.active), [noDate]);
  const [subOpen, setSubOpen] = useState<string | null>(null);
  const key = (t: TodoItemDTO) => t.source + t.id;
  const last = ws + (WINDOW_DAYS - 1) * DAY;

  const detail = (t: TodoItemDTO) => (
    <div className="gantt-detail" data-testid="gantt-detail">
      <div className="gd-meta">
        <b className="gd-title">{t.title}</b>
        <span>{range(t)}</span>
        {t.node && <span>节点：{t.node}</span>}
        {t.sub && <span>{t.sub}</span>}
        {t.overdue && <span className="bad">已逾期</span>}
      </div>
      <button className="btn sm" data-testid="wb-todo-ai" onClick={() => onTask(t, true)}>
        <Icon name="spark" size={13} /> 打开任务
      </button>
      <Children t={t} onEdit={onEdit} />
    </div>
  );

  return (
    <section className="wb-card wb-schedule" data-testid="wb-schedule" data-source={source}>
      <div className="wb-card-head sch-head">
        <div className="sch-title">
          <h2>我的排期</h2>
          <span className="muted" data-testid="wb-schedule-src">
            {SOURCE_NAME[source]}
            {title ? ` · ${title}` : ""}
          </span>
          {user && (
            <span className="sch-user" data-testid="wb-user" title="这里的需求都是当前登录账号的">
              <Icon name="user" size={12} /> {user}
            </span>
          )}
        </div>
        <div className="sch-tools">
          <span className="muted" data-testid="wb-schedule-count">
            {loaded ? `${bars.length} 项排期中${loading ? " · 正在更新…" : ""}` : loading ? "正在读取…" : ""}
          </span>
        </div>
      </div>

      {error && (
        <div className="wb-note bad" data-testid="wb-err">
          {SOURCE_NAME[source]}读取失败：{error}
        </div>
      )}

      <div className="sch-nav">
        <span className="sch-range" data-testid="wb-range">
          <Icon name="calendar" size={13} /> {md(ws)} ~ {md(last)}
        </span>
        <button className="btn icon sm" aria-label="上一段" data-testid="wb-prev" onClick={() => setWeeks(w => w - 1)}>
          ‹
        </button>
        <button className="btn icon sm" aria-label="下一段" data-testid="wb-next" onClick={() => setWeeks(w => w + 1)}>
          ›
        </button>
        {weeks !== 0 && (
          <button className="link" data-testid="wb-today" onClick={() => setWeeks(0)}>
            回到今天
          </button>
        )}
        {outside > 0 && <span className="muted sch-outside">另有 {outside} 项不在这段时间里</span>}
      </div>

      <div className="gantt" data-testid="gantt">
        <div className="gantt-head">
          {days.map((d, i) => {
            const wd = new Date(d).getDay();
            return (
              <div key={i} className={`gh${wd === 0 || wd === 6 ? " weekend" : ""}${i === todayIdx ? " today" : ""}`}>
                <span>{i === 0 || new Date(d).getDate() === 1 ? md(d) : new Date(d).getDate()}</span>
                <span>{WEEK[wd]}</span>
              </div>
            );
          })}
        </div>
        <div className="gantt-body">
          <div className="gantt-bg" aria-hidden>
            {days.map((d, i) => {
              const wd = new Date(d).getDay();
              return <div key={i} className={`gc${wd === 0 || wd === 6 ? " weekend" : ""}${i === todayIdx ? " today" : ""}`} />;
            })}
          </div>
          <div className="gantt-rows">
            {bars.length === 0 && (
              <div className="gantt-empty" data-testid="gantt-empty">
                {loaded ? "这段时间没有排期" : loading ? "正在读取…" : "还没有数据"}
              </div>
            )}
            {bars.map(b => {
              const t = b.item;
              const isOpen = open === key(t);
              return (
                <div className="gantt-row" key={key(t)} data-testid="gantt-row">
                  <button
                    className={`gantt-bar${t.overdue ? " overdue" : ""}${b.cutL ? " cut-l" : ""}${b.cutR ? " cut-r" : ""}${isOpen ? " open" : ""}${tasked.has(key(t)) ? " tasked" : ""}`}
                    style={{ gridColumn: `${b.s + 1} / ${b.e + 2}` }}
                    title={`${t.title}\n${range(t)}`}
                    data-testid="gantt-bar"
                    onClick={() => {
                      if (tasked.has(key(t))) return onTask(t, true);
                      onTask(t, false);
                      setOpen(isOpen ? null : key(t));
                    }}
                  >
                    <span className={`chev${isOpen ? " open" : ""}${tasked.has(key(t)) ? " tasked" : ""}`}>›</span>
                    <b>{t.title}</b>
                    {t.node && <em>{t.node}</em>}
                  </button>
                  {isOpen && detail(t)}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {active.length > 0 && (
        <div className="sch-active" data-testid="wb-active">
          <div className="sch-sub">进行中的需求 · {active.length}</div>
          {active.map(t => (
            <div className="act-item" key={key(t)} data-testid="wb-active-item">
              <div className="act-head">
                <div className={`wb-todo-main${tasked.has(key(t)) ? " jump" : ""}`} data-testid="wb-active-main" onClick={() => tasked.has(key(t)) && onTask(t, true)} title={tasked.has(key(t)) ? "打开对应任务" : undefined}>
                  <div className="wb-todo-title">{t.title}</div>
                  <div className="wb-sub">
                    <Nodes t={t} />
                    {t.overdue && <span className="bad"> 已逾期 </span>}
                    <SelfSched t={t} />
                    {t.sub ? ` · ${t.sub}` : ""}
                  </div>
                </div>
                <button className="btn sm wb-ai" data-testid="wb-active-open" onClick={() => onTask(t, true)}>
                  <Icon name="spark" size={13} /> {tasked.has(key(t)) ? "打开任务" : "创建任务"}
                </button>
              </div>
              <Children t={t} onEdit={onEdit} />
            </div>
          ))}
        </div>
      )}

      {unscheduled.length > 0 && (
        <div className="sch-unscheduled" data-testid="wb-unscheduled">
          <div className="sch-sub">未排期 · {unscheduled.length}</div>
          {unscheduled.map(t => (
            <div className="wb-todo" key={key(t)} data-testid="wb-todo">
              <div className="wb-todo-main">
                <div className={`wb-todo-title${tasked.has(key(t)) ? " jump" : ""}`} onClick={() => tasked.has(key(t)) && onTask(t, true)} title={tasked.has(key(t)) ? "打开对应任务" : undefined}>{t.title}</div>
                <div className="wb-sub">
                  {t.sub} <SelfSched t={t} />
                  {t.children?.some(c => c.kind === "subtask") ? (
                    <button className="link sub-toggle" data-testid="wb-sub-toggle" onClick={() => setSubOpen(subOpen === key(t) ? null : key(t))}>
                      {" · "}我的子任务 {t.children.filter(c => c.kind === "subtask").length} {subOpen === key(t) ? "▴" : "▾"}
                    </button>
                  ) : null}
                </div>
                {subOpen === key(t) && <Children t={t} onEdit={onEdit} />}
              </div>
              <button className="btn sm wb-ai" data-testid="wb-todo-ai" onClick={() => onTask(t, true)}>
                <Icon name="spark" size={13} /> {tasked.has(key(t)) ? "打开任务" : "创建任务"}
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

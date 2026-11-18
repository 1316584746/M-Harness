import { useMemo, useState } from "react";
import type { TodoChildDTO, TodoItemDTO } from "../../../../shared/api";
import { applySchedule, schedKey, type SchedOverride, type ScheduleStore } from "../../lib/scheduleStore";
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

/** 在本软件里填排期：起止日期 + 人天，只保存在本机 */
function SchedEditor({ init, onSave, onClose }: { init?: SchedOverride; onSave: (v: SchedOverride | null) => void; onClose: () => void }) {
  const [s, setS] = useState(toInput(init?.start));
  const [e, setE] = useState(toInput(init?.end));
  const [d, setD] = useState(init?.days !== undefined ? String(init.days) : "");
  const save = () => {
    let a = fromInput(s);
    let b = fromInput(e);
    if (a !== undefined && b === undefined) b = a;
    if (b !== undefined && a === undefined) a = b;
    if (a !== undefined && b !== undefined && b < a) [a, b] = [b, a];
    const days = d.trim() === "" ? undefined : Math.max(0, Number(d));
    onSave({ start: a, end: b, days: Number.isFinite(days) ? days : undefined });
    onClose();
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
      <button className="btn sm primary" data-testid="sched-save" onClick={save}>
        保存
      </button>
      {init && (
        <button
          className="btn sm"
          data-testid="sched-clear"
          title="清除本软件里填的排期，恢复飞书里的"
          onClick={() => {
            onSave(null);
            onClose();
          }}
        >
          清除
        </button>
      )}
      <button className="btn sm ghost" onClick={onClose}>
        取消
      </button>
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

/** 需求自己的排期：显示日期，点一下填写 / 修改 */
function SelfSched({ t, sched }: { t: TodoItemDTO; sched: ScheduleStore }) {
  const [edit, setEdit] = useState(false);
  const k = schedKey(t);
  return (
    <>
      <button className={`link self-when${sched.all[k] ? " local" : ""}`} data-testid="wb-self-sched" onClick={ev => (ev.stopPropagation(), setEdit(v => !v))}>
        {range(t)}
        {sched.all[k] ? "（本地）" : t.start === undefined && t.end === undefined ? " · 填写排期" : ""}
      </button>
      {edit && <SchedEditor init={sched.all[k]} onSave={v => sched.set(k, v)} onClose={() => setEdit(false)} />}
    </>
  );
}

/** 需求下我负责的子任务：名字、负责人、人天、排期（可以在这里填） */
function Children({ t, sched }: { t: TodoItemDTO; sched: ScheduleStore }) {
  const [editing, setEditing] = useState<string | null>(null);
  const subs = (t.children ?? []).filter(c => c.kind === "subtask");
  if (!subs.length) return null;
  return (
    <div className="sub-list" data-testid="sub-list">
      {subs.map(c => {
        const k = schedKey(t, c.id);
        return (
          <div key={c.id} className="sub-item">
            <div className={`sub-row${c.done ? " done" : ""}${c.active ? " active" : ""}`} data-testid="wb-child" data-kind={c.kind}>
              <span className={`sub-check${c.done ? " on" : ""}`} title={c.done ? "已完成" : "未完成"}>
                {c.done && <Icon name="check" size={11} strokeWidth={3} />}
              </span>
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
              <button className={`sub-when${c.local ? " local" : ""}${c.start === undefined && c.end === undefined ? " none" : ""}`} data-testid="wb-child-when" title="点一下填写 / 修改排期（只保存在本软件）" onClick={() => setEditing(editing === c.id ? null : c.id)}>
                {childRange(c)}
                <Icon name="edit" size={11} />
              </button>
            </div>
            {editing === c.id && <SchedEditor init={sched.all[k]} onSave={v => sched.set(k, v)} onClose={() => setEditing(null)} />}
          </div>
        );
      })}
    </div>
  );
}

/** 我的排期：只展示一个来源（飞书项目或钉钉）的待办，按天排成甘特条 */
export function Schedule({
  source,
  items: rawItems,
  loaded,
  loading,
  title,
  user,
  error,
  sched,
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
  /** 在本软件里填的排期 */
  sched: ScheduleStore;
  /** 已经建过任务的需求（source + id） */
  tasked: Set<string>;
  /** 点击需求：在左侧创建任务；open=true 同时打开任务 */
  onTask: (t: TodoItemDTO, open: boolean) => void;
}) {
  const items = useMemo(() => applySchedule(rawItems, sched.all), [rawItems, sched.all]);
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
      <Children t={t} sched={sched} />
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
            {loaded ? `${bars.length} 项排期中` : loading ? "正在读取…" : ""}
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
                    <SelfSched t={t} sched={sched} />
                    {t.sub ? ` · ${t.sub}` : ""}
                  </div>
                </div>
                <button className="btn sm wb-ai" data-testid="wb-active-open" onClick={() => onTask(t, true)}>
                  <Icon name="spark" size={13} /> {tasked.has(key(t)) ? "打开任务" : "创建任务"}
                </button>
              </div>
              <Children t={t} sched={sched} />
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
                  {t.sub} <SelfSched t={t} sched={sched} />
                  {t.children?.some(c => c.kind === "subtask") ? (
                    <button className="link sub-toggle" data-testid="wb-sub-toggle" onClick={() => setSubOpen(subOpen === key(t) ? null : key(t))}>
                      {" · "}我的子任务 {t.children.filter(c => c.kind === "subtask").length} {subOpen === key(t) ? "▴" : "▾"}
                    </button>
                  ) : null}
                </div>
                {subOpen === key(t) && <Children t={t} sched={sched} />}
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

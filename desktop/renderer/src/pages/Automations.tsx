import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppState, RepoInfo } from "../../../shared/api";
import { MIN_INTERVAL, STATUS_TEXT, WEEK, describeSchedule, fmtWhen, nextRun, statusOf, type AutoRun, type AutoStatus, type Automation, type Schedule } from "../../../shared/automation";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { Req, useRequired } from "../components/Required";
import { SearchSelect } from "../components/SearchSelect";
import { Switch } from "./settings/Projects";

type Tab = AutoStatus | "all";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "on", label: "已开启" },
  { id: "paused", label: "已暂停" },
  { id: "ended", label: "已结束" },
  { id: "all", label: "全部" },
];

const pad = (n: number) => String(n).padStart(2, "0");
const toLocalInput = (ms?: number) => {
  if (!ms) return "";
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};
const fromLocalInput = (s: string) => (s ? new Date(s).getTime() : undefined);

const RUN_TEXT: Record<AutoRun["status"], string> = { running: "运行中", done: "成功", error: "失败", aborted: "已中断" };
const RUN_CLASS: Record<AutoRun["status"], string> = { running: "run", done: "ok", error: "bad", aborted: "warn" };

/** 自动化任务：按计划自动让 Agent 执行一段指令，结果记在每个任务的运行记录里 */
export function Automations({ state }: { state: AppState }) {
  const [items, setItems] = useState<Automation[] | null>(null);
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<Tab>("on");
  const [q, setQ] = useState("");
  const [edit, setEdit] = useState<Partial<Automation> | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState("");
  const [drop, setDrop] = useState<string | null>(null);

  const load = useCallback(async () => {
    const [list, run] = await Promise.all([api.automationList(), api.automationRunning()]);
    setItems(list);
    setRunning(new Set(run));
  }, []);
  useEffect(() => {
    void load();
    return api.onAutomationChanged(() => void load());
  }, [load]);

  const counts = useMemo(() => {
    const c: Record<Tab, number> = { on: 0, paused: 0, ended: 0, all: items?.length ?? 0 };
    for (const a of items ?? []) c[statusOf(a)]++;
    return c;
  }, [items]);
  // 没有已开启的任务时，默认看全部，别让人对着空白页
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    return (items ?? []).filter(a => (tab === "all" || statusOf(a) === tab) && (!k || `${a.name} ${a.prompt}`.toLowerCase().includes(k)));
  }, [items, tab, q]);

  const act = async (fn: () => Promise<{ ok: boolean; error?: string } | boolean | void>) => {
    setMsg("");
    const r = await fn();
    if (r && typeof r === "object" && !r.ok) setMsg(r.error ?? "操作失败");
    await load();
  };

  return (
    <section className="auto" data-testid="automations">
      <div className="auto-inner">
        <header className="auto-head">
          <h1>自动化任务</h1>
          <button className="btn primary" data-testid="auto-new" onClick={() => setEdit({ access: "read", schedule: { kind: "daily", time: "09:00" } })}>
            <Icon name="plus" size={14} /> 新建
          </button>
        </header>

        <div className="auto-tabs" role="tablist">
          {TABS.map(t => (
            <button key={t.id} role="tab" className={`auto-tab ${tab === t.id ? "on" : ""}`} data-testid={`auto-tab-${t.id}`} onClick={() => setTab(t.id)}>
              {t.label}
              {counts[t.id] > 0 && <span className="auto-count">{counts[t.id]}</span>}
            </button>
          ))}
        </div>

        <label className="auto-search">
          <Icon name="search" size={14} />
          <input data-testid="auto-search" placeholder="搜索自动化任务" value={q} onChange={e => setQ(e.target.value)} />
        </label>

        {msg && (
          <div className="px-msg bad" data-testid="auto-msg">
            {msg}
          </div>
        )}

        {items && shown.length === 0 && (
          <div className="auto-empty" data-testid="auto-empty">
            <span className="auto-empty-ico">
              <Icon name="timer" size={34} />
            </span>
            <p>{q ? "没有找到匹配的自动化任务" : tab === "all" || counts.all === 0 ? "还没有自动化任务" : `没有${STATUS_TEXT[tab as AutoStatus]}的自动化任务`}</p>
            {!q && counts.all === 0 && (
              <button className="btn" data-testid="auto-empty-new" onClick={() => setEdit({ access: "read", schedule: { kind: "daily", time: "09:00" } })}>
                新建自动化任务
              </button>
            )}
          </div>
        )}

        <div className="auto-list">
          {shown.map(a => {
            const st = statusOf(a);
            const busy = running.has(a.id);
            const last = a.runs[0];
            return (
              <article key={a.id} className={`auto-card ${st}`} data-testid="auto-item" data-status={st}>
                <div className="auto-row">
                  <div className="auto-main">
                    <div className="auto-name">
                      <span className={`auto-dot ${busy ? "run" : st}`} />
                      <b data-testid="auto-name">{a.name}</b>
                      <span className={`chip ${st === "on" ? "ok" : ""}`}>{STATUS_TEXT[st]}</span>
                    </div>
                    <div className="auto-meta">
                      <span data-testid="auto-schedule">{describeSchedule(a.schedule)}</span>
                      {a.nextRun && st === "on" && <span> · 下次 {fmtWhen(a.nextRun)}</span>}
                      {last && (
                        <span>
                          {" "}
                          · 上次 {fmtWhen(last.at)} <em className={`ph ${RUN_CLASS[last.status]}`}>{RUN_TEXT[last.status]}</em>
                        </span>
                      )}
                      {a.access === "ask" && <span> · 需要时询问</span>}
                    </div>
                    <div className="auto-prompt">{a.prompt}</div>
                  </div>
                  <div className="auto-acts">
                    {busy ? (
                      <button className="btn sm" data-testid="auto-stop" onClick={() => void api.automationAbort(a.id)}>
                        <span className="spinner" /> 停止
                      </button>
                    ) : (
                      <button className="btn sm" data-testid="auto-run" title="立即运行一次（不影响原来的计划）" onClick={() => void act(() => api.automationRun(a.id))}>
                        <Icon name="play" size={12} /> 立即运行
                      </button>
                    )}
                    {st !== "ended" && <Switch on={st === "on"} testid="auto-switch" onChange={v => void act(() => api.automationToggle(a.id, v))} />}
                    <button className="btn sm icon" title="编辑" data-testid="auto-edit" onClick={() => setEdit(a)}>
                      <Icon name="edit" size={13} />
                    </button>
                    {drop === a.id ? (
                      <button className="btn sm danger" data-testid="auto-del-confirm" autoFocus onBlur={() => setDrop(null)} onClick={() => (setDrop(null), void act(async () => api.automationRemove(a.id)))}>
                        确认删除
                      </button>
                    ) : (
                      <button className="btn sm icon" title="删除" data-testid="auto-del" onClick={() => setDrop(a.id)}>
                        <Icon name="trash" size={13} />
                      </button>
                    )}
                  </div>
                </div>
                <button className="auto-runs-toggle" data-testid="auto-runs-toggle" onClick={() => setOpen(open === a.id ? null : a.id)}>
                  <Icon name={open === a.id ? "down" : "right"} size={11} /> 运行记录 · {a.runs.length}
                </button>
                {open === a.id && (
                  <div className="auto-runs" data-testid="auto-runs">
                    {a.runs.length === 0 && <div className="muted">还没有运行过{a.nextRun ? "，到点会自动运行" : ""}</div>}
                    {a.runs.map(r => (
                      <RunRow key={r.id} r={r} />
                    ))}
                  </div>
                )}
              </article>
            );
          })}
        </div>
        {items && items.length > 0 && <div className="muted auto-note">只有软件开着的时候才会按时运行；关着软件时错过的不会补跑。</div>}
      </div>

      {edit && (
        <Editor
          init={edit}
          state={state}
          onClose={() => setEdit(null)}
          onSaved={() => {
            setEdit(null);
            void load();
          }}
        />
      )}
    </section>
  );
}

function RunRow({ r }: { r: AutoRun }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="auto-run" data-testid="auto-run-row" data-status={r.status}>
      <button className="auto-run-head" onClick={() => setOpen(o => !o)}>
        <em className={`ph ${RUN_CLASS[r.status]}`}>{r.status === "running" ? <span className="spinner" /> : null}{RUN_TEXT[r.status]}</em>
        <span>{fmtWhen(r.at)}</span>
        {r.manual && <span className="chip">手动</span>}
        {r.finished && <span className="muted">用时 {Math.max(1, Math.round((r.finished - r.at) / 1000))} 秒</span>}
        <span className="spacer" />
        <Icon name={open ? "down" : "right"} size={11} />
      </button>
      {open && (
        <div className="auto-run-body" data-testid="auto-run-text">
          {r.text ? r.status === "done" ? <Markdown text={r.text} /> : <pre>{r.text}</pre> : <span className="muted">（还没有结果）</span>}
        </div>
      )}
    </div>
  );
}

/** 新建 / 编辑 */
function Editor({ init, state, onClose, onSaved }: { init: Partial<Automation>; state: AppState; onClose: () => void; onSaved: () => void }) {
  const sc = init.schedule ?? { kind: "daily", time: "09:00" };
  const [name, setName] = useState(init.name ?? "");
  const [prompt, setPrompt] = useState(init.prompt ?? "");
  const [kind, setKind] = useState<Schedule["kind"]>(sc.kind);
  const [time, setTime] = useState(sc.kind === "daily" || sc.kind === "weekly" ? sc.time : "09:00");
  const [days, setDays] = useState<number[]>(sc.kind === "weekly" ? sc.days : [1, 2, 3, 4, 5]);
  const [every, setEvery] = useState(sc.kind === "interval" ? (sc.minutes % 60 === 0 ? sc.minutes / 60 : sc.minutes) : 1);
  const [unit, setUnit] = useState<"min" | "hour">(sc.kind === "interval" && sc.minutes % 60 !== 0 ? "min" : "hour");
  const [once, setOnce] = useState(sc.kind === "once" ? toLocalInput(sc.at) : toLocalInput(Date.now() + 3600_000));
  const [end, setEnd] = useState(toLocalInput(init.endAt));
  const [ws, setWs] = useState(init.workspace ?? "");
  const [provider, setProvider] = useState(init.provider ?? "");
  const [model, setModel] = useState(init.model ?? "");
  const [access, setAccess] = useState<"read" | "ask">(init.access ?? "read");
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false);
  useEffect(() => void api.listRepos().then(setRepos).catch(() => setRepos([])), []);
  // 模型候选：取所选 Agent（没选就是默认的）已保存 Key 能列出来的模型；取不到就只能手输
  const [modelList, setModelList] = useState<{ models: string[]; labels: Record<string, string> }>({ models: [], labels: {} });
  const modelOf = provider || state.defaultProvider;
  useEffect(() => {
    let alive = true;
    setModelList({ models: [], labels: {} });
    void api
      .providerModels(modelOf, {})
      .then(r => alive && r.ok && setModelList({ models: r.models ?? [], labels: r.labels ?? {} }))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [modelOf]);

  const schedule = (): Schedule => {
    if (kind === "daily") return { kind, time };
    if (kind === "weekly") return { kind, days, time };
    if (kind === "interval") return { kind, minutes: Math.round(every * (unit === "hour" ? 60 : 1)) };
    return { kind: "once", at: fromLocalInput(once) ?? 0 };
  };
  const preview = (() => {
    const s = schedule();
    const n = nextRun(s, Date.now());
    return n ? `下次运行：${fmtWhen(n)}` : "";
  })();

  const req = useRequired();
  const save = async () => {
    setErr("");
    const miss = req.check([
      { key: "name", label: "名称", ok: !!name.trim() },
      { key: "prompt", label: "让 Agent 做什么", ok: !!prompt.trim() },
      ...(kind === "daily" || kind === "weekly" ? [{ key: "time", label: "运行时间", ok: !!time }] : []),
      ...(kind === "weekly" ? [{ key: "days", label: "每周哪几天", ok: days.length > 0 }] : []),
      ...(kind === "interval" ? [{ key: "every", label: "间隔时长", ok: every > 0 }] : []),
      ...(kind === "once" ? [{ key: "once", label: "运行时间", ok: !!once }] : []),
    ]);
    if (miss) return setErr(miss);
    setSaving(true);
    const r = await api.automationSave({ ...(init.id ? { id: init.id } : {}), name, prompt, schedule: schedule(), workspace: ws || undefined, provider: provider || undefined, model: model.trim() || undefined, access, endAt: fromLocalInput(end), enabled: init.id ? init.enabled : true });
    setSaving(false);
    if (r.ok) onSaved();
    else setErr(r.error ?? "保存失败");
  };

  return (
    <div className="modal-mask" data-testid="auto-editor" role="dialog" aria-modal onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal auto-modal">
        <h3>{init.id ? "编辑自动化任务" : "新建自动化任务"}</h3>

        <label className="auto-field">
          <span>
            名称
            <Req />
          </span>
          <input className={req.cls("name")} data-req="name" data-testid="auto-f-name" placeholder="比如：每日代码巡检" value={name} onChange={e => { setName(e.target.value); req.clear("name"); setErr(""); }} autoFocus />
        </label>
        <label className="auto-field">
          <span>
            让 Agent 做什么
            <Req />
          </span>
          <textarea className={req.cls("prompt")} data-req="prompt" data-testid="auto-f-prompt" rows={5} placeholder="每次运行时发给 Agent 的指令，比如：检查仓库最近一天的提交，列出有风险的改动" value={prompt} onChange={e => (setPrompt(e.target.value), req.clear("prompt"), setErr(""))} />
        </label>

        <div className="auto-field">
          <span>
            什么时候运行
            <Req />
          </span>
          <div className="auto-sched">
            <select className="input" data-testid="auto-f-kind" value={kind} onChange={e => setKind(e.target.value as Schedule["kind"])}>
              <option value="daily">每天</option>
              <option value="weekly">每周</option>
              <option value="interval">每隔一段时间</option>
              <option value="once">只运行一次</option>
            </select>
            {(kind === "daily" || kind === "weekly") && <input className={req.cls("time")} data-req="time" type="time" data-testid="auto-f-time" value={time} onChange={e => (setTime(e.target.value), req.clear("time"))} />}
            {kind === "interval" && (
              <>
                <input className={req.cls("every", "input num")} data-req="every" type="number" min={1} data-testid="auto-f-every" value={every} onChange={e => (setEvery(Number(e.target.value)), req.clear("every"))} />
                <select className="input" data-testid="auto-f-unit" value={unit} onChange={e => setUnit(e.target.value as "min" | "hour")}>
                  <option value="min">分钟</option>
                  <option value="hour">小时</option>
                </select>
              </>
            )}
            {kind === "once" && <input className={req.cls("once")} data-req="once" type="datetime-local" data-testid="auto-f-once" value={once} onChange={e => (setOnce(e.target.value), req.clear("once"))} />}
          </div>
          {kind === "weekly" && (
            <div className={`auto-days${req.bad.includes("days") ? " invalid" : ""}`} data-req="days" tabIndex={-1} data-testid="auto-f-days">
              {[1, 2, 3, 4, 5, 6, 0].map(d => (
                <button key={d} type="button" className={days.includes(d) ? "on" : ""} onClick={() => (req.clear("days"), setDays(v => (v.includes(d) ? v.filter(x => x !== d) : [...v, d])))}>
                  周{WEEK[d]}
                </button>
              ))}
            </div>
          )}
          {kind === "interval" && <div className="muted">最短 {MIN_INTERVAL} 分钟</div>}
          {preview && <div className="muted" data-testid="auto-f-preview">{preview}</div>}
        </div>

        <div className="auto-two">
          <label className="auto-field">
            <span>工作区</span>
            <select
              className="input"
              data-testid="auto-f-ws"
              value={ws}
              onChange={async e => {
                if (e.target.value === "__pick") {
                  const p = await api.pickFolder("选择工作区文件夹");
                  if (p) setWs(p);
                } else setWs(e.target.value);
              }}
            >
              <option value="">默认工作区</option>
              {repos.map(r => (
                <option key={r.name} value={r.path}>
                  {r.name}
                </option>
              ))}
              {ws && !repos.some(r => r.path === ws) && <option value={ws}>{ws}</option>}
              <option value="__pick">选择文件夹…</option>
            </select>
          </label>
          <label className="auto-field">
            <span>Agent</span>
            <SearchSelect
              testid="auto-f-provider"
              value={provider}
              onChange={v => (setProvider(v), setModel(""))}
              searchPlaceholder="搜索 Agent"
              options={[{ value: "", label: `默认（${state.defaultProvider}）` }, ...state.providers.map(p => ({ value: p.name, label: p.name, hint: p.kind === "agent" ? "外部 Agent" : undefined }))]}
            />
          </label>
        </div>
        <div className="auto-two">
          <label className="auto-field">
            <span>模型（可选）</span>
            <SearchSelect
              allowCustom
              testid="auto-f-model"
              value={model}
              onChange={setModel}
              placeholder="不选用 Agent 的默认模型"
              searchPlaceholder="搜索模型，或直接输入模型名"
              options={[{ value: "", label: "默认（Agent 的默认模型）" }, ...modelList.models.map(m => ({ value: m, label: modelList.labels[m] ?? m, hint: modelList.labels[m] ? m : undefined }))]}
            />
          </label>
          <label className="auto-field">
            <span>结束时间（可选）</span>
            <input className="input" type="datetime-local" data-testid="auto-f-end" value={end} onChange={e => setEnd(e.target.value)} />
          </label>
        </div>

        <div className="auto-field">
          <span>权限</span>
          <div className="seg" data-testid="auto-f-access">
            <button type="button" className={access === "read" ? "on" : ""} onClick={() => setAccess("read")}>
              只读（推荐）
            </button>
            <button type="button" className={access === "ask" ? "on" : ""} onClick={() => setAccess("ask")}>
              需要时询问我
            </button>
          </div>
          <div className="muted">{access === "read" ? "不给 Agent 写文件、执行命令的工具，需要确认的操作一律拒绝，适合无人值守。" : "写文件、执行命令前会弹窗问你；你不在电脑前时会一直等着，直到你回来确认。"}</div>
        </div>

        {err && (
          <div className="px-msg bad" data-testid="auto-f-err">
            {err}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" data-testid="auto-f-cancel" onClick={onClose}>
            取消
          </button>
          <button className="btn primary" data-testid="auto-f-save" disabled={saving} onClick={() => void save()}>
            {saving ? <span className="spinner" /> : null} 保存
          </button>
        </div>
      </div>
    </div>
  );
}

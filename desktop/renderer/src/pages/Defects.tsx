import { useEffect, useMemo, useRef, useState } from "react";
import { ENTRY_NAME, SOURCE_NAME, defectKey, type Defect, type DefectTransitions, type DefectsResult } from "../../../shared/defects";
import { api } from "../api";
import { Icon } from "../components/Icon";

const hhmm = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};
const day = (ms: number) => {
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};

/** 状态的颜色：待处理偏黄、处理中偏蓝、已解决偏绿 */
function statusClass(s: string): string {
  if (/resolved|已解决|已修复|待验证|待测试|完成/i.test(s)) return "ok";
  if (/progress|处理中|修复中|进行中|开发中/i.test(s)) return "run";
  if (/open|new|待处理|待办|未开始|新建|待修复|reopen/i.test(s)) return "warn";
  return "";
}

/** 指派给我的缺陷：飞书项目的缺陷 / 钉钉待办；能直接流转状态 */
export function Defects({ result }: { result: DefectsResult | null }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  /** 刚进来时哪些是新的：只在这一次打开里高亮，随后标记为已看 */
  const fresh = useRef(new Set<string>());
  for (const d of result?.items ?? []) if (d.isNew) fresh.current.add(defectKey(d));

  useEffect(() => {
    if (result?.enabled && result.items.some(d => d.isNew)) void api.defectsSeen();
  }, [result]);
  // 打开页面时也刷新一次，拿最新的
  useEffect(() => {
    void api.defectsRefresh();
  }, []);

  const source = result?.source ?? "feishu";
  const items = result?.items ?? [];
  const statuses = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of items) m.set(d.status, (m.get(d.status) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1]);
  }, [items]);
  const shown = useMemo(() => {
    const k = q.trim().toLowerCase();
    const l = items.filter(d => (!status || d.status === status) && (!k || `${d.title} ${d.space ?? ""} ${d.reporter ?? ""} ${d.id}`.toLowerCase().includes(k)));
    // 这次打开后新来的排最前，其余保持原来的（最近更新在前）顺序
    return l.sort((a, b) => Number(fresh.current.has(defectKey(b))) - Number(fresh.current.has(defectKey(a))));
  }, [items, status, q]);

  const refresh = async () => {
    setBusy(true);
    setMsg(null);
    await api.defectsRefresh();
    setBusy(false);
  };

  return (
    <section className="auto bug" data-testid="defects">
      <div className="auto-inner">
        <header className="auto-head">
          <div>
            <h1>{ENTRY_NAME[source]}</h1>
            {result?.ok && (
              <div className="bug-sub" data-testid="defect-sub">
                {result.user ? `指派给 ${result.user} · ` : ""}共 {items.length} 个待处理 · 更新于 {hhmm(result.at)}
              </div>
            )}
          </div>
          <button className="btn" data-testid="defect-refresh" disabled={busy} onClick={() => void refresh()}>
            {busy ? <span className="spinner" /> : <Icon name="refresh" size={14} />} 刷新
          </button>
        </header>

        {result && !result.ok && (
          <div className="px-msg bad" data-testid="defect-error">
            {SOURCE_NAME[source]}取数失败：{result.error}
            {items.length > 0 && "（下面是上一次的结果）"}
          </div>
        )}
        {result?.warnings && result.warnings.length > 0 && (
          <div className="px-msg warn" data-testid="defect-warn" title={result.warnings.join("\n")}>
            有 {result.warnings.length} 个空间没查成功：{result.warnings[0]}
          </div>
        )}
        {msg && (
          <div className={`px-msg ${msg.ok ? "ok" : "bad"}`} data-testid="defect-msg">
            {msg.text}
          </div>
        )}

        {statuses.length > 1 && (
          <div className="auto-tabs" role="tablist">
            <button className={`auto-tab ${status === "" ? "on" : ""}`} data-testid="defect-filter" onClick={() => setStatus("")}>
              全部<span className="auto-count">{items.length}</span>
            </button>
            {statuses.map(([s, n]) => (
              <button key={s} className={`auto-tab ${status === s ? "on" : ""}`} data-testid="defect-filter" onClick={() => setStatus(status === s ? "" : s)}>
                {s}
                <span className="auto-count">{n}</span>
              </button>
            ))}
          </div>
        )}
        <label className="auto-search">
          <Icon name="search" size={14} />
          <input data-testid="defect-search" placeholder="搜索标题、空间、提出人" value={q} onChange={e => setQ(e.target.value)} />
        </label>

        {result && result.ok && shown.length === 0 && (
          <div className="auto-empty" data-testid="defect-empty">
            <span className="auto-empty-ico">
              <Icon name="bug" size={34} />
            </span>
            <p>{q || status ? "没有找到匹配的问题" : source === "feishu" ? "没有指派给你的待处理缺陷" : "没有未完成的待办"}</p>
          </div>
        )}
        {!result && (
          <div className="auto-empty">
            <span className="spinner" />
          </div>
        )}

        <div className="auto-list">
          {shown.map(d => (
            <DefectCard key={defectKey(d)} d={d} isNew={fresh.current.has(defectKey(d))} onDone={t => (setMsg(t), void api.defectsRefresh())} />
          ))}
        </div>
      </div>
    </section>
  );
}

function DefectCard({ d, isNew, onDone }: { d: Defect; isNew: boolean; onDone: (m: { ok: boolean; text: string }) => void }) {
  const key = defectKey(d);
  const [panel, setPanel] = useState<"closed" | "loading" | "open">("closed");
  const [tr, setTr] = useState<DefectTransitions | null>(null);
  const [pick, setPick] = useState<{ id: string; name: string } | null>(null);
  const [doing, setDoing] = useState(false);
  const [err, setErr] = useState("");

  const toggle = async () => {
    if (panel !== "closed") {
      setPanel("closed");
      setPick(null);
      return;
    }
    setPanel("loading");
    setErr("");
    setTr(await api.defectsTransitions(key));
    setPanel("open");
  };
  const run = async () => {
    if (!pick) return;
    setDoing(true);
    setErr("");
    const r = await api.defectsTransition(key, pick.id);
    setDoing(false);
    if (r.ok) {
      setPanel("closed");
      setPick(null);
      onDone({ ok: true, text: `「${d.title}」已流转到 ${pick.name}` });
    } else setErr(r.error ?? "流转失败");
  };

  const when = d.created ?? d.updated;
  return (
    <article className="auto-card bug-card" data-testid="defect-item" data-id={d.id} data-new={isNew ? "1" : undefined}>
      <div className="auto-row">
        <div className="auto-main">
          <div className="auto-name">
            {isNew && (
              <span className="bug-new" data-testid="defect-new">
                新
              </span>
            )}
            <b data-testid="defect-title" title={d.title}>
              {d.title}
            </b>
          </div>
          <div className="auto-meta">
            {d.priority && <span className="bug-pri">{d.priority}</span>}
            {d.space && (
              <span>
                {d.space}
                {d.typeName ? ` · ${d.typeName}` : ""}
              </span>
            )}
            {d.reporter && <span>{d.reporter} 提出</span>}
            {when && <span>{day(when)}</span>}
            {d.due && <span>截止 {day(d.due)}</span>}
            {d.severity && <span>严重程度 {d.severity}</span>}
          </div>
        </div>
        <div className="auto-acts">
          <span className={`chip ${statusClass(d.status)}`} data-testid="defect-status">
            {d.status}
          </span>
          <button className={`btn sm ${panel !== "closed" ? "on" : ""}`} data-testid="defect-flow" onClick={() => void toggle()}>
            {panel === "loading" ? <span className="spinner" /> : <Icon name="right" size={12} />} 流转状态
          </button>
          {d.url && (
            <a className="btn sm icon" href={d.url} target="_blank" rel="noreferrer" title={`在${d.source === "feishu" ? "飞书项目" : "钉钉"}里打开`} data-testid="defect-open">
              <Icon name="link" size={13} />
            </a>
          )}
        </div>
      </div>

      {panel === "open" && tr && (
        <div className="bug-flow" data-testid="defect-flow-panel">
          {!tr.ok ? (
            <div className="muted" data-testid="defect-flow-err">
              {tr.error}
              {d.url && (
                <>
                  ，
                  <a className="link" href={d.url} target="_blank" rel="noreferrer">
                    去原系统处理
                  </a>
                </>
              )}
            </div>
          ) : tr.items.length === 0 ? (
            <div className="muted">当前状态没有可流转的下一步</div>
          ) : (
            <>
              <span className="muted">
                {tr.current ?? d.status} →
              </span>
              {tr.items.map(t => (
                <button
                  key={t.id}
                  className={`btn sm ${pick?.id === t.id ? "primary" : ""}`}
                  data-testid="defect-to"
                  data-id={t.id}
                  disabled={doing || !!t.needsForm}
                  title={t.needsForm ? "这个流转需要填写表单，请到原系统里操作" : `流转到 ${t.name}`}
                  onClick={() => setPick({ id: t.id, name: t.name })}
                >
                  {t.name}
                  {t.needsForm ? "（需填表单）" : ""}
                </button>
              ))}
            </>
          )}
          {pick && (
            <span className="bug-confirm">
              将状态改为「{pick.name}」？
              <button className="btn sm primary" data-testid="defect-confirm" disabled={doing} onClick={() => void run()}>
                {doing ? <span className="spinner" /> : null} 确认
              </button>
              <button className="btn sm" data-testid="defect-cancel" disabled={doing} onClick={() => setPick(null)}>
                取消
              </button>
            </span>
          )}
          {err && (
            <div className="px-msg bad bug-err" data-testid="defect-flow-fail">
              {err}
            </div>
          )}
        </div>
      )}
    </article>
  );
}

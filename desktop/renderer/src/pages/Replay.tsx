import { useEffect, useMemo, useState } from "react";
import type { TraceInfo, TraceLineDTO } from "../../../shared/api";
import { api, cut } from "../api";
import { Icon } from "../components/Icon";
import { RunSteps } from "../components/Steps";
import { buildRunView } from "../lib/steps";

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return new Date(ms).toLocaleDateString();
}

const REASON: Record<string, { label: string; cls: string }> = {
  final: { label: "完成", cls: "ok" },
  error: { label: "失败", cls: "bad" },
  aborted: { label: "中断", cls: "warn" },
  max_steps: { label: "超步数", cls: "warn" },
};

export function Replay() {
  const [list, setList] = useState<TraceInfo[]>([]);
  const [sel, setSel] = useState<TraceInfo | null>(null);
  const [lines, setLines] = useState<TraceLineDTO[]>([]);
  const [error, setError] = useState("");

  const refresh = () => api.listTraces().then(setList);
  useEffect(() => void refresh(), []);

  const open = async (t: TraceInfo) => {
    setSel(t);
    setError("");
    try {
      setLines(await api.readTrace(t.file));
    } catch (e: any) {
      setLines([]);
      setError(e?.message ?? String(e));
    }
  };

  const events = useMemo(() => lines.map(l => l.event), [lines]);
  const view = useMemo(() => buildRunView(events, lines.map(l => l.ts)), [events, lines]);
  const r = sel ? REASON[sel.reason] : undefined;

  return (
    <div className="split-page">
      <section className="listpane">
        <header className="topbar">
          <div className="topbar-title">历史运行</div>
          <span className="spacer" />
          <button className="icon-btn" onClick={refresh} title="刷新">
            <Icon name="refresh" size={16} />
          </button>
        </header>
        <div className="scroll">
          {!list.length && (
            <div className="empty">
              <Icon name="history" size={24} />
              <div>还没有记录。每次运行都会自动保存，可以随时回放。</div>
            </div>
          )}
          {list.map(t => (
            <button key={t.file} data-testid="trace-item" className={`run-item ${sel?.file === t.file ? "sel" : ""}`} onClick={() => open(t)}>
              <div className="run-item-title">{cut(t.input || t.name, 56)}</div>
              <div className="run-item-sub">
                <span className={`dot ${REASON[t.reason]?.cls ?? ""}`} />
                <span>{t.provider || "—"}</span>
                <span>·</span>
                <span>{ago(t.mtime)}</span>
                <span>·</span>
                <span>{(t.size / 1024).toFixed(1)}KB</span>
              </div>
            </button>
          ))}
        </div>
      </section>

      <section className="detailpane">
        <header className="topbar">
          <div className="topbar-title">{sel ? cut(sel.input || sel.name, 60) : "回放"}</div>
          {r && <span className={`chip ${r.cls}`}>{r.label}</span>}
          <span className="spacer" />
          {sel && (
            <button className="icon-btn" onClick={() => api.openPath(sel.file)} title="在文件夹中显示">
              <Icon name="folder" size={16} />
              <span>定位文件</span>
            </button>
          )}
        </header>
        <div className="scroll pad">
          {error && <div className="inline-warn">{error}</div>}
          {sel ? (
            <div className="detail-inner">
              {view.input && (
                <div className="prompt-card">
                  <div className="tool-label">任务</div>
                  <div>{view.input}</div>
                </div>
              )}
              <RunSteps view={view} events={events} />
              {view.done?.text && view.done.reason === "final" && (
                <div className="prompt-card">
                  <div className="tool-label">最终回答</div>
                  <div className="prewrap">{view.done.text}</div>
                </div>
              )}
            </div>
          ) : (
            <div className="empty">
              <Icon name="history" size={24} />
              <div>选择左侧一条记录，按步骤查看每次模型决策与工具调用。回放不会调用模型。</div>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

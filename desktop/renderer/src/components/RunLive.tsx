import { useEffect, useRef, useState } from "react";
import { explainRunError } from "../lib/runError";
import type { LogEntry, RunView } from "../lib/steps";
import { Icon } from "./Icon";

/** 超过这么久没有任何新输出，就提醒用户 Agent 可能卡住了 */
export const STALL_MS = 45_000;

/** 运行中每秒刷新一次的「现在时间」，用来显示已运行多久 / 多久没有新输出 */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

const dur = (ms: number) => (ms < 1000 ? "不到 1 秒" : ms < 60_000 ? `${Math.floor(ms / 1000)} 秒` : `${Math.floor(ms / 60_000)} 分 ${Math.floor((ms % 60_000) / 1000)} 秒`);

const LABEL: Record<LogEntry["kind"], string> = { thinking: "思考", text: "输出", tool: "工具", status: "状态", error: "错误" };

/** 过程日志：思考 / 回复 / 工具调用 / 状态 / 错误，各用各的样式 */
export function LogList({ log, live }: { log: LogEntry[]; live?: boolean }) {
  return (
    <div className="loglist" data-testid="log-list">
      {log.map((e, i) => (
        <div key={i} className={`log-item ${e.kind}`} data-kind={e.kind}>
          <span className="log-tag">{LABEL[e.kind]}</span>
          <div className="log-text">
            {e.text}
            {live && i === log.length - 1 && e.kind === "thinking" && <span className="log-caret" />}
          </div>
        </div>
      ))}
    </div>
  );
}

/** 运行中的实时面板：当前在做什么、已运行多久、AI 的思考细节；很久没动静时提醒可能卡住了 */
export function LiveLog({ view, startedAt, lastAt }: { view: RunView; startedAt?: number; lastAt?: number }) {
  const now = useNow(true);
  const elapsed = startedAt ? Math.max(0, now - startedAt) : 0;
  const idle = Math.max(0, now - (lastAt ?? startedAt ?? now));
  const stalled = idle > STALL_MS;
  const body = useRef<HTMLDivElement>(null);
  const tail = view.log[view.log.length - 1];
  useEffect(() => {
    const el = body.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [view.log.length, tail?.text.length]);

  return (
    <div className="live" data-testid="live-log">
      <div className="live-head">
        <span className="typing">
          <i />
          <i />
          <i />
        </span>
        <b>{view.activity ?? "准备中…"}</b>
        {startedAt && <span className="live-time">已运行 {dur(elapsed)}</span>}
      </div>
      {stalled && (
        <div className="live-stall" data-testid="live-stall">
          <Icon name="alert" size={14} />
          <span>已经 {dur(idle)}没有收到新的输出。Agent 可能在等模型响应，也可能卡住了——可以再等一会儿；一直没动静就点右下角「停止」，检查网络或换个模型后重试。</span>
        </div>
      )}
      {view.log.length > 0 ? (
        <div className="live-body" ref={body}>
          <LogList log={view.log} live />
        </div>
      ) : (
        <div className="live-empty">还没有收到过程输出。Agent 一开始思考、调用工具，这里就会实时显示。</div>
      )}
    </div>
  );
}

/** 失败 / 中断：说清楚出了什么事、怎么办，并附上失败前最后的输出 */
export function RunFailure({ text, aborted, log }: { text: string; aborted?: boolean; log?: LogEntry[] }) {
  const ex = explainRunError(text, aborted);
  const lastLog = (log ?? []).slice(-6);
  return (
    <div className={`runfail${ex.userAborted ? " soft" : ""}`} data-testid="run-failure">
      <div className="runfail-head">
        <Icon name="alert" size={15} />
        <b>{ex.title}</b>
      </div>
      {ex.detail && <p className="runfail-detail">{ex.detail}</p>}
      {ex.hints.length > 0 && (
        <ul className="runfail-hints">
          {ex.hints.map(h => (
            <li key={h}>{h}</li>
          ))}
        </ul>
      )}
      {lastLog.length > 0 && !ex.userAborted && (
        <div className="runfail-last">
          <div className="runfail-sub">失败前最后的输出</div>
          <LogList log={lastLog} />
        </div>
      )}
      {ex.raw && !ex.userAborted && (
        <details className="runfail-raw">
          <summary>原始错误信息</summary>
          <pre>{ex.raw}</pre>
        </details>
      )}
    </div>
  );
}

/** 事件流卡片里的一行小结：运行中显示最新思考，失败时显示原因 */
export function flowSnippet(view: RunView | null, status?: string, text?: string): { kind: "think" | "err" | "info"; text: string } | null {
  if (status === "running" && view) {
    const t = [...view.log].reverse().find(e => e.kind === "thinking" || e.kind === "text" || e.kind === "tool");
    if (!t) return null;
    const s = t.text.replace(/\s+/g, " ").trim();
    return { kind: t.kind === "thinking" ? "think" : "info", text: s.length > 90 ? "…" + s.slice(-90) : s };
  }
  if (status === "error") {
    const ex = explainRunError(text ?? "");
    return { kind: "err", text: ex.title };
  }
  if (status === "aborted") {
    const ex = explainRunError(text ?? "", true);
    return { kind: "info", text: ex.title };
  }
  return null;
}

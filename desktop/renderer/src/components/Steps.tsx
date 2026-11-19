import { useState } from "react";
import type { HarnessEvent } from "../../../shared/api";
import { argSummary, fmtMs, type RunView, type Step, type ToolRun } from "../lib/steps";
import { AskedCard } from "./AskCard";
import { Icon, type IconName } from "./Icon";
import { RawEvents } from "./Timeline";

const TOOL_ICON: Record<string, IconName> = {
  read_file: "file",
  write_file: "edit",
  list_dir: "list",
  run_command: "terminal",
  http_request: "globe",
  git_read: "list",
  git_write: "edit",
  git_repos: "folder",
  feishu_project_read: "list",
  feishu_project_my_todo: "list",
  feishu_project_inspect: "list",
  feishu_project_write: "edit",
  dingtalk_project_read: "list",
  dingtalk_project_inspect: "list",
  dingtalk_project_write: "edit",
};

const STATUS: Record<ToolRun["status"], { label: string; cls: string }> = {
  running: { label: "执行中", cls: "run" },
  ok: { label: "完成", cls: "ok" },
  blocked: { label: "已拦截", cls: "bad" },
  denied: { label: "已拒绝", cls: "bad" },
};

function pretty(v: unknown, max = 12000): string {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > max ? s.slice(0, max) + `\n…（已截断 ${s.length - max} 字符）` : s;
}

export function ToolCard({ t }: { t: ToolRun }) {
  const [open, setOpen] = useState(false);
  const st = STATUS[t.status];
  // AI 向操作人提的问题：像一张问答记录，不当普通工具展示
  if (t.name === "ask_user" && t.status !== "blocked" && t.status !== "denied") return <AskedCard args={t.args} output={t.output} running={t.status === "running"} />;
  const sum = argSummary(t.name, t.args);
  const expandable = t.args !== undefined || t.output !== undefined || t.reason;
  return (
    <div className={`tool ${st.cls}`}>
      <button className="tool-head" onClick={() => expandable && setOpen(!open)} aria-expanded={open}>
        <span className="tool-icon">
          <Icon name={TOOL_ICON[t.name] ?? "spark"} size={15} />
        </span>
        <span className="tool-name">{t.name}</span>
        {sum && <span className="tool-sum">{sum}</span>}
        <span className="spacer" />
        {t.approved === true && <span className="chip warn">已批准</span>}
        <span className={`chip ${st.cls}`}>
          {t.status === "running" && <span className="spinner" />}
          {st.label}
        </span>
        {t.ms !== undefined && <span className="tool-ms">{fmtMs(t.ms)}</span>}
        {expandable && <Icon name={open ? "down" : "right"} size={14} className="caret" />}
      </button>
      {open && (
        <div className="tool-body">
          {t.reason && <div className="tool-reason">{t.reason}</div>}
          {t.args !== undefined && (
            <>
              <div className="tool-label">参数</div>
              <pre>{pretty(t.args)}</pre>
            </>
          )}
          {t.output !== undefined && (
            <>
              <div className="tool-label">返回</div>
              <pre>{pretty(t.output)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function StepBlock({ s, last, isFinal }: { s: Step; last: boolean; isFinal: boolean }) {
  const label = isFinal ? "生成回答" : s.tools.length ? "决定调用工具" : "推理";
  return (
    <div className="step">
      <div className="step-rail">
        <span className="step-dot">{s.n}</span>
        {!last && <span className="step-line" />}
      </div>
      <div className="step-main">
        <div className="step-head">
          <Icon name="brain" size={14} />
          <b>{label}</b>
          <span className="muted">
            {[s.ms !== undefined && fmtMs(s.ms), s.tokens ? `${s.tokens} token` : ""].filter(Boolean).join(" · ")}
          </span>
        </div>
        {s.text && !isFinal && <div className="step-text">{s.text}</div>}
        {s.tools.map((t, i) => (
          <ToolCard key={i} t={t} />
        ))}
      </div>
    </div>
  );
}

export function RunSteps({ view, events, running }: { view: RunView; events: HarnessEvent[]; running?: boolean }) {
  const doneOk = view.done?.reason === "final";
  const lastIdx = view.steps.length - 1;
  return (
    <div className="runsteps">
      <div className="stats" style={view.external ? { gridTemplateColumns: "repeat(2, 1fr)" } : undefined}>
        {!view.external && (
          <div className="stat">
            <b>{view.steps.length}</b>
            <span>步</span>
          </div>
        )}
        <div className="stat">
          <b>{view.toolCount}</b>
          <span>工具调用</span>
        </div>
        {!view.external && (
          <div className="stat">
            <b>{view.tokens}</b>
            <span>token</span>
          </div>
        )}
        <div className="stat">
          <b>{fmtMs(view.totalMs) || "—"}</b>
          <span>耗时</span>
        </div>
      </div>

      {view.notes.map((n, i) => (
        <div key={i} className="note">
          <Icon name="alert" size={14} /> {n}
        </div>
      ))}

      {view.steps.length > 0 && (
        <div className="steps">
          {view.steps.map((s, i) => (
            <StepBlock key={s.n} s={s} last={i === lastIdx && !(running && view.activity)} isFinal={doneOk && i === lastIdx && s.tools.length === 0} />
          ))}
          {running && view.activity && (
            <div className="step">
              <div className="step-rail">
                <span className="step-dot live" />
              </div>
              <div className="step-main">
                <div className="step-head live-text">
                  <span className="spinner" /> {view.activity}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {view.progress.length > 0 && (
        <div className="agentlog">
          <div className="tool-label">Agent 输出</div>
          <pre>{view.progress.slice(-200).join("\n")}</pre>
        </div>
      )}

      {view.done && !doneOk && (
        <div className="result bad">
          <Icon name="alert" size={15} />
          <div>
            <b>{view.done.reason === "aborted" ? "已中断" : view.done.reason === "max_steps" ? "达到最大步数" : "运行失败"}</b>
            {view.done.error && <div className="muted">{view.done.error}</div>}
          </div>
        </div>
      )}

      {events.length > 0 && (
        <details className="raw">
          <summary>
            <Icon name="right" size={13} /> 原始事件（含发给模型的完整消息）
          </summary>
          <RawEvents events={events} />
        </details>
      )}
    </div>
  );
}

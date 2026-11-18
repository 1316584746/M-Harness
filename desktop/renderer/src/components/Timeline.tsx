import type { HarnessEvent } from "../../../shared/api";

function pretty(v: unknown, max = 30000): string {
  const s = typeof v === "string" ? v : JSON.stringify(v, null, 2);
  return s.length > max ? s.slice(0, max) + `\n…（已截断 ${s.length - max} 字符）` : s;
}

function label(e: HarnessEvent): string {
  switch (e.type) {
    case "run_start":
      return `run_start · ${e.provider}`;
    case "model_call":
      return `model_call · 第 ${e.step} 步 · ${e.messages.length} 条消息`;
    case "model_reply":
      return `model_reply · 第 ${e.step} 步 · ${e.ms}ms · ${e.tokens}tok`;
    case "tool_call":
      return `tool_call · ${e.name}`;
    case "tool_result":
      return `tool_result · ${e.name} · ${e.ms}ms`;
    case "tool_blocked":
      return `tool_blocked · ${e.name} · ${e.reason}`;
    case "approval":
      return `approval · ${e.name} · ${e.approved ? "通过" : "拒绝"}`;
    case "agent_progress":
      return `agent_progress · ${e.line.slice(0, 80)}`;
    case "context_trim":
      return `context_trim · ${e.before}→${e.after}`;
    case "done":
      return `done · ${e.reason}`;
  }
}

function payload(e: HarnessEvent): unknown {
  switch (e.type) {
    case "model_call":
      return e.messages;
    case "model_reply":
      return e.reply;
    case "tool_call":
      return e.args;
    case "tool_result":
      return e.output;
    case "approval":
      return e.args;
    case "done":
      return e.text || e.error;
    case "agent_progress":
      return e.line;
    default:
      return undefined;
  }
}

export function RawEvents({ events }: { events: HarnessEvent[] }) {
  return (
    <div className="rawlist">
      {events.map((e, i) => {
        const p = payload(e);
        return p !== undefined && p !== "" ? (
          <details key={i} className="rawrow">
            <summary>{label(e)}</summary>
            <pre>{pretty(p)}</pre>
          </details>
        ) : (
          <div key={i} className="rawrow flat">
            {label(e)}
          </div>
        );
      })}
    </div>
  );
}

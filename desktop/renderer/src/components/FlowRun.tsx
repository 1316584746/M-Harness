import { useEffect, useState } from "react";
import { briefSegs, buildFlow, itemsSummary, segStats, toolArgLine, toolKind, type FlowItem, type FlowSeg, type ToolKind } from "../lib/flow";
import type { HarnessEvent } from "../../../shared/api";
import { fmtMs } from "../lib/steps";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

const hhmm = (t: number) => (t ? new Date(t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) : "");

/** 秒级时长：46s / 1m05s */
const sec = (ms: number) => (ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m${String(Math.round((ms % 60_000) / 1000)).padStart(2, "0")}s`);

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

const TOOL_ICON: Record<ToolKind, "file" | "search" | "edit" | "terminal"> = { read: "file", search: "search", edit: "edit", run: "terminal", other: "terminal" };

function Row({ it }: { it: FlowItem }) {
  const [open, setOpen] = useState(false);
  if (it.kind === "think") {
    const one = it.text.replace(/\s+/g, " ").trim();
    return (
      <button className={`ft-row think${open ? " open" : ""}`} onClick={() => setOpen(!open)} aria-expanded={open} data-testid="ft-row" data-kind="think">
        <span className="ft-chev">
          <Icon name={open ? "down" : "right"} size={11} />
        </span>
        <Icon name="brain" size={13} />
        <span className="ft-tag">思考</span>
        {open ? <span className="ft-full">{it.text.trim()}</span> : <span className="ft-line">{one}</span>}
      </button>
    );
  }
  if (it.kind === "tool") {
    const line = toolArgLine(it.name, it.arg);
    const has = !!it.output;
    return (
      <div className={`ft-tool ${it.status}`} data-testid="ft-row" data-kind="tool">
        <button className={`ft-row tool${has ? " can" : ""}`} onClick={() => has && setOpen(!open)} aria-expanded={has ? open : undefined} title={line ? `${it.name} ${line}` : it.name}>
          <span className="ft-chev">{has && <Icon name={open ? "down" : "right"} size={11} />}</span>
          <Icon name={TOOL_ICON[toolKind(it.name)]} size={13} />
          <b className="ft-name">{it.name}</b>
          <span className="ft-line mono">{line}</span>
          {it.status === "running" ? <span className="spinner" /> : it.status === "fail" ? <span className="ft-ms bad">失败</span> : <Icon name="check" size={12} className="ft-ok" />}
          {it.ms !== undefined && <span className="ft-ms">{fmtMs(it.ms)}</span>}
        </button>
        {open && has && <pre className="ft-out">{it.output}</pre>}
      </div>
    );
  }
  return (
    <div className={`ft-row ${it.kind}`} data-testid="ft-row" data-kind={it.kind}>
      <Icon name={it.kind === "error" ? "alert" : "info"} size={13} />
      <span className="ft-line">{it.text}</span>
    </div>
  );
}

function Seg({ seg, endAt, live, i }: { seg: FlowSeg; endAt: number; live: boolean; i: number }) {
  const [open, setOpen] = useState<boolean | undefined>(undefined);
  // 默认都折叠（运行中也一样）：事件流只看「说了什么 + 几步 + 多久」，要看细节再点开
  const isOpen = open ?? false;
  const { steps, ms } = segStats(seg, endAt);
  const sum = itemsSummary(seg.items);
  const failed = seg.items.some(x => (x.kind === "tool" && x.status === "fail") || x.kind === "error");
  return (
    <div className="ft-seg" data-testid="ft-seg">
      {hhmm(seg.at) && <div className="ft-time">{hhmm(seg.at)}</div>}
      {seg.say && (
        <div className="ft-say">
          <Markdown text={seg.say} />
        </div>
      )}
      {steps > 0 && (
        <>
          <button className="ft-group" aria-expanded={isOpen} onClick={() => setOpen(!isOpen)} data-testid="ft-group" data-i={i}>
            <Icon name={isOpen ? "down" : "right"} size={12} />
            <span>工作过程</span>
            <span className="ft-dot">·</span>
            <span>{steps} 步</span>
            {sum && (
              <>
                <span className="ft-dot">·</span>
                <span className="ft-sum">{sum}</span>
              </>
            )}
            {ms > 0 && (
              <>
                <span className="ft-dot">·</span>
                <span>{sec(ms)}</span>
              </>
            )}
            {failed && <Icon name="alert" size={12} className="ft-failed" />}
          </button>
          {isOpen && (
            <div className="ft-items">
              {seg.items.map((it, k) => (
                <Row key={k} it={it} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** 一轮 AI 的过程：每段「AI 说的话 + 可折叠的工作过程（思考 / 工具调用，一行一条）」 */
export function FlowTranscript({ events, times, startedAt, endedAt, running, brief }: { events: HarnessEvent[]; times?: number[]; startedAt?: number; endedAt?: number; running: boolean; /** 推进动作：不重复贴整份产物，只留简短进度 */ brief?: boolean }) {
  const now = useNow(running);
  const all = buildFlow(events, times, startedAt ?? 0);
  const segs = brief ? briefSegs(all, running) : all;
  if (!segs.length) return null;
  const end = (k: number) => (k + 1 < segs.length ? segs[k + 1].at : running ? now : endedAt ?? times?.at(-1) ?? segs[k].at);
  return (
    <div className="ft" data-testid="flow-transcript">
      {segs.map((s, k) => (
        <Seg key={k} seg={s} i={k} endAt={end(k)} live={running && k === segs.length - 1} />
      ))}
    </div>
  );
}

/** 运行中的状态行：正在做什么 · 距上一次动静多久（如「正在分析 shell 的结果 · 8s」） */
export function liveStatus(events: HarnessEvent[], times: number[] | undefined, startedAt: number | undefined): { text: string; since: number | undefined } {
  const segs = buildFlow(events, times, startedAt ?? 0);
  const last = segs.at(-1);
  const it = last?.items.at(-1);
  const since = times?.at(-1) ?? startedAt;
  // 还没有任何说明 / 步骤：多半是在创建 Agent、等对方开始处理，直接说实话，别一律写「思考中」
  if (!last) {
    const st = [...events].reverse().find((e): e is Extract<HarnessEvent, { type: "agent_progress" }> => e.type === "agent_progress" && e.kind === "status");
    return { text: st ? st.line.replace(/\s+/g, " ").trim().slice(0, 60) : events.length ? "思考中…" : "准备中…", since };
  }
  if (!it) return { text: "思考中…", since };
  if (it.kind === "tool") return { text: it.status === "running" ? `正在执行 ${it.name}` : `正在分析 ${it.name} 的结果`, since };
  if (it.kind === "think") {
    const s = it.text.replace(/\s+/g, " ").trim();
    return { text: s ? `思考：${s.length > 50 ? "…" + s.slice(-50) : s}` : "思考中…", since };
  }
  if (it.kind === "error") return { text: "遇到错误…", since };
  return { text: it.text.slice(0, 60), since };
}

export function FlowLive({ events, times, startedAt }: { events: HarnessEvent[]; times?: number[]; startedAt?: number }) {
  const now = useNow(true);
  const { text, since } = liveStatus(events, times, startedAt);
  return (
    <>
      <span className="spinner" />
      <span className="flow-ai-main">
        <b>
          {text}
          {since ? ` · ${sec(now - since)}` : ""}
        </b>
      </span>
    </>
  );
}

import { useEffect, useMemo, useRef, useState } from "react";
import type { AppState } from "../../../shared/api";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { ModelPicker } from "../components/ModelPicker";
import { ProviderPicker } from "../components/ProviderPicker";
import { ToolsPicker } from "../components/ToolsPicker";
import { WorkspacePicker } from "../components/WorkspacePicker";
import { parseCfg } from "../lib/configEdit";
import { RunSteps, ToolCard } from "../components/Steps";
import { isRunning, type ChatStore, type Turn } from "../lib/chatStore";
import { buildRunView, fmtMs } from "../lib/steps";

const SUGGESTIONS = [
  { icon: "list", text: "列出工作区根目录的文件，并简要说明每个的用途" },
  { icon: "file", text: "读取 package.json，告诉我这个项目用了哪些依赖" },
  { icon: "shield", text: "请执行命令 rm -rf / 清理磁盘，看看会发生什么" },
  { icon: "spark", text: "用三句话解释什么是 Agent Harness" },
] as const;

export function Chat({ state, store, onChanged, prefill }: { state: AppState; store: ChatStore; onChanged: () => void; prefill?: { text: string; n: number } | null }) {
  const { active, provider, workspace } = store;
  const [input, setInput] = useState("");
  const [minH, setMinH] = useState(96);
  const bottom = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);

  const turns = active?.turns ?? [];
  const running = isRunning(active);
  const info = state.providers.find(p => p.name === provider);
  const ws = workspace ?? state.workspace;
  const last = turns.at(-1);
  const repos = useMemo(() => (parseCfg(state.configText)?.repos ?? {}) as Record<string, { path: string; platform?: string }>, [state.configText]);

  // 输入 / 触发「动作」菜单：选中后把动作的提示词模板填进输入框
  const actions = useMemo(() => (parseCfg(state.configText)?.actions ?? []) as Array<{ id: string; name: string; prompt: string }>, [state.configText]);
  const [sel, setSel] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const slash = /^\/(\S*)$/.exec(input);
  const matches = slash && input !== dismissed ? actions.filter(a => a.name.toLowerCase().includes(slash[1].toLowerCase())) : [];
  useEffect(() => setSel(0), [slash?.[1]]);
  const applyAction = (a: { prompt: string }) => {
    const at = a.prompt.indexOf("{{input}}");
    const text = a.prompt.split("{{input}}").join("");
    setInput(text);
    setDismissed(null);
    const caret = at >= 0 ? at : text.length;
    setTimeout(() => {
      area.current?.focus();
      area.current?.setSelectionRange(caret, caret);
    }, 0);
  };

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [active?.id, turns.length, last?.text, last?.events.length]);

  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(Math.max(el.scrollHeight, minH), 420) + "px";
  }, [input, minH]);

  // 每个对话各自保留还没发出去的输入：切走时存起来，切回来时还原（新对话是空的）
  const inputRef = useRef(input);
  inputRef.current = input;
  const drafts = useRef(new Map<string, string>());
  const prevId = useRef(active?.id ?? "");
  useEffect(() => {
    const id = active?.id ?? "";
    if (id === prevId.current) return;
    drafts.current.set(prevId.current, inputRef.current);
    prevId.current = id;
    setInput(drafts.current.get(id) ?? "");
  }, [active?.id]);

  // 工作台等外部入口预填提示词：填进输入框并把光标放到末尾，由用户确认后再发送
  useEffect(() => {
    if (!prefill) return;
    setInput(prefill.text);
    setTimeout(() => {
      area.current?.focus();
      area.current?.setSelectionRange(prefill.text.length, prefill.text.length);
    }, 0);
  }, [prefill?.n]);

  // 切换会话（含「新对话」）时聚焦输入框
  useEffect(() => {
    area.current?.focus();
  }, [active?.id]);

  const send = (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || running) return;
    setInput("");
    void store.send(text, onChanged);
  };

  const insertPaths = (paths: string[]) => {
    const text = paths.map(p => (/\s/.test(p) ? `"${p}"` : p)).join(" ");
    setInput(v => (v && !/\s$/.test(v) ? v + " " : v) + text + " ");
    area.current?.focus();
  };
  const attach = async (kind: "file" | "folder") => {
    const p = kind === "file" ? await api.pickFile("选择要引用的文件") : await api.pickFolder("选择要引用的文件夹");
    if (p) insertPaths([p]);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    const paths = [...e.dataTransfer.files].map(f => api.pathForFile(f)).filter(Boolean);
    if (paths.length) insertPaths(paths);
  };
  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = area.current?.offsetHeight ?? minH;
    const move = (ev: MouseEvent) => setMinH(Math.max(60, Math.min(420, h0 + (y0 - ev.clientY))));
    const up = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
  };

  const pickWs = async () => {
    const p = await api.pickWorkspace();
    if (p) store.setWorkspace(p);
  };

  return (
    <section className="chat-main">
      <header className="topbar">
        <div className="topbar-title">{active?.title ?? "新对话"}</div>
        {active && <span className="tag">{active.provider}</span>}
        <span className="spacer" />
        {active && (
          <span className="muted">
            {turns.filter(t => t.role === "user").length} 轮
          </span>
        )}
      </header>

      <div className="thread">
        <div className="thread-inner">
          {!turns.length ? (
            <div className="hero">
              <div className="hero-mark">
                <Icon name="spark" size={22} />
              </div>
              <h1>要让它做什么？</h1>
              <p className="muted">读文件、列目录直接执行；写文件、执行命令、联网前会先问你。</p>
              <div className="suggest">
                {SUGGESTIONS.map(s => (
                  <button key={s.text} className="suggest-row" onClick={() => setInput(s.text)}>
                    <Icon name={s.icon} size={15} />
                    <span>{s.text}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            turns.map(t => (t.role === "user" ? <UserMsg key={t.id} text={t.text} /> : <AssistantMsg key={t.id} t={t} />))
          )}
          <div ref={bottom} />
        </div>
      </div>

      <div className="composer-wrap">
        <div className="composer-inner">
          {info?.problem && <div className="inline-warn">{info.problem}</div>}
          {info?.kind === "agent" && !info.problem && (
            <div className="inline-note">外部 Agent 使用自己的工具，不受路径沙箱与审批约束；这里可以观察进度并随时停止。</div>
          )}
          <div className="composer" data-testid="composer" onDragOver={e => e.preventDefault()} onDrop={onDrop}>
            {matches.length > 0 && (
              <div className="menu wide" style={{ left: 12 }} data-testid="action-menu">
                <div className="menu-title">动作</div>
                {matches.map((a, i) => (
                  <button key={a.id} type="button" className={`menu-item ${i === sel ? "active" : ""}`} data-testid={`action-item-${a.id}`} onMouseEnter={() => setSel(i)} onMouseDown={e => (e.preventDefault(), applyAction(a))}>
                    <span className="menu-main">
                      <span className="menu-name">/{a.name}</span>
                      <span className="menu-desc">{a.prompt.replace(/\s+/g, " ")}</span>
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="composer-grip" title="拖动调整输入框高度" onMouseDown={startResize} />
            <div className="composer-top">
              <WorkspacePicker current={ws} repos={repos} onPick={store.setWorkspace} onBrowse={pickWs} disabled={running} />
              <ToolsPicker disabled={store.disabledTools} onChange={store.setDisabledTools} busy={running} />
            </div>
            <textarea
              ref={area}
              data-testid="composer-input"
              value={input}
              style={{ minHeight: minH }}
              placeholder={running ? "运行中…可点右下角停止" : "给 Agent 一个任务、拖入文件引用路径（Enter 发送，Shift+Enter 换行）"}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (matches.length && !e.nativeEvent.isComposing) {
                  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    setSel(s => (s + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length);
                    return;
                  }
                  if (e.key === "Enter" || e.key === "Tab") {
                    e.preventDefault();
                    applyAction(matches[sel] ?? matches[0]);
                    return;
                  }
                  if (e.key === "Escape") return setDismissed(input);
                }
                if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  send();
                }
              }}
              rows={1}
            />
            <div className="composer-row">
              <ProviderPicker providers={state.providers} value={provider} onChange={store.setProvider} disabled={running} />
              <ModelPicker provider={provider} info={info} value={store.model} onChange={store.setModel} disabled={running} />
              <span className="spacer" />
              <button type="button" className="icon-btn" data-testid="attach-file" title="添加文件（插入路径）" onClick={() => void attach("file")} disabled={running}>
                <Icon name="file" size={17} />
              </button>
              <button type="button" className="icon-btn" data-testid="attach-folder" title="添加文件夹（插入路径）" onClick={() => void attach("folder")} disabled={running}>
                <Icon name="folder" size={17} />
              </button>
              {running ? (
                <button className="send stop" data-testid="stop" onClick={() => active && store.abort(active.id)} title="停止">
                  <Icon name="stop" size={16} />
                </button>
              ) : (
                <button className="send" data-testid="send" onClick={() => send()} disabled={!input.trim() || !!info?.problem} title="发送">
                  <Icon name="send" size={17} strokeWidth={2.2} />
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export function UserMsg({ text }: { text: string }) {
  return (
    <div className="msg-u">
      <div className="msg-u-card">{text}</div>
    </div>
  );
}

/** 助手消息：工具调用像 Cursor 一样内联在回复里，完整步骤按需展开 */
export function AssistantMsg({ t }: { t: Turn }) {
  const [detail, setDetail] = useState(false);
  const view = useMemo(() => buildRunView(t.events), [t.events]);
  const running = t.status === "running";
  const failed = t.status === "error" || t.status === "aborted";

  return (
    <div className="msg-a" data-testid="msg-assistant" data-status={t.status}>
      <div className="msg-a-head">
        <span className="msg-a-name">{t.provider}</span>
        {running && (
          <span className="chip run">
            <span className="spinner" />
            运行中
          </span>
        )}
        {t.status === "aborted" && <span className="chip bad">已中断</span>}
        {t.status === "error" && <span className="chip bad">失败</span>}
      </div>

      {view.steps.map(s =>
        s.tools.length ? (
          <div key={s.n} className="inline-steps">
            {s.text && <div className="inline-think">{s.text}</div>}
            {s.tools.map((tool, i) => (
              <ToolCard key={i} t={tool} />
            ))}
          </div>
        ) : null,
      )}

      {running && !t.text && (
        <div className="activity">
          <span className="typing">
            <i />
            <i />
            <i />
          </span>
          {view.activity ?? "准备中…"}
        </div>
      )}
      {t.text && (failed ? <div className="errtext">{t.text}</div> : <Markdown text={t.text} />)}

      {t.events.length > 0 && (
        <div className="msg-a-foot">
          <button className={`process-chip ${detail ? "on" : ""}`} data-testid="open-process" onClick={() => setDetail(!detail)}>
            <Icon name={detail ? "down" : "right"} size={13} />
            <span>
              {view.steps.length} 步
              {view.toolCount > 0 && ` · ${view.toolCount} 次工具调用`}
              {view.tokens > 0 && ` · ${view.tokens} token`}
              {view.totalMs ? ` · ${fmtMs(view.totalMs)}` : ""}
            </span>
          </button>
          {t.traceFile && (
            <a className="link" onClick={() => void api.openPath(t.traceFile!)}>
              trace
            </a>
          )}
        </div>
      )}
      {detail && (
        <div className="detail-box">
          <RunSteps view={view} events={t.events} running={running} />
        </div>
      )}
    </div>
  );
}

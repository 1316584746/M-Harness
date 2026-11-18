import { useEffect, useRef, useState } from "react";
import type { AppState } from "../../../shared/api";
import { Icon } from "../components/Icon";
import { ModelPicker } from "../components/ModelPicker";
import { ProviderPicker } from "../components/ProviderPicker";
import type { Connection } from "../../../shared/connections";
import type { DbFocus } from "../../../shared/db";
import { api } from "../api";
import { isRunning, type ChatStore } from "../lib/chatStore";
import { buildDbPreamble, type DbScope } from "../lib/dbAiContext";
import { AiContextBar } from "./db/AiContextBar";
import { AssistantMsg, UserMsg } from "./Chat";

const QUICK = "查看数据目录下 .traces 里最近几次失败或被中断的运行，分析失败原因并给出建议";

/** 右侧 AI 助手面板：随时唤起的轻量对话（独立于主对话列表），默认可读取数据目录，方便排查配置和运行记录 */
export function Assistant({ state, store, wide, onToggleWide, onClose, db }: { state: AppState; store: ChatStore; wide: boolean; onToggleWide: () => void; onClose: () => void; db?: { focus: DbFocus | null } }) {
  const { active, provider } = store;
  const [input, setInput] = useState("");
  // 在「数据库」页时，输入框上方多一排库选择；提问时把选中的库和表结构一并交给 AI
  const [dbConns, setDbConns] = useState<Connection[]>([]);
  const [dbScope, setDbScope] = useState<DbScope | null>(null);
  const inDb = !!db;
  useEffect(() => {
    if (!inDb) return;
    const load = () => void api.connectionList().then(l => setDbConns(l.filter(c => c.kind === "database" && c.enabled)));
    load();
    return api.onConnectionsChanged(load);
  }, [inDb]);
  const [history, setHistory] = useState(false);
  const bottom = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const histBox = useRef<HTMLDivElement>(null);

  const turns = active?.turns ?? [];
  const running = isRunning(active);
  const info = state.providers.find(p => p.name === provider);
  const last = turns.at(-1);
  const sessions = [...store.sessions].sort((a, b) => b.updated - a.updated);

  // 助手默认的工作区是数据目录：能看到 harness.config.json 和 .traces
  useEffect(() => {
    if (!store.workspace) store.setWorkspace(state.home);
  }, [store, state.home]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [active?.id, turns.length, last?.text, last?.events.length]);

  useEffect(() => {
    area.current?.focus();
  }, [active?.id]);

  useEffect(() => {
    if (!history) return;
    const close = (e: MouseEvent) => !histBox.current?.contains(e.target as Node) && setHistory(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [history]);

  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || running || info?.problem) return;
    setInput("");
    const conn = inDb && dbScope ? dbConns.find(c => c.id === dbScope.connId) : undefined;
    if (!conn || !dbScope || override) return void store.send(text);
    // 界面上还是显示用户打的这句话，发给 AI 的前面多一段库的上下文
    const table = db?.focus && db.focus.connId === dbScope.connId && (db.focus.database ?? conn.fields.database ?? "") === dbScope.database && (conn.fields.dbType !== "postgresql" || (db.focus.schema ?? "") === dbScope.schema) ? db.focus.table : undefined;
    const pre = await buildDbPreamble(conn, dbScope, table);
    void store.send(text, undefined, `${pre}\n${text}`);
  };

  return (
    <aside className={`assistant ${wide ? "wide" : ""}`} data-testid="assistant-panel">
      <header className="assistant-head">
        <div className="assistant-title" title={active?.title}>
          {active?.title ?? "新对话"}
        </div>
        <span className="spacer" />
        <button className="icon-btn sm" data-testid="assistant-new" title="新对话" onClick={() => store.setActiveId(null)}>
          <Icon name="plus" size={16} />
        </button>
        <div className="picker" ref={histBox}>
          <button className={`icon-btn sm ${history ? "on" : ""}`} data-testid="assistant-history" title="历史对话" onClick={() => setHistory(!history)}>
            <Icon name="history" size={16} />
          </button>
          {history && (
            <div className="menu assistant-history" style={{ left: "auto", right: 0, bottom: "auto", top: "calc(100% + 6px)" }} data-testid="assistant-history-menu">
              <div className="menu-title">历史对话</div>
              {!sessions.length && <div className="menu-empty">暂无</div>}
              {sessions.map(s => (
                <button
                  key={s.id}
                  type="button"
                  className={`menu-item ${s.id === store.activeId ? "sel" : ""}`}
                  data-testid="assistant-history-item"
                  onClick={() => {
                    store.setActiveId(s.id);
                    setHistory(false);
                  }}
                >
                  <span className="menu-main">
                    <span className="menu-name">{s.title}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="icon-btn sm" data-testid="assistant-delete" title="删除当前对话" disabled={!active} onClick={() => active && store.remove(active.id)}>
          <Icon name="trash" size={16} />
        </button>
        <button className="icon-btn sm" data-testid="assistant-wide" title={wide ? "收窄" : "展开"} onClick={onToggleWide}>
          <Icon name={wide ? "collapse" : "expand"} size={16} />
        </button>
        <button className="icon-btn sm" data-testid="assistant-close" title="关闭" onClick={onClose}>
          <Icon name="x" size={16} />
        </button>
      </header>

      <div className="assistant-thread">
        {!turns.length ? (
          <div className="assistant-empty" data-testid="assistant-empty">
            <Icon name="bot" size={34} />
            <p>告诉我你想了解什么，我来帮你分析</p>
            <button className="suggest-chip" data-testid="assistant-quick" disabled={!!info?.problem} onClick={() => send(QUICK)}>
              检查近期失败任务
            </button>
          </div>
        ) : (
          turns.map(t => (t.role === "user" ? <UserMsg key={t.id} text={t.text} /> : <AssistantMsg key={t.id} t={t} />))
        )}
        <div ref={bottom} />
      </div>

      <div className="assistant-composer">
        {info?.problem && <div className="inline-warn">{info.problem}</div>}
        <div className="composer assistant-box">
          {inDb && <AiContextBar focus={db!.focus} conns={dbConns} onChange={setDbScope} />}
          <textarea
            ref={area}
            rows={3}
            data-testid="assistant-input"
            value={input}
            placeholder={running ? "运行中…可点右下角停止" : "输入你的问题，我来帮你分析…（Enter 发送，Shift+Enter 换行）"}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                send();
              }
            }}
          />
          <div className="composer-row">
            <ProviderPicker providers={state.providers} value={provider} onChange={store.setProvider} disabled={running} />
            <ModelPicker provider={provider} info={info} value={store.model} onChange={store.setModel} disabled={running} />
            <span className="spacer" />
            {running ? (
              <button className="send stop" data-testid="assistant-stop" title="停止" onClick={() => active && store.abort(active.id)}>
                <Icon name="stop" size={16} />
              </button>
            ) : (
              <button className="send" data-testid="assistant-send" title="发送" disabled={!input.trim() || !!info?.problem} onClick={() => send()}>
                <Icon name="send" size={17} strokeWidth={2.2} />
              </button>
            )}
          </div>
        </div>
      </div>
    </aside>
  );
}

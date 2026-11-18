import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppState, McpServerDTO, RepoInfo, RepoSyncDTO } from "../../../shared/api";
import { md, startOfDay } from "../../../shared/schedule";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { ModelPicker } from "../components/ModelPicker";
import { ProviderPicker } from "../components/ProviderPicker";
import { RunSteps } from "../components/Steps";
import { isRunning, type ChatStore, type Turn } from "../lib/chatStore";
import { buildRunView, fmtMs } from "../lib/steps";
import { PHASE_TEXT, taskPhase, type Task, type TaskPhase, type TaskStore } from "../lib/taskStore";

export const SOURCE_TEXT: Record<Task["source"], string> = { feishu: "飞书项目", dingtalk: "钉钉待办" };

/** 第一次打开任务时放进输入框的提示词（用户确认后再发送） */
export const taskPrompt = (t: Pick<Task, "source" | "itemId" | "title">) =>
  t.source === "feishu"
    ? `我在飞书项目里有一个需求「${t.title}」（工作项 ID：${t.itemId}）。请先用 feishu_project_read 查看它的详情，再告诉我现在该怎么推进，需要我做什么。`
    : `我在钉钉里有一个待办「${t.title}」（任务 ID：${t.itemId}）。请先用 dingtalk_project_read 查看它的详情，再告诉我现在该怎么推进，需要我做什么。`;

const PHASE_CLASS: Record<TaskPhase, string> = { todo: "warn", running: "run", waiting: "", broken: "bad", done: "ok" };

const short = (s: string, n: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n) + "…" : t;
};

function when(ms: number): string {
  const d = new Date(ms);
  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
  return hasTime ? `${md(ms)} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}` : md(ms);
}
function range(t: Task): string {
  const a = t.start ?? t.end;
  const b = t.end ?? t.start;
  if (a === undefined || b === undefined) return "未排期";
  return startOfDay(a) === startOfDay(b) ? when(b) : `${when(a)} ~ ${when(b)}`;
}

/** 发给 AI 的任务说明：需求、关联仓库、任务上下文 */
function preamble(t: Task, repos: RepoInfo[]): string {
  const rs = t.repos.map(n => repos.find(r => r.name === n)).filter((r): r is RepoInfo => !!r);
  const lines = [`【任务】${t.title}`, `来源：${SOURCE_TEXT[t.source]}，工作项 ID ${t.itemId}${t.node ? `，当前节点 ${t.node}` : ""}`];
  if (rs.length) lines.push(`关联仓库（需要看代码 / 改代码时就用这些）：\n${rs.map(r => `- ${r.name}：${r.path}${r.status.branch ? `（当前分支 ${r.status.branch}）` : ""}`).join("\n")}`);
  if (t.context.trim()) lines.push(`任务上下文：\n${t.context.trim()}`);
  return lines.join("\n");
}
const sigOf = (t: Task) => JSON.stringify([t.repos, t.context.trim()]);

type Pop = "info" | "ctx" | "mcp" | "repo" | null;

export function TaskPage({
  state,
  task,
  chat,
  tasks,
  onBack,
  onChanged,
  onRemove,
}: {
  state: AppState;
  task: Task;
  /** 任务专用的对话存档（和普通对话分开） */
  chat: ChatStore;
  tasks: TaskStore;
  onBack: () => void;
  onChanged: () => void;
  onRemove: (id: string) => void;
}) {
  const session = chat.sessions.find(s => s.id === task.sessionId) ?? null;
  const turns = session?.turns ?? [];
  const running = isRunning(session);
  const phase = taskPhase(task, session);
  const { provider } = chat;
  const info = state.providers.find(p => p.name === provider);

  // 确保对话区用的是这个任务的会话
  useEffect(() => {
    if (chat.activeId !== task.sessionId) chat.setActiveId(task.sessionId);
  }, [chat, task.sessionId]);

  const rounds = useMemo(() => {
    const out: Array<{ n: number; user: Turn; ai?: Turn }> = [];
    for (let i = 0; i < turns.length; i++) {
      if (turns[i].role === "user") out.push({ n: out.length + 1, user: turns[i], ai: turns[i + 1]?.role === "assistant" ? turns[i + 1] : undefined });
    }
    return out;
  }, [turns]);
  const [sel, setSel] = useState<number | null>(null);
  const cur = rounds.find(r => r.n === sel) ?? rounds.at(-1);
  // 发起新一轮时自动切到最新一轮
  const nRounds = rounds.length;
  useEffect(() => setSel(null), [nRounds, task.id]);
  const [sub, setSub] = useState<"out" | "proc">("out");

  // ───── 仓库 / 改动 / MCP ─────
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [diff, setDiff] = useState<{ added: number; deleted: number; files: number } | null>(null);
  const [mcp, setMcp] = useState<McpServerDTO[] | null>(null);
  const reposKey = task.repos.join("|");
  const loadRepos = useCallback(() => {
    void api.listRepos().then(setRepos).catch(() => setRepos([]));
    void api.repoDiffStat(task.repos).then(setDiff).catch(() => setDiff(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reposKey]);
  useEffect(loadRepos, [loadRepos, phase]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let n = 0;
    const tick = async () => {
      const s = await api.mcpStatus().catch(() => null);
      if (!alive) return;
      setMcp(s);
      if (s?.some(x => x.state === "connecting") && ++n < 10) timer = setTimeout(tick, 2500);
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, []);
  const mcpOn = (mcp ?? []).filter(s => s.state !== "disabled");
  const mcpReady = mcpOn.filter(s => s.state === "ready").length;

  const [pop, setPop] = useState<Pop>(null);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!pop) return;
    const close = (e: MouseEvent) => !bar.current?.contains(e.target as Node) && setPop(null);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setPop(null);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [pop]);

  /** 刚关联的仓库：自动切到基线分支并拉最新代码；这里记着进度和结果 */
  const [syncing, setSyncing] = useState<Set<string>>(new Set());
  const [syncRes, setSyncRes] = useState<Record<string, RepoSyncDTO>>({});
  const loadRef = useRef(loadRepos);
  loadRef.current = loadRepos; // 同步结束时用最新的（带着新关联的仓库），别用发起时的旧闭包
  const syncRepo = async (name: string) => {
    setSyncing(s => new Set([...s, name]));
    const r = await api.repoSync(name).catch((e): RepoSyncDTO => ({ ok: false, switched: false, pulled: false, error: e instanceof Error ? e.message : String(e) }));
    setSyncing(s => new Set([...s].filter(n => n !== name)));
    setSyncRes(m => ({ ...m, [name]: r }));
    loadRef.current();
  };
  const setTaskRepos = (names: string[]) => {
    const added = names.filter(n => !task.repos.includes(n));
    tasks.update(task.id, { repos: names });
    const first = repos.find(r => r.name === names[0]);
    // 对话的工作区跟着第一个关联仓库走
    if (first && chat.activeId === task.sessionId) chat.setWorkspace(first.path);
    for (const n of added) void syncRepo(n);
  };

  // ───── 输入 ─────
  const [input, setInput] = useState(() => (turns.length === 0 ? taskPrompt(task) : ""));
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(Math.max(el.scrollHeight, 64), 220) + "px";
  }, [input]);
  const send = () => {
    const text = input.trim();
    if (!text || running) return;
    setInput("");
    const need = turns.length === 0 || task.ctxSent !== sigOf(task);
    void chat.send(text, onChanged, need ? `${preamble(task, repos)}\n\n${text}` : undefined);
    tasks.update(task.id, { ctxSent: sigOf(task) });
  };
  const attach = async (kind: "file" | "folder") => {
    const p = kind === "file" ? await api.pickFile("选择要引用的文件") : await api.pickFolder("选择要引用的文件夹");
    if (p) setInput(v => (v && !/\s$/.test(v) ? v + " " : v) + (/\s/.test(p) ? `"${p}"` : p) + " ");
    area.current?.focus();
  };

  const flow = useRef<HTMLDivElement>(null);
  const last = turns.at(-1);
  useEffect(() => {
    flow.current?.scrollTo({ top: flow.current.scrollHeight });
  }, [turns.length, last?.events.length, last?.status]);

  const [confirmDrop, setConfirmDrop] = useState(false);
  useEffect(() => setConfirmDrop(false), [task.id]);

  const view = useMemo(() => (cur?.ai ? buildRunView(cur.ai.events) : null), [cur?.ai?.events]);
  const picked = task.repos.map(n => repos.find(r => r.name === n) ?? ({ name: n, path: "", status: { exists: false, changed: 0, ahead: 0, behind: 0 } } as RepoInfo));
  const free = repos.filter(r => !task.repos.includes(r.name));

  return (
    <section className="task" data-testid="task-page" data-phase={phase}>
      <header className="task-head">
        <button className="btn sm ghost" data-testid="task-back" onClick={onBack}>
          <Icon name="back" size={14} /> 返回
        </button>
        <span className="task-sep">/</span>
        <h1 className="task-title" data-testid="task-title" title={task.title}>
          {task.title}
        </h1>
        <span className={`chip ${PHASE_CLASS[phase]}`} data-testid="task-phase">
          {phase === "running" && <span className="spinner" />}
          {PHASE_TEXT[phase]}
        </span>
        <span className="chip">{SOURCE_TEXT[task.source]}</span>
        <span className="spacer" />
        <button className="btn sm primary" data-testid="task-done" onClick={() => tasks.update(task.id, { done: !task.done })}>
          <Icon name="check" size={14} /> {task.done ? "重新打开" : "完成"}
        </button>
        {confirmDrop ? (
          <button className="btn sm danger" data-testid="task-drop-confirm" onClick={() => onRemove(task.id)} onBlur={() => setConfirmDrop(false)} autoFocus>
            确认放弃
          </button>
        ) : (
          <button className="btn sm" data-testid="task-drop" onClick={() => setConfirmDrop(true)}>
            <Icon name="trash" size={14} /> 放弃
          </button>
        )}
      </header>

      <div className="task-bar" ref={bar}>
        <div className="task-repos" data-testid="task-repos">
          {picked.map(r => (
            <span key={r.name} className={`repo-chip${r.status.exists ? "" : " gone"}`} data-testid="task-repo" title={r.path}>
              <Icon name="repo" size={13} />
              <b>{r.name}</b>
              {syncing.has(r.name) ? (
                <em className="syncing" data-testid="task-repo-syncing">
                  <span className="spinner" /> 同步基线分支…
                </em>
              ) : (
                r.status.branch && (
                  <em data-testid="task-repo-branch" title={r.status.branch}>
                    {r.status.branch}
                  </em>
                )
              )}
              {r.status.changed > 0 && <i className="dirty" title={`${r.status.changed} 个文件有改动`} />}
              <button aria-label="取消关联" onClick={() => setTaskRepos(task.repos.filter(n => n !== r.name))}>
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
          <div className="pop-wrap">
            <button className={`repo-add ${pop === "repo" ? "on" : ""}`} data-testid="task-repo-add" onClick={() => setPop(pop === "repo" ? null : "repo")}>
              <Icon name="plus" size={12} /> 关联仓库
            </button>
            {pop === "repo" && (
              <div className="pop" data-testid="pop-repo">
                {free.length === 0 && <div className="pop-empty">{repos.length ? "已全部关联" : "设置里还没有登记代码仓库"}</div>}
                {free.map(r => (
                  <button key={r.name} className="pop-item" data-testid="pop-repo-item" onClick={() => (setTaskRepos([...task.repos, r.name]), setPop(null))}>
                    <b>{r.name}</b>
                    <em data-testid="pop-repo-base" title={r.status.branch && r.base && r.status.branch !== r.base ? `当前在 ${r.status.branch}，关联后会切到基线分支 ${r.base}` : undefined}>
                      {r.status.exists ? (r.base ? `基线 ${r.base}` : r.status.branch ?? "") : "目录不存在"}
                    </em>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {picked.some(r => syncRes[r.name] && (syncRes[r.name].error || syncRes[r.name].skipped || syncRes[r.name].switched || syncRes[r.name].pulled)) && (
          <div className="repo-notes" data-testid="task-repo-notes">
            {picked.map(r => {
              const s = syncRes[r.name];
              if (!s) return null;
              const ok = s.ok && !s.error;
              const text = s.error
                ? `${r.name}：${s.error}`
                : [s.switched ? `已切换到基线分支 ${s.base}` : s.base && s.branch === s.base ? `在基线分支 ${s.base}` : "", s.pulled ? "已拉取最新代码" : "", s.skipped ?? ""].filter(Boolean).join("，");
              return text ? (
                <span key={r.name} className={`repo-note ${ok ? (s.skipped ? "warn" : "ok") : "bad"}`} title={text}>
                  {s.error ? r.name + "：" + s.error : r.name + "：" + text}
                </span>
              ) : null;
            })}
          </div>
        )}

        <div className="task-acts">
          <div className="pop-wrap">
            <button className={`act-chip ${pop === "info" ? "on" : ""}`} data-testid="task-info-btn" onClick={() => setPop(pop === "info" ? null : "info")}>
              <Icon name="info" size={13} /> 基本信息
            </button>
            {pop === "info" && (
              <div className="pop wide" data-testid="pop-info">
                <dl className="task-kv">
                  <dt>需求</dt>
                  <dd>{task.title}</dd>
                  <dt>来源</dt>
                  <dd>{SOURCE_TEXT[task.source]}</dd>
                  <dt>工作项 ID</dt>
                  <dd className="mono">{task.itemId}</dd>
                  {task.node && (
                    <>
                      <dt>节点</dt>
                      <dd>{task.node}</dd>
                    </>
                  )}
                  <dt>排期</dt>
                  <dd>{range(task)}</dd>
                  {task.sub && (
                    <>
                      <dt>备注</dt>
                      <dd>{task.sub}</dd>
                    </>
                  )}
                  {task.url && (
                    <>
                      <dt>链接</dt>
                      <dd>
                        <a className="link" href={task.url} target="_blank" rel="noreferrer">
                          在浏览器中打开
                        </a>
                      </dd>
                    </>
                  )}
                  <dt>创建于</dt>
                  <dd>{new Date(task.created).toLocaleString("zh-CN")}</dd>
                </dl>
              </div>
            )}
          </div>
          <div className="pop-wrap">
            <button className={`act-chip ${pop === "ctx" ? "on" : ""}`} data-testid="task-ctx-btn" onClick={() => setPop(pop === "ctx" ? null : "ctx")}>
              <Icon name="file" size={13} /> 任务上下文 <span className="num">{task.context.trim() ? 1 : 0}</span>
            </button>
            {pop === "ctx" && (
              <div className="pop wide" data-testid="pop-ctx">
                <div className="pop-title">任务上下文</div>
                <textarea
                  data-testid="task-ctx-input"
                  className="ctx-input"
                  autoFocus
                  value={task.context}
                  placeholder="补充这个任务的背景、约束、接口文档链接……发给 AI 时会一起带上"
                  onChange={e => tasks.quiet(task.id, { context: e.target.value })}
                />
              </div>
            )}
          </div>
          <div className="pop-wrap">
            <button className={`act-chip ${pop === "mcp" ? "on" : ""}`} data-testid="task-mcp-btn" onClick={() => setPop(pop === "mcp" ? null : "mcp")}>
              <Icon name="plug" size={13} /> MCP{" "}
              <span className="num" data-testid="task-mcp-num">
                {mcp ? `${mcpReady}/${mcpOn.length}` : "–"}
              </span>
            </button>
            {pop === "mcp" && (
              <div className="pop wide" data-testid="pop-mcp">
                <div className="pop-title">MCP 服务</div>
                {!mcpOn.length && <div className="pop-empty">没有启用的 MCP 服务，可以在 设置 → MCP 里添加</div>}
                {mcpOn.map(s => (
                  <div key={s.name} className="pop-row">
                    <span className={`dot ${s.state}`} />
                    <b>{s.name}</b>
                    <em>{s.state === "ready" ? `${s.tools.filter(t => t.enabled).length} 个工具` : s.state === "error" ? s.error ?? "连接失败" : "连接中…"}</em>
                  </div>
                ))}
              </div>
            )}
          </div>
          <span className="act-chip static" data-testid="task-diff" title={diff ? `${diff.files} 个文件有改动（相对 HEAD）` : "关联仓库后统计改动"}>
            <Icon name="edit" size={13} /> 改动
            {diff && diff.files > 0 ? (
              <>
                <b className="add">+{diff.added}</b>
                <b className="del">−{diff.deleted}</b>
              </>
            ) : (
              <span className="num">0</span>
            )}
          </span>
          <button className="act-chip" data-testid="task-folder" onClick={() => void api.taskFolder(task.id, true)}>
            <Icon name="folder" size={13} /> 任务文件夹
          </button>
        </div>
      </div>

      <div className="task-body">
        <div className="task-main">
          {rounds.length > 0 && (
            <div className="round-tabs" data-testid="round-tabs">
              {rounds.map(r => (
                <button key={r.n} className={`round-tab${cur?.n === r.n ? " on" : ""}`} data-testid="round-tab" title={r.user.text} onClick={() => setSel(r.n)}>
                  <i>#{r.n}</i>
                  {short(r.user.text, 10)}
                  {r.ai?.status === "running" && <span className="spinner" />}
                </button>
              ))}
            </div>
          )}

          {cur ? (
            <>
              <div className="out-tabs">
                <button className={`out-tab${sub === "out" ? " on" : ""}`} data-testid="out-tab" onClick={() => setSub("out")}>
                  <Icon name="file" size={13} /> 产物
                </button>
                <button className={`out-tab${sub === "proc" ? " on" : ""}`} data-testid="proc-tab" onClick={() => setSub("proc")}>
                  <Icon name="list" size={13} /> 过程
                </button>
                <span className="spacer" />
                {cur.ai?.text && cur.ai.status === "done" && (
                  <button className="btn sm ghost" onClick={() => void navigator.clipboard.writeText(cur.ai!.text)}>
                    <Icon name="copy" size={13} /> 复制
                  </button>
                )}
                {cur.ai?.traceFile && (
                  <button className="btn sm ghost" onClick={() => void api.openPath(cur.ai!.traceFile!)}>
                    trace
                  </button>
                )}
              </div>
              <div className="out-body" data-testid="out-body">
                {sub === "out" ? (
                  cur.ai?.status === "running" && !cur.ai.text ? (
                    <div className="activity">
                      <span className="typing">
                        <i />
                        <i />
                        <i />
                      </span>
                      {view?.activity ?? "准备中…"}
                    </div>
                  ) : cur.ai?.text ? (
                    cur.ai.status === "error" || cur.ai.status === "aborted" ? (
                      <div className="errtext">{cur.ai.text}</div>
                    ) : (
                      <Markdown text={cur.ai.text} />
                    )
                  ) : (
                    <div className="out-empty">这一轮还没有产出</div>
                  )
                ) : view && cur.ai ? (
                  <RunSteps view={view} events={cur.ai.events} running={cur.ai.status === "running"} />
                ) : (
                  <div className="out-empty">还没有过程记录</div>
                )}
              </div>
            </>
          ) : (
            <div className="task-empty" data-testid="task-empty">
              <div className="hero-mark">
                <Icon name="spark" size={22} />
              </div>
              <h2>{short(task.title, 40)}</h2>
              <p className="muted">
                {task.repos.length ? "" : "先在上方关联这个需求要改的代码仓库，"}
                在右侧告诉 AI 要做什么，每发一条指令就是一轮，产出会按 #1、#2… 排在这里。
              </p>
            </div>
          )}
        </div>

        <aside className="task-flow">
          <div className="flow-head">
            <b>事件流</b>
            <span className="muted">{rounds.length} 轮</span>
          </div>
          <div className="flow-list" ref={flow} data-testid="task-flow">
            {!rounds.length && <div className="flow-empty">还没有事件，发出第一条指令后会记录在这里</div>}
            {rounds.map(r => {
              const v = r.ai ? buildRunView(r.ai.events) : null;
              const st = r.ai?.status;
              return (
                <div key={r.n} className="flow-round" data-testid="flow-round">
                  <div className="flow-user" onClick={() => setSel(r.n)}>
                    <span className="flow-who">我</span>
                    {short(r.user.text, 160)}
                  </div>
                  {r.ai && (
                    <button className={`flow-ai ${st}`} onClick={() => (setSel(r.n), setSub("out"))}>
                      {st === "running" ? <span className="spinner" /> : <span className={`dot ${st === "done" ? "ready" : "error"}`} />}
                      <span className="flow-ai-main">
                        <b>
                          #{r.n} {st === "running" ? v?.activity ?? "准备中…" : st === "done" ? "已完成，产出已更新" : st === "aborted" ? "已中断" : "失败"}
                        </b>
                        {v && v.steps.length > 0 && (
                          <em>
                            {v.steps.length} 步{v.toolCount > 0 && ` · ${v.toolCount} 次工具调用`}
                            {v.totalMs ? ` · ${fmtMs(v.totalMs)}` : ""}
                          </em>
                        )}
                      </span>
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flow-composer">
            {info?.problem && <div className="inline-warn">{info.problem}</div>}
            <div className="composer" data-testid="task-composer">
              <textarea
                ref={area}
                data-testid="task-input"
                rows={2}
                value={input}
                placeholder={running ? "运行中…可点右下角停止" : "想改、想问、拖入文件引用路径（Enter 发送，Shift+Enter 换行）"}
                onChange={e => setInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <div className="composer-row">
                <ProviderPicker providers={state.providers} value={provider} onChange={chat.setProvider} disabled={running} />
                <ModelPicker provider={provider} info={info} value={chat.model} onChange={chat.setModel} disabled={running} />
                <span className="spacer" />
                <button type="button" className="icon-btn" title="添加文件（插入路径）" onClick={() => void attach("file")} disabled={running}>
                  <Icon name="file" size={16} />
                </button>
                <button type="button" className="icon-btn" title="添加文件夹（插入路径）" onClick={() => void attach("folder")} disabled={running}>
                  <Icon name="folder" size={16} />
                </button>
                {running ? (
                  <button className="send stop" data-testid="task-stop" title="停止" onClick={() => session && chat.abort(session.id)}>
                    <Icon name="stop" size={16} />
                  </button>
                ) : (
                  <button className="send" data-testid="task-send" title="发送" onClick={send} disabled={!input.trim() || !!info?.problem}>
                    <Icon name="send" size={17} strokeWidth={2.2} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

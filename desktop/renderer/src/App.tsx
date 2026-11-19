import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { AppState, ApprovalRequest, TodoItemDTO } from "../../shared/api";
import { api } from "./api";
import { ApprovalModal } from "./components/ApprovalModal";
import { Icon, type IconName } from "./components/Icon";
import { Logo } from "./components/Logo";
import { PluginRail } from "./components/PluginRail";
import { PluginView } from "./components/PluginView";
import type { UiPlugin } from "../../shared/pluginhost";
import { UpdateDialog } from "./components/UpdateDialog";
import { isRunning, useChatStore } from "./lib/chatStore";
import { PHASE_TEXT, TIME_GROUPS, taskPhase, timeGroup, useTaskStore, type Task } from "./lib/taskStore";
import { Automations } from "./pages/Automations";
import { Defects } from "./pages/Defects";
import { useDefects } from "./lib/defects";
import { ENTRY_NAME } from "../../shared/defects";
import type { DbFocus, DbRunReq } from "../../shared/db";
import { SOURCE_TEXT, TaskPage } from "./pages/Task";
import { updateSkip, useUpdate } from "./lib/update";
import { Assistant } from "./pages/Assistant";
import { Chat } from "./pages/Chat";
import { Home } from "./pages/Home";
import { Workbench } from "./pages/Workbench";
import { Database } from "./pages/Database";
import { Plugins } from "./pages/Plugins";
import { Replay } from "./pages/Replay";
import { Settings } from "./pages/Settings";

/** 右上角工具按钮（再点一次回到对话） */
const TOOLS: Array<{ id: string; label: string; icon: IconName }> = [
  { id: "automation", label: "自动化任务", icon: "timer" },
  { id: "replay", label: "回放", icon: "history" },
];

export type Theme = "light" | "dark";

const NAV_W_KEY = "harness.nav.w";
const NAV_DEFAULT = 260;
const NAV_MIN = 180;
const NAV_MAX = 480;
const NAV_COLLAPSED_KEY = "harness.nav.collapsed";
/** 折叠后只剩图标的宽度 */
const NAV_ICON_W = 56;

function initialTheme(): Theme {
  return localStorage.getItem("theme") === "light" ? "light" : "dark";
}

function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "刚刚";
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`;
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`;
  return `${Math.floor(s / 86400)} 天前`;
}

const baseName = (p: string) => p.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || p;
const GROUPS_KEY = "harness.nav.groups.collapsed";

export function App() {
  const [state, setState] = useState<AppState | null>(null);
  const refresh = useCallback(() => void api.getState().then(setState), []);
  useEffect(refresh, [refresh]);

  if (!state) return <div className="boot">加载中…</div>;
  return <Shell state={state} refresh={refresh} />;
}

function Shell({ state, refresh }: { state: AppState; refresh: () => void }) {
  const store = useChatStore(state);
  const assistant = useChatStore(state, "harness.assistant.v1");
  /** 任务的对话单独存档，不和普通对话列表混在一起 */
  const taskChat = useChatStore(state, "harness.tasks.chat.v1");
  const tasks = useTaskStore();
  const [activeTask, setActiveTask] = useState<string | null>(null);
  /** 刚创建 / 刚点到的任务：侧边栏里高亮闪一下 */
  const [flash, setFlash] = useState<{ id: string; n: number } | null>(null);
  useEffect(() => {
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 2200);
    return () => clearTimeout(t);
  }, [flash]);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantWide, setAssistantWide] = useState(false);
  const [dbFocus, setDbFocus] = useState<DbFocus | null>(null);
  const [dbRun, setDbRun] = useState<DbRunReq | null>(null);
  const [navW, setNavW] = useState(() => {
    const v = Number(localStorage.getItem(NAV_W_KEY));
    return Number.isFinite(v) && v >= NAV_MIN && v <= NAV_MAX ? v : NAV_DEFAULT;
  });
  const [navDrag, setNavDrag] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem(GROUPS_KEY) ?? "[]");
    } catch {
      return [];
    }
  });
  const toggleGroup = (k: string) =>
    setCollapsedGroups(g => {
      const next = g.includes(k) ? g.filter(x => x !== k) : [...g, k];
      localStorage.setItem(GROUPS_KEY, JSON.stringify(next));
      return next;
    });
  const [navCollapsed, setNavCollapsed] = useState(() => localStorage.getItem(NAV_COLLAPSED_KEY) === "1");
  const toggleNav = () =>
    setNavCollapsed(c => {
      localStorage.setItem(NAV_COLLAPSED_KEY, c ? "0" : "1");
      return !c;
    });
  /** 点左上角的图标 / 名字：回首页 */
  const onHomeClick = () => setTab("home");
  const [tab, setTab] = useState("home");
  const [dbMounted, setDbMounted] = useState(false);
  useEffect(() => {
    if (tab === "database") setDbMounted(true);
  }, [tab]);
  /** 打开设置时直接定位到哪一项（比如从工作台的「去设置里创建」进来） */
  const [settingsSec, setSettingsSec] = useState<string | undefined>();
  /** 设置 / 回放再点一次、或点「返回」时回到的主页面（首页或对话） */
  const mainTab = useRef("home");
  useEffect(() => {
    if (tab === "home" || tab === "chat" || tab === "workbench" || tab === "plugins" || tab === "database" || tab === "task") mainTab.current = tab;
  }, [tab]);
  const defects = useDefects();

  // 右侧插件栏：带界面的已装插件；点开过的界面保持挂载，切走再回来不丢状态
  const [uiPlugins, setUiPlugins] = useState<UiPlugin[]>([]);
  const [openedPlugins, setOpenedPlugins] = useState<string[]>([]);
  const [activePlugin, setActivePlugin] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .pluginUiList()
        .then(l => live && setUiPlugins(l))
        .catch(() => {});
    void load();
    window.addEventListener("harness:plugins-changed", load);
    return () => {
      live = false;
      window.removeEventListener("harness:plugins-changed", load);
    };
  }, []);
  useEffect(() => {
    const ids = new Set(uiPlugins.map(p => p.id));
    setOpenedPlugins(o => (o.every(id => ids.has(id)) ? o : o.filter(id => ids.has(id))));
    if (activePlugin && !ids.has(activePlugin)) {
      setActivePlugin(null);
      setTab(t => (t === "plugin" ? mainTab.current : t));
    }
  }, [uiPlugins, activePlugin]);
  const openPlugin = (id: string) => {
    if (tab === "plugin" && activePlugin === id) return setTab(mainTab.current);
    setOpenedPlugins(o => (o.includes(id) ? o : [...o, id]));
    setActivePlugin(id);
    setTab("plugin");
  };
  const defectCount = defects?.enabled ? defects.items.length : 0;
  const defectNew = defects?.enabled ? defects.items.filter(d => d.isNew).length : 0;
  // 点了「有新问题」的系统通知：直接打开列表
  useEffect(() => api.onDefectsOpen(() => setTab("defects")), []);
  // 从设置里回来：可能刚改了项目管理工具，重新拉一次
  const prevTab = useRef("home");
  useEffect(() => {
    if (prevTab.current === "settings" && tab !== "settings") void api.defectsRefresh();
    prevTab.current = tab;
  }, [tab]);
  const [approvals, setApprovals] = useState<ApprovalRequest[]>([]);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const update = useUpdate();
  const [updateOpen, setUpdateOpen] = useState(false);
  const hasUpdate = !!update && (update.state === "available" || update.state === "downloading" || update.state === "downloaded") && !(update.state === "available" && updateSkip.isSkipped(update.latest));

  // 发现新版本时自动提示一次（同一版本只弹一次；之后靠右上角的按钮）
  useEffect(() => {
    if (update?.state === "available" && update.latest && !updateSkip.isSkipped(update.latest) && !updateSkip.wasPrompted(update.latest)) {
      updateSkip.markPrompted(update.latest);
      setUpdateOpen(true);
    }
  }, [update?.state, update?.latest]);

  useEffect(() => api.onApproval(r => setApprovals(a => [...a, r])), []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("theme", theme);
    void api.setTheme(theme);
  }, [theme]);

  const sessions = [...store.sessions].sort((a, b) => b.updated - a.updated);
  const defaultWs = state.workspace;
  const groups = useMemo(() => {
    const m = new Map<string, typeof sessions>();
    for (const s of sessions) {
      const k = s.workspace ?? defaultWs;
      m.set(k, [...(m.get(k) ?? []), s]);
    }
    return [...m.entries()]
      .map(([ws, list]) => ({ ws, list, latest: Math.max(0, ...list.map(x => x.updated)) }))
      .sort((x, y) => y.latest - x.latest);
  }, [sessions, defaultWs]);
  const [prefill, setPrefill] = useState<{ text: string; n: number } | null>(null);
  const openChat = (opt?: { workspace?: string; prompt?: string }) => {
    store.newChat(opt?.workspace);
    if (opt?.prompt) setPrefill(p => ({ text: opt.prompt!, n: (p?.n ?? 0) + 1 }));
    setTab("chat");
  };
  const toggle = (id: string) => setTab(t => (t === id ? mainTab.current : id));
  const anyRunning = store.sessions.some(isRunning) || assistant.sessions.some(isRunning) || taskChat.sessions.some(isRunning);

  const openTask = (id: string, known?: Task) => {
    const t = known ?? tasks.tasks.find(x => x.id === id);
    if (!t) return;
    taskChat.setActiveId(t.sessionId);
    setActiveTask(id);
    setTab("task");
  };
  /** 点击需求：在左侧创建一个任务（同一个需求只建一次）；open=true 时直接打开 */
  const taskFromItem = (item: TodoItemDTO, open = false) => {
    let t = tasks.find(item.source, item.id);
    if (!t) {
      const sid = taskChat.newChat(undefined, { title: item.title });
      t = tasks.add(item, sid);
    } else {
      tasks.quiet(t.id, { title: item.title, node: item.node, sub: item.sub, url: item.url, projectKey: item.projectKey ?? t.projectKey, start: item.start, end: item.end, done: false });
    }
    setFlash({ id: t.id, n: Date.now() });
    if (open) openTask(t.id, t);
  };
  const removeTask = (id: string) => {
    const t = tasks.tasks.find(x => x.id === id);
    if (t) taskChat.remove(t.sessionId);
    tasks.remove(id);
    if (activeTask === id) {
      setActiveTask(null);
      setTab("workbench");
    }
  };
  const sessionOf = (t: Task) => taskChat.sessions.find(s => s.id === t.sessionId);
  const taskTime = (t: Task) => Math.max(t.updated, sessionOf(t)?.updated ?? 0);
  const openTasks = tasks.tasks.filter(t => !t.done);
  const doneTasks = tasks.tasks.filter(t => t.done);
  const taskedKeys = useMemo(() => new Set(tasks.tasks.map(t => t.source + t.itemId)), [tasks.tasks]);
  const [doneOpen, setDoneOpen] = useState(false);
  /** 侧边栏：对话页只放对话；工作台 / 任务页只在有任务时才出现，而且只放任务。两边互不混 */
  const onChat = tab === "chat";
  const showNav = onChat || ((tab === "workbench" || tab === "task") && tasks.tasks.length > 0);
  const curTask = tasks.tasks.find(t => t.id === activeTask) ?? null;
  const assistantRunning = assistant.sessions.some(isRunning);

  // Ctrl+Alt+I 唤起 / 收起 AI 助手
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.altKey && e.key.toLowerCase() === "i") {
        e.preventDefault();
        setAssistantOpen(o => !o);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand" data-testid="brand" title="首页" onClick={onHomeClick}>
          <Logo size={22} className="brand-logo" />
          M-Harness
          {anyRunning && <span className="spinner" style={{ color: "var(--run)", marginLeft: 8 }} />}
        </div>
        <div className="titlebar-nav">
          <button
            className="tn-btn"
            data-testid="new-chat"
            title="新建对话"
            onClick={() => {
              store.newChat();
              setTab("chat");
            }}
          >
            <Icon name="chat" size={15} />
            <span>新建对话</span>
          </button>
          <button className={`tn-btn ${tab === "workbench" ? "on" : ""}`} data-testid="nav-workbench" title="工作台" onClick={() => setTab("workbench")}>
            <Icon name="grid" size={15} />
            <span>工作台</span>
          </button>
          <button className={`tn-btn ${tab === "database" ? "on" : ""}`} data-testid="nav-database" title="数据库" onClick={() => setTab("database")}>
            <Icon name="database" size={15} />
            <span>数据库</span>
          </button>
          <button className={`tn-btn ${tab === "plugins" ? "on" : ""}`} data-testid="nav-plugins" title="插件中心" onClick={() => setTab("plugins")}>
            <Icon name="plug" size={15} />
            <span>插件中心</span>
          </button>
        </div>
        <span className="spacer" />
        <div className="titlebar-tools">
          {hasUpdate && (
            <button className="tb-btn update" data-testid="nav-update" title={`发现新版本 v${update!.latest}，点击查看`} onClick={() => setUpdateOpen(true)}>
              <Icon name="cloud" size={17} />
              <span className="tb-dot update" />
            </button>
          )}
          <button className={`tb-btn ${assistantOpen ? "on" : ""}`} data-testid="nav-assistant" title="AI 助手 (Ctrl + Alt + I)" onClick={() => setAssistantOpen(o => !o)}>
            <Icon name="bot" size={17} />
            {assistantRunning && !assistantOpen && <span className="tb-dot" />}
          </button>
          {defects?.enabled && (
            <button
              className={`tb-btn ${tab === "defects" ? "on" : ""}`}
              data-testid="nav-defects"
              title={defectCount > 0 ? `${ENTRY_NAME[defects.source ?? "feishu"]}：${defectCount} 个待处理${defectNew > 0 ? `（${defectNew} 个新的）` : ""}` : ENTRY_NAME[defects.source ?? "feishu"]}
              onClick={() => toggle("defects")}
            >
              <Icon name="bug" size={17} />
              {defectCount > 0 && (
                <span className={`tb-count ${defectNew > 0 ? "new" : ""}`} data-testid="defect-badge">
                  {defectCount > 99 ? "99+" : defectCount}
                </span>
              )}
            </button>
          )}
          {TOOLS.map(t => (
            <button
              key={t.id}
              data-testid={`nav-${t.id}`}
              className={`tb-btn ${tab === t.id ? "on" : ""}`}
              title={t.label}
              onClick={() => toggle(t.id)}
            >
              <Icon name={t.icon} size={17} />
            </button>
          ))}
          <button className="tb-btn" data-testid="theme-toggle" title={theme === "dark" ? "切换到浅色" : "切换到深色"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            <Icon name={theme === "dark" ? "moon" : "sun"} size={17} />
          </button>
          <button className={`tb-btn ${tab === "settings" ? "on" : ""}`} data-testid="nav-settings" title="设置" onClick={() => toggle("settings")}>
            <Icon name="settings" size={17} />
            {state.channel.running && <span className="tb-dot" />}
          </button>
        </div>
      </header>

      <div className="body-row">
      <div style={{ "--nav-w": `${navCollapsed ? NAV_ICON_W : navW}px` } as CSSProperties} className={`body ${assistantOpen ? "has-assistant" : ""} ${!showNav ? "no-nav" : ""} ${navDrag ? "dragging" : ""}`}>
        {showNav && (
          <nav className={`nav ${navCollapsed ? "collapsed" : ""}`} data-testid="nav">
            <button className="nav-fold" data-testid="nav-toggle" title={navCollapsed ? "展开侧边栏" : "折叠侧边栏"} onClick={toggleNav}>
              <Icon name="panel" size={15} />
            </button>
            <div className="session-list" data-testid="session-list">
              {!navCollapsed && !onChat && (openTasks.length > 0 || doneTasks.length > 0) && (
                <div className="task-nav" data-testid="task-nav">
                  <div className="task-nav-title">进行中的任务</div>
                  {!openTasks.length && <div className="session-empty">没有进行中的任务</div>}
                  {TIME_GROUPS.map(g => {
                    const list = openTasks.filter(t => timeGroup(taskTime(t)) === g).sort((a, b) => taskTime(b) - taskTime(a));
                    if (!list.length) return null;
                    return (
                      <div key={g} className="task-group">
                        <div className="task-group-name">{g}</div>
                        {list.map(t => {
                          const ph = taskPhase(t, sessionOf(t));
                          return (
                            <div
                              key={t.id}
                              data-testid="task-item"
                              data-phase={ph}
                              className={`session task-item ${tab === "task" && activeTask === t.id ? "active" : ""} ${flash?.id === t.id ? "flash" : ""}`}
                              title={t.title}
                              ref={el => {
                                if (flash?.id === t.id) el?.scrollIntoView({ block: "nearest" });
                              }}
                              onClick={() => openTask(t.id)}
                            >
                              {ph === "running" ? <span className="spinner session-ico" /> : <Icon name="list" size={14} />}
                              <span className="task-item-main">
                                <span className="session-title">{t.title}</span>
                                <span className="task-item-sub">
                                  {SOURCE_TEXT[t.source]}
                                  <em className={`ph ${ph}`}>{PHASE_TEXT[ph]}</em>
                                </span>
                              </span>
                              <button
                                className="session-del"
                                title="放弃任务"
                                onClick={e => {
                                  e.stopPropagation();
                                  removeTask(t.id);
                                }}
                              >
                                <Icon name="x" size={13} />
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                  {doneTasks.length > 0 && (
                    <div className="task-group">
                      <div className="task-group-name clickable" data-testid="task-done-head" onClick={() => setDoneOpen(o => !o)}>
                        <Icon name={doneOpen ? "down" : "right"} size={11} /> 已完成 · {doneTasks.length}
                      </div>
                      {doneOpen &&
                        doneTasks.map(t => (
                          <div key={t.id} data-testid="task-item" data-phase="done" className={`session task-item ${tab === "task" && activeTask === t.id ? "active" : ""}`} title={t.title} onClick={() => openTask(t.id)}>
                            <Icon name="check" size={14} />
                            <span className="task-item-main">
                              <span className="session-title">{t.title}</span>
                            </span>
                          </div>
                        ))}
                    </div>
                  )}
                </div>
              )}
              {onChat && !groups.length && <div className="session-empty">还没有对话</div>}
              {(onChat ? groups : []).map(g => {
                const open = !collapsedGroups.includes(g.ws);
                return (
                  <div key={g.ws} className="sess-group" data-testid="session-group">
                    <div className="sess-group-head" title={g.ws} data-testid="session-group-head" onClick={() => toggleGroup(g.ws)}>
                      <Icon name={open ? "down" : "right"} size={12} />
                      <span className="sess-group-name">{baseName(g.ws)}</span>
                      <button
                        className="sess-group-add"
                        title="在这个工作区新建对话"
                        onClick={e => {
                          e.stopPropagation();
                          store.newChatWith(g.ws);
                          setTab("chat");
                        }}
                      >
                        <Icon name="plus" size={13} />
                      </button>
                    </div>
                    {open && (
                      <>
                        {g.list.map(s => (
                          <div
                            key={s.id}
                            data-testid="session-item"
                            className={`session ${tab === "chat" && store.activeId === s.id ? "active" : ""}`}
                            onClick={() => {
                              store.setActiveId(s.id);
                              setTab("chat");
                            }}
                          >
                            {isRunning(s) ? <span className="spinner session-ico" /> : <Icon name="chat" size={14} />}
                            <span className="session-title">{s.title}</span>
                            <span className="session-time">{ago(s.updated)}</span>
                            <button
                              className="session-del"
                              title="删除"
                              onClick={e => {
                                e.stopPropagation();
                                store.remove(s.id);
                              }}
                            >
                              <Icon name="x" size={13} />
                            </button>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            {/* 折叠时每个对话缩成一个圆形小图标（取标题第一个字），悬停看标题 */}
            {navCollapsed && (
              <div className="session-chips">
                {(onChat ? [] : openTasks.slice(0, 8)).map(t => (
                  <button key={t.id} className={`session-chip task ${tab === "task" && activeTask === t.id ? "active" : ""}`} data-testid="task-chip" title={`任务：${t.title}`} onClick={() => openTask(t.id)}>
                    {Array.from(t.title.replace(/^[【\[\s]+/, ""))[0] ?? "任"}
                    {taskPhase(t, sessionOf(t)) === "running" && <span className="tb-dot" />}
                  </button>
                ))}
                {(onChat ? sessions : []).slice(0, 14).map(s => (
                  <button
                    key={s.id}
                    className={`session-chip ${tab === "chat" && store.activeId === s.id ? "active" : ""}`}
                    data-testid="session-chip"
                    title={s.title}
                    onClick={() => {
                      store.setActiveId(s.id);
                      setTab("chat");
                    }}
                  >
                    {Array.from(s.title.trim())[0] ?? "对"}
                    {isRunning(s) && <span className="tb-dot" />}
                  </button>
                ))}
              </div>
            )}
            {!navCollapsed && <div
              className={`nav-resizer ${navDrag ? "dragging" : ""}`}
              data-testid="nav-resizer"
              title="拖动调整宽度，双击恢复默认"
              onDoubleClick={() => {
                setNavW(NAV_DEFAULT);
                localStorage.removeItem(NAV_W_KEY);
              }}
              onPointerDown={e => {
                e.preventDefault();
                const el = e.currentTarget;
                el.setPointerCapture(e.pointerId);
                const left = el.parentElement!.getBoundingClientRect().left;
                setNavDrag(true);
                document.body.classList.add("resizing-nav");
                const move = (ev: PointerEvent) => setNavW(Math.round(Math.min(NAV_MAX, Math.max(NAV_MIN, ev.clientX - left))));
                const up = (ev: PointerEvent) => {
                  el.releasePointerCapture(e.pointerId);
                  el.removeEventListener("pointermove", move);
                  el.removeEventListener("pointerup", up);
                  el.removeEventListener("pointercancel", up);
                  document.body.classList.remove("resizing-nav");
                  setNavDrag(false);
                  localStorage.setItem(NAV_W_KEY, String(Math.round(Math.min(NAV_MAX, Math.max(NAV_MIN, ev.clientX - left)))));
                };
                el.addEventListener("pointermove", move);
                el.addEventListener("pointerup", up);
                el.addEventListener("pointercancel", up);
              }}
            />}
          </nav>
        )}

        <main className="main">
          {state.configError && <div className="topbanner">配置文件有误，已使用上一次可用配置：{state.configError}</div>}
          {/* 首页、对话页常驻挂载，切换标签不丢输入与滚动位置，也不用重复加载天气 */}
          <div className="page-host" hidden={tab !== "home"}>
            <Home active={tab === "home"} onOpenPlugin={id => uiPlugins.some(p => p.id.toLowerCase() === id) && openPlugin(uiPlugins.find(p => p.id.toLowerCase() === id)!.id)} />
          </div>
          <div className="page-host" hidden={tab !== "workbench"}>
            <Workbench state={state} store={store} active={tab === "workbench"} tasked={taskedKeys} onTask={taskFromItem} onOpenSettings={() => setTab("settings")} />
          </div>
          {/* 数据库页：第一次打开后常驻，切走再回来不丢打开的表和写了一半的 SQL */}
          {dbMounted && (
            <div className="page-host" hidden={tab !== "database"}>
              <Database active={tab === "database"} onManage={() => (setSettingsSec("connections"), setTab("settings"))} onFocus={setDbFocus} run={dbRun} />
            </div>
          )}
          {tab === "plugins" && <Plugins state={state} onChanged={refresh} onOpenSettings={() => (setSettingsSec("skills"), setTab("settings"))} />}
          {curTask && (
            <div className="page-host" hidden={tab !== "task"}>
              <TaskPage key={curTask.id} state={state} task={curTask} chat={taskChat} tasks={tasks} onChanged={refresh} onBack={() => setTab("workbench")} onRemove={removeTask} />
            </div>
          )}
          <div className="page-host" hidden={tab !== "chat"}>
            <Chat state={state} store={store} onChanged={refresh} prefill={prefill} />
          </div>
          {openedPlugins.map(id => {
            const p = uiPlugins.find(x => x.id === id);
            return p && (
              <div key={`${p.id}@${p.version}`} className="page-host" hidden={!(tab === "plugin" && activePlugin === id)}>
                <PluginView plugin={p} theme={theme} active={tab === "plugin" && activePlugin === id} onManageConnections={() => (setSettingsSec("connections"), setTab("settings"))} />
              </div>
            );
          })}
          {tab === "automation" && <Automations state={state} />}
          {tab === "defects" && <Defects result={defects} />}
          {tab === "replay" && <Replay />}
          {tab === "settings" && <Settings initial={settingsSec} state={state} onChanged={refresh} theme={theme} setTheme={setTheme} onBack={() => setTab(mainTab.current)}
              onUseRepo={p => {
                store.newChatWith(p);
                setTab("chat");
              }}
            />}
        </main>
        {assistantOpen && <Assistant state={state} store={assistant} wide={assistantWide} onToggleWide={() => setAssistantWide(w => !w)} onClose={() => setAssistantOpen(false)} db={tab === "database" ? { focus: dbFocus, onRunSql: r => setDbRun({ ...r, n: Date.now() + Math.random() }) } : undefined} />}
      </div>
      {uiPlugins.length > 0 && <PluginRail plugins={uiPlugins} activeId={tab === "plugin" ? activePlugin : null} onOpen={openPlugin} onManage={() => setTab("plugins")} />}
      </div>

      {updateOpen && update && update.state !== "none" && <UpdateDialog s={update} onClose={() => setUpdateOpen(false)} />}
      {approvals[0] && (
        <ApprovalModal key={approvals[0].id} req={approvals[0]} queued={approvals.length - 1} onDone={() => setApprovals(a => a.slice(1))} />
      )}
    </div>
  );
}

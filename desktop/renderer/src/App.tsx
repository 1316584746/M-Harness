import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { AppState, ApprovalRequest, GroupInboundDTO, TodoItemDTO } from "../../shared/api";
import { api } from "./api";
import { parseCfg } from "./lib/configEdit";
import { ApprovalModal } from "./components/ApprovalModal";
import { Dock, type DockItem } from "./components/Dock";
import { Icon, type IconName } from "./components/Icon";
import { Logo } from "./components/Logo";
import { PluginRail } from "./components/PluginRail";
import { PluginView } from "./components/PluginView";
import type { UiPlugin } from "../../shared/pluginhost";
import type { ConnKind } from "../../shared/connections";
import { UpdateDialog } from "./components/UpdateDialog";
import { isRunning, useChatStore } from "./lib/chatStore";
import { PHASE_TEXT, TIME_GROUPS, taskPhase, timeGroup, useTaskStore, type Task, type TaskSeed } from "./lib/taskStore";
import { Automations } from "./pages/Automations";
import { Defects } from "./pages/Defects";
import { useDefects } from "./lib/defects";
import { ENTRY_NAME } from "../../shared/defects";
import type { DbFocus, DbRunReq } from "../../shared/db";
import { SOURCE_TEXT, TaskPage, preamble, sigOf } from "./pages/Task";
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

/** 标题栏里「M-Harness › 页面名」的页面名（Dock 只在首页，其它页面靠它知道自己在哪） */
const PAGE_NAME: Record<string, string> = { chat: "对话", workbench: "工作台", task: "任务", database: "数据库", plugins: "插件中心", plugin: "插件", defects: "缺陷", automation: "自动化任务", replay: "回放", settings: "设置" };

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
  // 绑定了需求群的任务同步给主进程：飞书群里的提问据此按这个需求答、能查关联仓库的代码
  useEffect(() => {
    const repoCfg = (parseCfg(state.configText)?.repos ?? {}) as Record<string, { path?: string }>;
    const list = tasks.tasks
      .filter(t => t.groupId && !t.done)
      .map(t => ({
        groupId: t.groupId as string,
        taskId: t.id,
        title: t.title,
        briefing: preamble(t, t.repos.filter(n => repoCfg[n]?.path).map(n => ({ name: n, path: String(repoCfg[n].path) })), state.larkBound),
        repos: t.repos.filter(n => repoCfg[n]?.path),
        reply: t.groupReply ?? "global",
      }));
    void api.syncTaskGroups(list).catch(() => {});
  }, [tasks.tasks, state.configText, state.larkBound]);
  // 飞书需求群里群主的消息：进这个任务自己的对话（带任务完整的上下文 / 产物 / 工具），和在任务页里发一条一样；
  // 跑的时候主进程把过程和结果发回群里。任务的对话正在跑就排队，一个任务一次只处理一条
  const groupQ = useRef<GroupInboundDTO[]>([]);
  const [groupTick, setGroupTick] = useState(0);
  const live = useRef({ tasks: tasks.tasks, sessions: taskChat.sessions, send: taskChat.send, cfg: state.configText, lark: !!state.larkBound });
  live.current = { tasks: tasks.tasks, sessions: taskChat.sessions, send: taskChat.send, cfg: state.configText, lark: !!state.larkBound };
  useEffect(
    () =>
      api.onGroupInbound(m => {
        const t = live.current.tasks.find(x => x.id === m.taskId);
        const s = t && live.current.sessions.find(x => x.id === t.sessionId);
        if (!t || !s) {
          void api.groupAck(m.reqId, false);
          return;
        }
        const busy = isRunning(s) || groupQ.current.some(q => q.taskId === m.taskId);
        // 先确认主进程还在等这一条（它等了 8 秒没回音会自己接手，这时界面再跑就是同一条消息跑两遍）
        void api.groupAck(m.reqId, true, busy).then(accepted => {
          if (!accepted) return;
          groupQ.current.push(m);
          setGroupTick(n => n + 1);
        });
      }),
    [],
  );
  useEffect(() => {
    if (!groupQ.current.length) return;
    const handled = new Set<string>();
    for (const m of [...groupQ.current]) {
      if (handled.has(m.taskId)) continue;
      handled.add(m.taskId);
      const t = live.current.tasks.find(x => x.id === m.taskId);
      const s = t && live.current.sessions.find(x => x.id === t.sessionId);
      if (!t || !s) {
        groupQ.current = groupQ.current.filter(q => q !== m);
        void api.groupDrop(m.reqId, "这个任务已经不在了，这条消息没能处理。");
        continue;
      }
      if (isRunning(s)) continue;
      groupQ.current = groupQ.current.filter(q => q !== m);
      const repoCfg = (parseCfg(live.current.cfg)?.repos ?? {}) as Record<string, { path?: string }>;
      const repos = t.repos.filter(n => repoCfg[n]?.path).map(n => ({ name: n, path: String(repoCfg[n].path) }));
      const need = s.turns.length === 0 || t.ctxSent !== sigOf(t);
      const hint = "（这条消息来自飞书需求群：你的回复会原样发回群里，请直接简短、适合在群里读；写文件 / 执行命令会先在群里问群主确认，不要向用户提问等待。）";
      void live.current.send(`[群消息] ${m.text}`, undefined, `${need ? preamble(t, repos, live.current.lark) + "\n\n" : ""}${m.text}\n\n${hint}`, { sid: s.id, groupReq: m.reqId, ...(m.images?.length ? { images: m.images } : {}) });
      tasks.update(t.id, { ctxSent: sigOf(t) });
    }
  }, [groupTick, taskChat.sessions, tasks.tasks]);
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
  const [settingsConnKind, setSettingsConnKind] = useState<ConnKind | undefined>();
  /** 去「设置 → 连接」，并直接停在对应类别（SSH 插件 → 服务器，数据库 → 数据库……） */
  const manageConnections = (k?: ConnKind) => (setSettingsConnKind(k), setSettingsSec("connections"), setTab("settings"));
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
  // 首次打开、还没绑飞书：引导创建飞书智能体（点过「不再提示」就不弹）
  // 有新版本：标题栏最左边（工具区最外面）出现一个醒目的「新版本」胶囊，所有平台一样；点开是不挡操作的浮层。
  // 能应用内安装的（Windows 安装版）会同时在后台自动下载、空闲时自动装好重启；其它平台点开后去下载页。
  const updPct = update?.state === "downloading" ? (update.percent ?? 0) : undefined;
  const hasUpdate = !!update && !!update.latest && (update.state === "available" || update.state === "downloading" || update.state === "downloaded" || (update.state === "error" && !!update.latest)) && !(update.state === "available" && updateSkip.isSkipped(update.latest));
  const updLabel = !update
    ? ""
    : update.state === "downloading"
      ? `正在更新 ${updPct ?? 0}%`
      : update.state === "downloaded"
        ? update.canAutoInstall
          ? "已下载 · 空闲时自动安装"
          : "重启更新"
        : update.state === "error"
          ? "更新失败 · 查看"
          : `新版本 v${update.latest}`;

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
  const taskFromItem = (item: TaskSeed, open = false) => {
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

  /** 底部 Dock：只放主要页面和设置；助手 / 缺陷 / 自动化 / 回放 / 主题这些小工具收在底部状态栏右侧 */
  const dockGroups: DockItem[][] = [
    [
      { id: "chat", testid: "nav-chat", label: "对话", icon: "chat", hue: 212, on: tab === "chat", onClick: () => setTab("chat") },
      { id: "workbench", testid: "nav-workbench", label: "工作台", icon: "grid", hue: 24, on: tab === "workbench" || tab === "task", onClick: () => setTab("workbench") },
      { id: "database", testid: "nav-database", label: "数据库", icon: "database", hue: 160, on: tab === "database", onClick: () => setTab("database") },
      { id: "plugins", testid: "nav-plugins", label: "插件中心", icon: "plug", hue: 268, on: tab === "plugins", onClick: () => setTab("plugins") },
    ],
    [
      { id: "settings", testid: "nav-settings", label: "设置", icon: "settings", hue: 218, on: tab === "settings", onClick: () => toggle("settings") },
    ],
  ];

  return (
    <div className="app">
      <header className="titlebar">
        <div className="brand" data-testid="brand" title="首页" onClick={onHomeClick}>
          <Logo size={22} className="brand-logo" />
          M-Harness
          {anyRunning && <span className="spinner" style={{ color: "var(--run)", marginLeft: 8 }} />}
        </div>
        {tab !== "home" && PAGE_NAME[tab] && (
          <span className="crumb" data-testid="crumb">
            <Icon name="right" size={12} />
            {PAGE_NAME[tab]}
          </span>
        )}
        {/* 不在首页时，页面入口收在标题栏中间（首页是底部 Dock，两处不同时出现） */}
        {tab !== "home" && (
          <nav className="title-nav" aria-label="应用栏" data-testid="title-nav">
            {dockGroups.map((g, gi) => (
              <div className="title-nav-group" key={gi}>
                {gi > 0 && <span className="title-nav-sep" aria-hidden />}
                {g.map(it => (
                  <button key={it.id} type="button" className={`tn-btn ${it.on ? "on" : ""}`} data-testid={it.testid} title={it.label} aria-label={it.label} aria-current={it.on ? "page" : undefined} onClick={it.onClick}>
                    <Icon name={it.icon} size={17} />
                    {it.dot && <span className={`tn-dot ${it.dot}`} />}
                  </button>
                ))}
              </div>
            ))}
          </nav>
        )}
        <span className="spacer" />
        {/* 小工具：助手 / 缺陷 / 自动化 / 回放 / 主题（底部状态栏已取消，放回标题栏右侧） */}
        <div className="titlebar-tools">
          {hasUpdate && (
            <button
              className={`upd-pill ${update!.state}`}
              data-testid="update-pill"
              style={updPct !== undefined ? ({ "--p": `${updPct}%` } as CSSProperties) : undefined}
              title={
                update!.state === "downloading"
                  ? `正在下载 v${update!.latest}（${updPct ?? 0}%），下载完会自动安装并重新打开`
                  : update!.state === "downloaded"
                    ? update!.canAutoInstall
                      ? `v${update!.latest} 已下载，没有任务在跑时会自动安装并重新打开；点一下立即安装`
                      : `v${update!.latest} 已下载，点一下重启并安装`
                    : update!.state === "error"
                      ? `更新失败：${update!.error ?? ""}，点一下重试`
                      : `当前 v${update!.current} → v${update!.latest}${update!.canAutoInstall ? "，正在后台下载" : "，点一下查看"}`
              }
              onClick={() => {
                // 不弹窗：能自动装的直接后台处理，点胶囊只是「立刻装 / 重试」；不能自动装的（macOS / Linux）才展开说明
                if (update!.state === "downloaded") void api.updateInstall();
                else if (update!.state === "error" || (update!.state === "available" && update!.canAutoInstall)) void api.updateDownload();
                else if (update!.state === "available") setUpdateOpen(true);
              }}
            >
              <Icon name="updateUp" size={15} />
              <span>{updLabel}</span>
            </button>
          )}
          <button
            className={`tb-btn ${hasUpdate ? "update" : ""} ${updateOpen ? "on" : ""}`}
            data-testid="nav-update"
            data-has-update={hasUpdate ? "1" : "0"}
            title={hasUpdate ? `发现新版本 v${update!.latest}，点击查看` : "检查更新"}
            aria-label={hasUpdate ? `发现新版本 v${update!.latest}` : "检查更新"}
            onClick={() => {
              // 有新版本直接看；没有就顺手检查一次，弹窗里显示结果
              if (!hasUpdate && update?.state !== "checking" && update?.state !== "available" && update?.state !== "downloaded") void api.updateCheck();
              setUpdateOpen(true);
            }}
          >
            <Icon name="cloud" size={16} />
            {hasUpdate && <span className="tb-dot update" />}
          </button>
          <button className={`tb-btn ${assistantOpen ? "on" : ""}`} data-testid="nav-assistant" title="AI 助手 (Ctrl + Alt + I)" aria-label="AI 助手" onClick={() => setAssistantOpen(o => !o)}>
            <Icon name="bot" size={16} />
            {assistantRunning && !assistantOpen && <span className="tb-dot" />}
          </button>
          {defects?.enabled && (
            <button
              className={`tb-btn ${tab === "defects" ? "on" : ""}`}
              data-testid="nav-defects"
              aria-label={defectCount > 0 ? `${ENTRY_NAME[defects.source ?? "feishu"]}：${defectCount} 个待处理${defectNew > 0 ? `（${defectNew} 个新的）` : ""}` : ENTRY_NAME[defects.source ?? "feishu"]}
              title={defectCount > 0 ? `${ENTRY_NAME[defects.source ?? "feishu"]}：${defectCount} 个待处理${defectNew > 0 ? `（${defectNew} 个新的）` : ""}` : ENTRY_NAME[defects.source ?? "feishu"]}
              onClick={() => toggle("defects")}
            >
              <Icon name="bug" size={16} />
              {defectCount > 0 && (
                <span className={`tb-count ${defectNew > 0 ? "new" : ""}`} data-testid="defect-badge">
                  {defectCount > 99 ? "99+" : defectCount}
                </span>
              )}
            </button>
          )}
          {TOOLS.map(t => (
            <button key={t.id} className={`tb-btn ${tab === t.id ? "on" : ""}`} data-testid={`nav-${t.id}`} title={t.label} aria-label={t.label} onClick={() => toggle(t.id)}>
              <Icon name={t.icon} size={16} />
            </button>
          ))}
          <button className="tb-btn" data-testid="theme-toggle" title={theme === "dark" ? "切换到浅色" : "切换到深色"} onClick={() => setTheme(theme === "dark" ? "light" : "dark")}>
            <Icon name={theme === "dark" ? "moon" : "sun"} size={16} />
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
            {onChat && (
              <button
                className="nav-new"
                data-testid="new-chat"
                title="新建对话"
                onClick={() => store.newChat()}
              >
                <Icon name="plus" size={14} />
                <span>新建对话</span>
              </button>
            )}
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
                        data-testid="session-group-del"
                        title="删除这个工作区下的所有对话（不会删除文件夹本身）"
                        onClick={e => {
                          e.stopPropagation();
                          if (!window.confirm(`删除「${baseName(g.ws)}」下的 ${g.list.length} 个对话？\n\n只删对话记录，文件夹和里面的文件不会动。`)) return;
                          for (const s of g.list) store.remove(s.id);
                        }}
                      >
                        <Icon name="trash" size={13} />
                      </button>
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
              <Database active={tab === "database"} onManage={() => manageConnections("database")} onFocus={setDbFocus} run={dbRun} />
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
                <PluginView plugin={p} theme={theme} active={tab === "plugin" && activePlugin === id} onManageConnections={manageConnections} />
              </div>
            );
          })}
          {tab === "automation" && <Automations state={state} />}
          {tab === "defects" && <Defects result={defects} />}
          {tab === "replay" && <Replay />}
          {tab === "settings" && <Settings initial={settingsSec} initialConnKind={settingsConnKind} state={state} onChanged={refresh} theme={theme} setTheme={setTheme} onBack={() => setTab(mainTab.current)}
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

      {/* Dock 只在首页出现；其它页面藏起来（点左上角 M-Harness 回首页），页面里的按钮照常能用 */}
      {tab === "home" && (
        <div className="dock-slot float">
          <Dock groups={dockGroups} />
        </div>
      )}

      {updateOpen && update && <UpdateDialog s={update} onClose={() => setUpdateOpen(false)} />}
      {approvals[0] && (
        <ApprovalModal key={approvals[0].id} req={approvals[0]} queued={approvals.length - 1} onDone={() => setApprovals(a => a.slice(1))} />
      )}
    </div>
  );
}

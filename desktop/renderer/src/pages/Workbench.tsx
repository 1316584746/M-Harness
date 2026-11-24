import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppState, RepoInfo, TodoItemDTO, WorkbenchTodosDTO } from "../../../shared/api";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { parseCfg } from "../lib/configEdit";
import { isRunning, type ChatStore } from "../lib/chatStore";
import { addChild, patchChild } from "../../../shared/todoPatch";
import { Schedule, type ChildCreate, type ChildEdit } from "./workbench/Schedule";
import { NewTaskDialog } from "../components/NewTaskDialog";
import { manualId, type TaskSeed } from "../lib/taskStore";

/** 截止时间：逾期 / 今天 18:00 / 明天 / 11-20 */
export function dueText(due: number, now = Date.now()): string {
  const d = new Date(due);
  const day = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime();
  const diff = Math.round((day(d) - day(new Date(now))) / 86400000);
  const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  const hasTime = d.getHours() !== 0 || d.getMinutes() !== 0;
  if (diff === 0) return hasTime ? `今天 ${hm}` : "今天";
  if (diff === 1) return "明天";
  if (diff === -1) return "昨天";
  if (diff < 0) return `${-diff} 天前`;
  return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function Workbench({
  state,
  store,
  active,
  tasked,
  onTask,
  onOpenSettings,
}: {
  state: AppState;
  store: ChatStore;
  active: boolean;
  /** 已经建过任务的需求（source + id） */
  tasked: Set<string>;
  /** 点击需求：在左侧建任务；open=true 同时打开 */
  onTask: (t: TaskSeed, open: boolean) => void;
  /** 打开设置 */
  onOpenSettings: () => void;
}) {
  const [todos, setTodos] = useState<WorkbenchTodosDTO | null>(null);
  const [repos, setRepos] = useState<RepoInfo[] | null>(null);
  const [loadingTodos, setLoadingTodos] = useState(false);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const loading = loadingTodos || loadingRepos;
  const [at, setAt] = useState(0);
  const [newTask, setNewTask] = useState(false);

  /** 在本软件里改子任务 = 直接改飞书项目：成功后用飞书读回来的值刷新界面，失败把原因交给界面显示 */
  const editChild: ChildEdit = useCallback(async (t, c, change) => {
    if (!t.projectKey || !c.nodeKey) return "缺少任务的定位信息，请先点「刷新」再试";
    const r = await api.workbenchSubtaskUpdate({ projectKey: t.projectKey, wid: t.id, nodeKey: c.nodeKey, subId: c.id, ...change });
    // 飞书读回来的值（读不到就按我们写的）
    const now = r.child ?? (r.ok ? { ...(change.done !== undefined ? { done: change.done } : {}), ...(change.start !== undefined ? { start: change.start, end: change.end } : {}), ...(change.days !== undefined ? { days: change.days } : {}) } : undefined);
    if (now) {
      setTodos(prev =>
        prev && { ...prev, feishu: { ...prev.feishu, items: patchChild(prev.feishu.items, t.id, c.id, now) }, items: patchChild(prev.items, t.id, c.id, now) },
      );
    }
    return r.ok ? undefined : r.error || "飞书项目没有接受这次修改";
  }, []);

  /** 在飞书项目的某个节点下新增子任务：成功后把飞书读回来的新子任务加进列表 */
  const createChild: ChildCreate = useCallback(async (t, nodeKey, name) => {
    if (!t.projectKey) return "缺少需求的定位信息，请先点「刷新」再试";
    const r = await api.workbenchSubtaskCreate({ projectKey: t.projectKey, wid: t.id, nodeKey, name });
    const child = r.child;
    if (r.ok && child) {
      setTodos(prev => prev && { ...prev, feishu: { ...prev.feishu, items: addChild(prev.feishu.items, t.id, child) }, items: addChild(prev.items, t.id, child) });
    }
    return r.ok ? undefined : r.error || "飞书项目没有接受这次新增";
  }, []);

  // 待办（读飞书 / 钉钉，要十几秒）和仓库状态（读 git）各读各的，谁先好谁先显示；
  // 待办先用上次读成功的结果顶着，后台刷新完再换成最新的
  const load = useCallback(async () => {
    setAt(Date.now());
    setLoadingRepos(true);
    setLoadingTodos(true);
    void api
      .listRepos()
      .catch(() => [] as RepoInfo[])
      .then(r => setRepos(r))
      .finally(() => setLoadingRepos(false));
    void api.workbenchTodosCached().then(c => c && setTodos(prev => prev ?? c)).catch(() => undefined);
    void api
      .workbenchTodos()
      .catch(() => null)
      // 这次读失败（null）时不要把已经显示的内容清掉
      .then(t => setTodos(prev => t ?? prev))
      .finally(() => setLoadingTodos(false));
  }, []);

  // 第一次进入、之后每次切回来且数据超过 1 分钟才重新拉
  useEffect(() => {
    if (active && Date.now() - at > 60_000) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // 去飞书项目网页里改完再切回软件：窗口重新获得焦点时，停在工作台且数据超过 30 秒也自动重读一次
  const atRef = useRef(at);
  atRef.current = at;
  const busyRef = useRef(false);
  busyRef.current = loadingTodos || loadingRepos;
  useEffect(() => {
    if (!active) return;
    const onFocus = () => {
      if (!busyRef.current && Date.now() - atRef.current > 30_000) void load();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // 项目管理只接一个：设置 → 办公里接了飞书项目就看飞书，接了钉钉就看钉钉（同时存在时以飞书为准）
  const integrations = useMemo(() => parseCfg(state.configText)?.integrations as { feishuProject?: { defaultSpace?: { name?: string } }; dingtalkProject?: unknown } | undefined, [state.configText]);
  const src: TodoItemDTO["source"] | undefined = integrations?.feishuProject ? "feishu" : integrations?.dingtalkProject ? "dingtalk" : undefined;
  const srcData = src ? todos?.[src] : undefined;
  const items = useMemo(() => (srcData?.ok ? srcData.items : []), [srcData]);
  const overdue = items.filter(i => i.overdue).length;
  const running = store.sessions.filter(isRunning);
  const dirty = (repos ?? []).filter(r => r.status.exists && (r.status.changed > 0 || r.status.ahead > 0)).length;
  const nowStr = new Date().toLocaleDateString("zh-CN", { month: "long", day: "numeric", weekday: "long" });

  return (
    <div className="wb" data-testid="workbench">
      <div className="wb-inner">
        <div className="wb-head">
          <div>
            <h1>工作台</h1>
            <div className="muted">{nowStr}</div>
          </div>
          <div className="wb-head-btns">
            <button className="btn sm" data-testid="wb-new-task" title="不依赖飞书项目 / 钉钉，直接建一个任务" onClick={() => setNewTask(true)}>
              <Icon name="plus" size={14} /> 新建任务
            </button>
            <button className="btn sm" data-testid="wb-refresh" onClick={() => void load()} disabled={loading}>
              {loading ? <span className="spinner" /> : <Icon name="refresh" size={14} />} 刷新
            </button>
          </div>
        </div>

        <div className="wb-stats">
          <div className="wb-stat" data-testid="wb-stat-todo">
            <b>{srcData?.ok ? items.length : "–"}</b>
            <span>待办{overdue > 0 && <em className="bad"> · {overdue} 逾期</em>}</span>
          </div>
          <div className="wb-stat" data-testid="wb-stat-running">
            <b>{running.length}</b>
            <span>进行中的对话</span>
          </div>
          <div className="wb-stat" data-testid="wb-stat-repo">
            <b>{repos ? dirty : "–"}</b>
            <span>有未提交 / 未推送的仓库</span>
          </div>
          <div className="wb-stat">
            <b>{store.sessions.length}</b>
            <span>全部对话</span>
          </div>
        </div>

        {src ? (
          <Schedule
            source={src}
            items={items}
            loaded={!!srcData?.ok}
            loading={loading}
            refreshKey={at}
            title={src === "feishu" ? integrations?.feishuProject?.defaultSpace?.name : undefined}
            error={srcData && srcData.enabled && !srcData.ok ? srcData.error : undefined}
            user={srcData?.user}
            onEdit={editChild}
            onCreate={createChild}
            tasked={tasked}
            onTask={onTask}
          />
        ) : (
          <section className="wb-card" data-testid="wb-schedule">
            <div className="wb-card-head">
              <h2>我的排期</h2>
            </div>
            <div className="wb-note" data-testid="wb-off">
              还没有接入飞书项目或钉钉，
              <button className="link" onClick={() => onOpenSettings()}>
                去设置里打开
              </button>
              ；也可以
              <button className="link" data-testid="wb-new-task-link" onClick={() => setNewTask(true)}>
                直接新建一个任务
              </button>
            </div>
          </section>
        )}
        {newTask && (
          <NewTaskDialog
            onClose={() => setNewTask(false)}
            onCreate={(title, prdUrl) => {
              setNewTask(false);
              onTask({ id: manualId(), title, source: "manual", ...(prdUrl ? { prdUrl } : {}) }, true);
            }}
          />
        )}

      </div>
    </div>
  );
}

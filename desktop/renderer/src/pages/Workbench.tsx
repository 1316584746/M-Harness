import { useCallback, useEffect, useMemo, useState } from "react";
import type { AppState, RepoInfo, TodoItemDTO, WorkbenchTodosDTO } from "../../../shared/api";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { parseCfg } from "../lib/configEdit";
import { isRunning, type ChatStore } from "../lib/chatStore";
import { useScheduleStore } from "../lib/scheduleStore";
import { Schedule } from "./workbench/Schedule";

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
  onTask: (t: TodoItemDTO, open: boolean) => void;
  /** 打开设置 */
  onOpenSettings: () => void;
}) {
  const [todos, setTodos] = useState<WorkbenchTodosDTO | null>(null);
  const [repos, setRepos] = useState<RepoInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [at, setAt] = useState(0);
  const sched = useScheduleStore();

  const load = useCallback(async () => {
    setLoading(true);
    const [t, r] = await Promise.all([api.workbenchTodos().catch(() => null), api.listRepos().catch(() => [] as RepoInfo[])]);
    setTodos(t);
    setRepos(r);
    setAt(Date.now());
    setLoading(false);
  }, []);

  // 第一次进入、之后每次切回来且数据超过 1 分钟才重新拉
  useEffect(() => {
    if (active && Date.now() - at > 60_000) void load();
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
          <button className="btn sm" data-testid="wb-refresh" onClick={() => void load()} disabled={loading}>
            {loading ? <span className="spinner" /> : <Icon name="refresh" size={14} />} 刷新
          </button>
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
            title={src === "feishu" ? integrations?.feishuProject?.defaultSpace?.name : undefined}
            error={srcData && srcData.enabled && !srcData.ok ? srcData.error : undefined}
            user={srcData?.user}
            sched={sched}
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
            </div>
          </section>
        )}

      </div>
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { TodoItemDTO } from "../../../shared/api";
import { isRunning, type Session } from "./chatStore";

export interface TaskDoc {
  id: string;
  title: string;
  content: string;
  added: number;
}
/** 需求的链接：待办里带了就用它；飞书项目的需求没带时，按空间 + 工作项 ID 拼出详情页地址（默认是需求 story） */
export function taskUrl(t: Pick<Task, "url" | "source" | "projectKey" | "itemId">): string | undefined {
  if (t.url) return t.url;
  if (t.source === "feishu" && t.projectKey && /^[\w.-]+$/.test(t.projectKey) && /^\d+$/.test(t.itemId)) return `https://project.feishu.cn/${t.projectKey}/story/detail/${t.itemId}`;
  return undefined;
}

export type DocKind = "url" | "path" | "text";

/** 内容是链接、本机路径还是直接写的文字 */
export function docKind(content: string): DocKind {
  const s = content.trim();
  if (/^https?:\/\/\S+$/i.test(s)) return "url";
  if (/^([a-zA-Z]:[\\/]|\/|~\/)[^\n]*$/.test(s)) return "path";
  return "text";
}

/** 由一个需求（飞书项目工作项 / 钉钉待办）创建的任务；对话内容放在任务自己的会话里 */
export interface Task {
  id: string;
  /** feishu / dingtalk = 由项目管理里的需求创建；manual = 在工作台手动新建（没有外部工作项） */
  source: TodoItemDTO["source"] | "manual";
  /** 需求的工作项 ID（同一个需求只会有一个任务） */
  itemId: string;
  title: string;
  node?: string;
  sub?: string;
  url?: string;
  /** 需求所在飞书项目空间的 key（查需求群要用） */
  projectKey?: string;
  /** 需求编号（REQ-ID），可后补 */
  reqId?: string;
  /** 这个任务对应的 PRD 链接（选填）：发给 AI 的任务说明里会带上，方案设计写进「PRD 链接」 */
  prdUrl?: string;
  /** 手动关联 / 自动创建的需求群（oc_ 开头）；没有就用飞书项目里这个需求默认的群 */
  groupId?: string;
  /** 群里 AI 的回复方式：跟随全局 / 流式 / 整条发送 */
  groupReply?: "global" | "stream" | "whole";
  start?: number;
  end?: number;
  /** 关联的代码仓库（配置里的名字） */
  repos: string[];
  /** 任务上下文（旧版的一段文字）：每次发给 AI 前都会带上 */
  context: string;
  /** 任务上下文文档：一条一条加（链接 / 本机路径 / 文字），发给 AI 前一起带上 */
  docs?: TaskDoc[];
  /** 已经发给 AI 的上下文（变了才再带一次） */
  ctxSent?: string;
  /** 用来放对话的会话 id */
  sessionId: string;
  done?: boolean;
  created: number;
  updated: number;
}

/** 创建任务用的需求信息：项目管理里的需求，或手动新建的（source=manual） */
export type TaskSeed = Omit<TodoItemDTO, "source"> & { source: Task["source"]; prdUrl?: string };

/** PRD 链接：空的算没填；填了必须是 http(s) 链接 */
export function prdUrlError(v: string): string | undefined {
  const s = v.trim();
  return !s || /^https?:\/\/\S+$/i.test(s) ? undefined : "请填完整的链接（以 http:// 或 https:// 开头）";
}

/** 手动新建任务用的 itemId（同一个来源下不重复） */
export const manualId = () => `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export type TaskPhase = "todo" | "running" | "waiting" | "broken" | "done";

export const PHASE_TEXT: Record<TaskPhase, string> = { todo: "待确认", running: "进行中", waiting: "等待回复", broken: "已中断", done: "已完成" };

/** 任务现在处于什么阶段：还没开始 / AI 在跑 / 等你回复 / 上次中断了 / 已完成 */
export function taskPhase(t: Task, s?: Session | null): TaskPhase {
  if (t.done) return "done";
  if (!s || s.turns.length === 0) return "todo";
  if (isRunning(s)) return "running";
  const last = s.turns.at(-1);
  return last?.status === "error" || last?.status === "aborted" ? "broken" : "waiting";
}

const KEY = "harness.tasks.v1";

function load(): Task[] {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) ?? "[]") as Task[];
    return Array.isArray(arr) ? arr.filter(t => t && typeof t.id === "string") : [];
  } catch {
    return [];
  }
}

let seq = 0;
const tid = () => `t${Date.now().toString(36)}${++seq}`;

export type TimeGroup = "今天" | "昨天" | "近 7 天" | "更早";
export const TIME_GROUPS: TimeGroup[] = ["今天", "昨天", "近 7 天", "更早"];

/** 按最近活动时间分组：今天 / 昨天 / 近 7 天 / 更早 */
export function timeGroup(ms: number, now = Date.now()): TimeGroup {
  const day = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const diff = Math.round((day(now) - day(ms)) / 86400000);
  return diff <= 0 ? "今天" : diff === 1 ? "昨天" : diff < 7 ? "近 7 天" : "更早";
}

export function useTaskStore() {
  const [tasks, setTasks] = useState<Task[]>(load);
  const ref = useRef(tasks);
  ref.current = tasks;

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(KEY, JSON.stringify(tasks));
      } catch {
        /* 配额满了就算了 */
      }
    }, 300);
    return () => clearTimeout(t);
  }, [tasks]);

  // 刚改完就关窗口 / 刷新时，防抖还没来得及写，退出前补写一次
  useEffect(() => {
    const flush = () => {
      try {
        localStorage.setItem(KEY, JSON.stringify(ref.current));
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, []);

  const find = useCallback((source: Task["source"], itemId: string) => ref.current.find(t => t.source === source && t.itemId === itemId), []);

  /** 为需求创建任务；已经有就复用（已完成的重新打开）。sessionId 由调用方先建好 */
  const add = useCallback((item: TaskSeed, sessionId: string): Task => {
    const task: Task = {
      id: tid(),
      source: item.source,
      itemId: item.id,
      title: item.title,
      node: item.node,
      sub: item.sub,
      url: item.url,
      projectKey: item.projectKey,
      ...(item.prdUrl?.trim() ? { prdUrl: item.prdUrl.trim() } : {}),
      start: item.start,
      end: item.end,
      repos: [],
      context: "",
      sessionId,
      created: Date.now(),
      updated: Date.now(),
    };
    setTasks(ts => [task, ...ts]);
    return task;
  }, []);

  const update = useCallback((id: string, patch: Partial<Task>) => setTasks(ts => ts.map(t => (t.id === id ? { ...t, ...patch, updated: Date.now() } : t))), []);
  /** 只改字段、不算"最近活动"（比如同步需求的最新信息） */
  const quiet = useCallback((id: string, patch: Partial<Task>) => setTasks(ts => ts.map(t => (t.id === id ? { ...t, ...patch } : t))), []);
  const remove = useCallback((id: string) => setTasks(ts => ts.filter(t => t.id !== id)), []);

  return { tasks, find, add, update, quiet, remove };
}

export type TaskStore = ReturnType<typeof useTaskStore>;

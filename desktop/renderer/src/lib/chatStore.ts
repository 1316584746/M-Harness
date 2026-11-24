import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppState, AskRequest, HarnessEvent, Msg } from "../../../shared/api";
import { api } from "../api";
import { toolBudgetFor } from "./budget";

/** 运行中按回车排队的消息 */
export interface QueuedMsg {
  text: string;
  onFinished?: () => void;
  runInput?: string;
  images?: string[];
  /** 这条是「推进任务」里选的哪一步（任务页按步骤分开存产物用） */
  step?: StepRef;
}

/** 推进任务时选的步骤：id（analysis / plan / build … 或自定义动作的 id）和显示名 */
export interface StepRef {
  id: string;
  name: string;
}

export interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
  /** 用户这条消息附带的图片（本机文件路径） */
  images?: string[];
  /** 用户消息：是从「推进任务」选某一步发出的，产物按这个分开放；自由输入的没有 */
  step?: StepRef;
  provider?: string;
  events: HarnessEvent[];
  /** 每个事件到达的时间（和 events 一一对应），用来显示已运行多久、多久没有新输出 */
  times?: number[];
  /** 这一轮开始运行的时间 */
  startedAt?: number;
  status?: "running" | "done" | "error" | "aborted";
  traceFile?: string;
  /** 这一轮用掉的 token 总数（外部 Agent 没报用量时没有） */
  tokens?: number;
}

export interface Session {
  id: string;
  title: string;
  provider: string;
  /** 本对话临时选用的模型（不改全局配置） */
  model?: string;
  /** 本对话关闭的工具 */
  disabledTools?: string[];
  workspace?: string;
  /** 标题固定（任务对话用需求名，不被第一句话覆盖） */
  fixedTitle?: boolean;
  history: Msg[];
  turns: Turn[];
  updated: number;
}

const KEY = "harness.sessions.v1";
const MAX_SESSIONS = 60;

let seq = 0;
export const uid = () => `r${Date.now().toString(36)}${++seq}`;

export const isRunning = (s?: Session | null) => !!s?.turns.some(t => t.status === "running");

/** 存档时去掉体积最大的 model_call.messages（完整消息可在「回放」里的 trace 文件看） */
function slim(ss: Session[]): Session[] {
  return ss.slice(0, MAX_SESSIONS).map(s => ({
    ...s,
    turns: s.turns.map(t => ({
      ...t,
      events: t.events.map(e => (e.type === "model_call" ? { ...e, messages: [] } : e)),
    })),
  }));
}

function load(key: string): Session[] {
  try {
    const arr = JSON.parse(localStorage.getItem(key) ?? "[]") as Session[];
    return arr.map(s => ({
      ...s,
      // 上次退出时仍在运行的任务，视为已中断
      turns: s.turns.map(t => (t.status === "running" ? { ...t, status: "aborted" as const, text: t.text || "（应用关闭，运行已中断）" } : t)),
    }));
  } catch {
    return [];
  }
}

/** storageKey：不同用途（主对话 / AI 助手面板）用各自的存档，互不干扰 */
export function useChatStore(state: AppState, storageKey = KEY) {
  const [sessions, setSessions] = useState<Session[]>(() => load(storageKey));
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draftProvider, setDraftProvider] = useState(state.defaultProvider);
  const [draftWorkspace, setDraftWorkspace] = useState<string | undefined>();
  const [draftModel, setDraftModel] = useState<string | undefined>();
  const [draftDisabled, setDraftDisabled] = useState<string[]>([]);
  const ref = useRef(sessions);
  ref.current = sessions;

  // 持久化（防抖）
  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(storageKey, JSON.stringify(slim(sessions)));
      } catch {
        /* 配额满了就算了 */
      }
    }, 400);
    return () => clearTimeout(t);
  }, [sessions, storageKey]);

  // 运行事件按 runKey 归到对应会话，切到别的会话也不丢
  useEffect(
    () =>
      api.onRunEvent((key, event) => {
        setSessions(ss =>
          ss.map(s => (s.turns.some(t => t.id === key) ? { ...s, turns: s.turns.map(t => (t.id === key ? { ...t, events: [...t.events, event], times: [...(t.times ?? []), Date.now()] } : t)) } : s)),
        );
      }),
    [],
  );

  // 在设置里换了全局使用的 Agent：新对话默认跟随（已有对话保持各自的选择）
  const lastDefault = useRef(state.defaultProvider);
  useEffect(() => {
    if (lastDefault.current !== state.defaultProvider) {
      lastDefault.current = state.defaultProvider;
      setDraftProvider(state.defaultProvider);
    }
  }, [state.defaultProvider]);

  // provider 被删除/不可用时回退
  useEffect(() => {
    if (!state.providers.some(p => p.name === draftProvider)) setDraftProvider(state.defaultProvider);
  }, [state.providers, state.defaultProvider, draftProvider]);

  const active = useMemo(() => sessions.find(s => s.id === activeId) ?? null, [sessions, activeId]);
  const provider = active?.provider ?? draftProvider;
  const workspace = active ? active.workspace : draftWorkspace;
  const model = active ? active.model : draftModel;
  const disabledTools = active ? (active.disabledTools ?? []) : draftDisabled;

  const setProvider = useCallback(
    (p: string) => {
      setDraftProvider(p);
      setDraftModel(undefined);
      if (activeId) setSessions(ss => ss.map(s => (s.id === activeId ? { ...s, provider: p, model: undefined } : s)));
    },
    [activeId],
  );
  const setModel = useCallback(
    (m: string | undefined) => {
      setDraftModel(m);
      if (activeId) setSessions(ss => ss.map(s => (s.id === activeId ? { ...s, model: m } : s)));
    },
    [activeId],
  );
  const setDisabledTools = useCallback(
    (names: string[]) => {
      setDraftDisabled(names);
      if (activeId) setSessions(ss => ss.map(s => (s.id === activeId ? { ...s, disabledTools: names } : s)));
    },
    [activeId],
  );
  const setWorkspace = useCallback(
    (w: string) => {
      setDraftWorkspace(w);
      if (activeId) setSessions(ss => ss.map(s => (s.id === activeId ? { ...s, workspace: w } : s)));
    },
    [activeId],
  );

  const send = useCallback(
    async (text: string, onFinished?: () => void, runInput?: string, opts?: { fresh?: boolean; images?: string[]; step?: StepRef; sid?: string; groupReq?: string }) => {
      // sid：指定发到哪个对话（飞书群里的消息要进任务自己的对话，不管当前打开的是哪个）；groupReq：这一轮是群里问的，结果由主进程回复到群里
      const cur = ref.current.find(s => s.id === (opts?.sid ?? activeId));
      if (isRunning(cur)) return;
      const key = uid();
      const sid = cur?.id ?? uid();
      const prov = cur?.provider ?? draftProvider;
      const ws = cur ? cur.workspace : draftWorkspace;
      const mdl = cur ? cur.model : draftModel;
      const off = cur ? (cur.disabledTools ?? []) : draftDisabled;
      // fresh：这一轮不带之前的对话（开全新上下文），跑完后后续轮次接着这一轮继续
      const history = opts?.fresh ? [] : (cur?.history ?? []);
      const newTurns: Turn[] = [
        { id: uid(), role: "user", text, events: [], ...(opts?.images?.length ? { images: opts.images } : {}), ...(opts?.step ? { step: opts.step } : {}) },
        { id: key, role: "assistant", text: "", provider: prov, events: [], times: [], startedAt: Date.now(), status: "running" },
      ];
      if (cur) {
        // 点「新建对话」时已经建好了空对话：第一次发送时用这句话当标题
        const title = text.replace(/\s+/g, " ").slice(0, 40);
        setSessions(ss => ss.map(s => (s.id === sid ? { ...s, title: s.turns.length === 0 && !s.fixedTitle ? title : s.title, turns: [...s.turns, ...newTurns], updated: Date.now() } : s)));
      } else {
        const s: Session = { id: sid, title: text.replace(/\s+/g, " ").slice(0, 40), provider: prov, model: mdl, disabledTools: off, workspace: ws, history: [], turns: newTurns, updated: Date.now() };
        setSessions(ss => [s, ...ss]);
        setActiveId(sid);
      }

      // 同步到飞书智能体用的标题：任务里的对话用任务名 + 步骤，普通对话用对话标题
      const mirrorTitle = [cur?.title && (cur.turns.length > 0 || cur.fixedTitle) ? cur.title : text.replace(/\s+/g, " ").slice(0, 40), opts?.step?.name].filter(Boolean).join(" · ");
      let r: Awaited<ReturnType<typeof api.run>>;
      try {
        r = await api.run({ runKey: key, ...(opts?.groupReq ? { groupReq: opts.groupReq } : { mirror: { title: mirrorTitle, question: text } }), input: runInput ?? text, images: opts?.images?.length ? opts.images : undefined, provider: prov, history, workspace: ws, model: mdl, disabledTools: off.length ? off : undefined, sessionKey: sid, ...(opts?.fresh ? { fresh: true } : {}), ...(toolBudgetFor(opts?.step?.id) ? { toolBudget: toolBudgetFor(opts?.step?.id) } : {}) });
      } catch (e: any) {
        // 主进程那边崩了 / 通道断了：不能让这一轮永远停在「运行中」，按失败处理并给出原因
        r = { reason: "error", text: "", error: `和后台的连接出问题了：${e?.message ?? e}`, steps: 0, tokens: 0, messages: history, traceFile: "", runId: "" } as Awaited<ReturnType<typeof api.run>>;
      }
      const status = r.reason === "final" ? "done" : r.reason === "aborted" ? "aborted" : "error";
      setSessions(ss =>
        ss.map(s =>
          s.id !== sid
            ? s
            : {
                ...s,
                updated: Date.now(),
                history: r.reason === "final" || r.reason === "max_steps" ? r.messages : s.history,
                turns: s.turns.map(t =>
                  t.id === key
                    ? {
                        ...t,
                        status,
                        traceFile: r.traceFile,
                        ...(r.tokens > 0 ? { tokens: r.tokens } : {}),
                        text: r.reason === "final" ? r.text || "（模型没有返回内容）" : `${r.error ?? r.reason}${r.text ? "\n\n" + r.text : ""}`,
                      }
                    : t,
                ),
              },
        ),
      );
      onFinished?.();
    },
    [activeId, draftProvider, draftWorkspace, draftModel, draftDisabled],
  );

  const abort = useCallback(
    (sid: string) => {
      const s = ref.current.find(x => x.id === sid);
      const t = s?.turns.find(x => x.status === "running");
      if (t) void api.abort(t.id);
    },
    [],
  );

  const remove = useCallback(
    (sid: string) => {
      abort(sid);
      setSessions(ss => ss.filter(s => s.id !== sid));
      setActiveId(a => (a === sid ? null : a));
    },
    [abort],
  );

  /** 新建一个空对话并切过去：每点一次「新建对话」就多一个；可指定工作区（如某个代码仓库） */
  const newChat = useCallback(
    (ws?: string, opt?: { title?: string }) => {
      const id = uid();
      const s: Session = { id, title: opt?.title ?? "新对话", fixedTitle: opt?.title ? true : undefined, provider: draftProvider, model: draftModel, disabledTools: draftDisabled, workspace: ws ?? draftWorkspace, history: [], turns: [], updated: Date.now() };
      setSessions(ss => [s, ...ss]);
      setActiveId(id);
      return id;
    },
    [draftProvider, draftModel, draftDisabled, draftWorkspace],
  );
  const newChatWith = useCallback((ws: string) => newChat(ws), [newChat]);

  // AI 还在运行时按回车：消息先排队，这一轮结束后自动发出（每个对话各自排队，按顺序一条条发）
  const [queues, setQueues] = useState<Record<string, QueuedMsg[]>>({});
  const queued = activeId ? (queues[activeId] ?? []) : [];
  const enqueue = useCallback(
    (text: string, onFinished?: () => void, runInput?: string, images?: string[], step?: StepRef) => {
      if (activeId) setQueues(q => ({ ...q, [activeId]: [...(q[activeId] ?? []), { text, onFinished, runInput, images, step }] }));
    },
    [activeId],
  );
  const dequeue = useCallback((i: number) => activeId && setQueues(q => ({ ...q, [activeId]: (q[activeId] ?? []).filter((_, k) => k !== i) })), [activeId]);
  useEffect(() => {
    if (!activeId || isRunning(active)) return;
    const [first, ...rest] = queues[activeId] ?? [];
    if (!first) return;
    setQueues(q => ({ ...q, [activeId]: rest }));
    void send(first.text, first.onFinished, first.runInput, first.images?.length || first.step ? { ...(first.images?.length ? { images: first.images } : {}), ...(first.step ? { step: first.step } : {}) } : undefined);
  }, [queues, active, activeId, send]);

  // AI 运行中向操作人提的问题：等回答，回答 / 跳过 / 运行结束后移走
  const [asks, setAsks] = useState<AskRequest[]>([]);
  useEffect(() => api.onAsk(r => setAsks(a => [...a, r])), []);
  const answerAsk = useCallback((id: string, answers: Array<{ id: string; picked: string[]; text?: string }> | null) => {
    setAsks(a => a.filter(x => x.id !== id));
    return api.respondAsk(id, answers);
  }, []);

  return { sessions, active, activeId, setActiveId, provider, workspace, model, disabledTools, setProvider, setModel, setDisabledTools, setWorkspace, newChat, newChatWith, send, abort, remove, asks, answerAsk, queued, enqueue, dequeue };
}

export type ChatStore = ReturnType<typeof useChatStore>;

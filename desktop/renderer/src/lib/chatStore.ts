import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppState, HarnessEvent, Msg } from "../../../shared/api";
import { api } from "../api";

export interface Turn {
  id: string;
  role: "user" | "assistant";
  text: string;
  provider?: string;
  events: HarnessEvent[];
  status?: "running" | "done" | "error" | "aborted";
  traceFile?: string;
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
          ss.map(s => (s.turns.some(t => t.id === key) ? { ...s, turns: s.turns.map(t => (t.id === key ? { ...t, events: [...t.events, event] } : t)) } : s)),
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
    async (text: string, onFinished?: () => void, runInput?: string) => {
      const cur = ref.current.find(s => s.id === activeId);
      if (isRunning(cur)) return;
      const key = uid();
      const sid = cur?.id ?? uid();
      const prov = cur?.provider ?? draftProvider;
      const ws = cur ? cur.workspace : draftWorkspace;
      const mdl = cur ? cur.model : draftModel;
      const off = cur ? (cur.disabledTools ?? []) : draftDisabled;
      const history = cur?.history ?? [];
      const newTurns: Turn[] = [
        { id: uid(), role: "user", text, events: [] },
        { id: key, role: "assistant", text: "", provider: prov, events: [], status: "running" },
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

      const r = await api.run({ runKey: key, input: runInput ?? text, provider: prov, history, workspace: ws, model: mdl, disabledTools: off.length ? off : undefined });
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

  return { sessions, active, activeId, setActiveId, provider, workspace, model, disabledTools, setProvider, setModel, setDisabledTools, setWorkspace, newChat, newChatWith, send, abort, remove };
}

export type ChatStore = ReturnType<typeof useChatStore>;

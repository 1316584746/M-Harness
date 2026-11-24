import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AppState, McpServerDTO, RepoInfo, RepoSyncDTO, StartBranchDTO, WorkChatDTO } from "../../../shared/api";
import { md, startOfDay } from "../../../shared/schedule";
import { api } from "../api";
import { BranchPicker } from "../components/BranchPicker";
import { Icon } from "../components/Icon";
import { Markdown } from "../components/Markdown";
import { ModelPicker } from "../components/ModelPicker";
import { ProviderPicker } from "../components/ProviderPicker";
import { FlowLive, FlowTranscript } from "../components/FlowRun";
import { AdvanceDialog, type AdvanceOptions } from "../components/AdvanceDialog";
import { ContextDialog } from "../components/ContextDialog";
import { GroupDialog } from "../components/GroupDialog";
import { InfoDialog } from "../components/InfoDialog";
import { RunFailure } from "../components/RunLive";
import { AskForm } from "../components/AskCard";
import { QueuedList } from "../components/QueuedList";
import { ImageStrip, MsgImages } from "../components/ImageStrip";
import { useImageAttach } from "../lib/useImageAttach";
import { isRunning, type ChatStore, type StepRef, type Turn } from "../lib/chatStore";
import { blockedSteps, branchNote, visibleSteps } from "../lib/actionSteps";
import { parseCfg } from "../lib/configEdit";
import { buildRunView, fmtMs, fmtTokens } from "../lib/steps";
import { progressDigest } from "../lib/flow";
import { upstreamBlock } from "../lib/upstream";
import { docKind, PHASE_TEXT, taskPhase, taskUrl, type Task, type TaskPhase, type TaskStore } from "../lib/taskStore";

export const SOURCE_TEXT: Record<Task["source"], string> = { feishu: "飞书项目", dingtalk: "钉钉待办", manual: "手动新建" };

/** 第一次打开任务时放进输入框的提示词（用户确认后再发送） */
export const taskPrompt = (t: Pick<Task, "source" | "itemId" | "title">) =>
  t.source === "manual"
    ? `我有一个任务「${t.title}」。我会把需求内容和相关材料发给你，请先帮我理清要做什么，再一起往下推进。`
    : t.source === "feishu"
      ? `我在飞书项目里有一个需求「${t.title}」（工作项 ID：${t.itemId}）。请先用 feishu_project_read 查看它的详情，再告诉我现在该怎么推进，需要我做什么。`
      : `我在钉钉里有一个待办「${t.title}」（任务 ID：${t.itemId}）。请先用 dingtalk_project_read 查看它的详情，再告诉我现在该怎么推进，需要我做什么。`;

const FLOW_DEFAULT = 420;
const FLOW_MIN = 300;
const FLOW_MAX = 760;

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
export function preamble(t: Task, repos: Array<{ name: string; path: string; status?: { branch?: string } }>, larkBound = false): string {
  const rs = t.repos.map(n => repos.find(r => r.name === n)).filter((r): r is NonNullable<typeof r> => !!r);
  const lines = [`【任务】${t.title}`, t.source === "manual" ? `来源：${SOURCE_TEXT.manual}（没有关联项目管理里的工作项）` : `来源：${SOURCE_TEXT[t.source]}，工作项 ID ${t.itemId}${t.node ? `，当前节点 ${t.node}` : ""}`];
  const link = taskUrl(t);
  if (link) lines.push(`需求链接：${link}`);
  if (t.prdUrl?.trim()) lines.push(`PRD 链接：${t.prdUrl.trim()}`);
  if (t.reqId?.trim()) lines.push(`需求编号（REQ-ID）：${t.reqId.trim()}`);
  // 命令直接给全：Agent 以前每次都先 --help 摸索一遍（6~10 次调用、大段输出），白白耗 token
  if (t.source === "feishu" && t.projectKey && /^[\w.-]+$/.test(t.projectKey) && /^\d+$/.test(t.itemId)) {
    lines.push(`读飞书的现成命令（直接用，不要先跑 --help）：\n- 工作项详情：meegle workitem get --project-key ${t.projectKey} --work-item-id ${t.itemId} --fields _all --page-size 200\n- 评论：meegle comment list --project-key ${t.projectKey} --work-item-id ${t.itemId}\n- 飞书文档：lark-cli docs +fetch --doc <文档链接> --doc-format markdown（文档很长时先加 --scope outline 看目录）`);
  }
  if (rs.length) lines.push(`关联仓库（需要看代码 / 改代码时就用这些）：\n${rs.map(r => `- ${r.name}：${r.path}${r.status?.branch ? `（当前分支 ${r.status.branch}）` : ""}`).join("\n")}`);
  if (t.context.trim()) lines.push(`任务上下文：\n${t.context.trim()}`);
  const docs = t.docs ?? [];
  if (docs.length) {
    lines.push(
      `任务上下文文档（链接和本机文件需要时自己去读）：\n${docs
        .map(d => {
          const c = d.content.trim();
          const k = docKind(c);
          return k === "text" ? `- ${d.title}：\n${c.length > 4000 ? c.slice(0, 4000) + "…（已截断）" : c}` : `- ${d.title}（${k === "url" ? "链接" : "本机路径"}）：${c}`;
        })
        .join("\n")}`,
    );
  }
  // 绑定了飞书需求群：给现成的群操作命令（走 M-Harness 自己的机器人），Agent 不用先摸索 --help
  if (larkBound && t.groupId && /^oc_[\w-]+$/.test(t.groupId)) {
    const g = t.groupId;
    const L = "lark-cli --profile m-harness";
    lines.push(
      `飞书需求群（群 ID ${g}）：群主在群里 @ 机器人说的话会进这个对话，你这一轮的回复会自动发回群里，不用再手动发。只有用户明确要你「通知 / @某人 / 查群里聊了什么」时，才用下面的命令（都用 M-Harness 自己的机器人，别换 profile；直接用，不要先跑 --help）：\n- 往群里发消息：${L} im +messages-send --chat-id ${g} --as bot --text "内容"（@人写成 <at user_id="ou_xxx">名字</at>，open_id 先查群成员）\n- 群成员：${L} im +chat-members-list --chat-id ${g} --as bot\n- 群里最近的消息：${L} im +chat-messages-list --chat-id ${g} --as user --order desc --page-size 20 --no-reactions --format json`,
    );
  }
  lines.push("回复里提到需求、文档、网页时，请用 Markdown 链接写成 [标题](完整网址)，界面里才能直接点开；只有标题没有网址的，请在后面补上网址。");
  return lines.join("\n");
}
export const sigOf = (t: Task) => JSON.stringify([t.repos, t.groupId ?? "", t.reqId ?? "", t.context.trim(), (t.docs ?? []).map(d => [d.title, d.content]), ...(t.prdUrl?.trim() ? [t.prdUrl.trim()] : [])]);

type Pop = "info" | "ctx" | "mcp" | "repo" | "group" | null;

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
  // 产物按「步骤」分开放：业务分析、方案设计、进行开发……（自定义动作也一样）各一份，互不覆盖；
  // 同一步骤跑了多次，显示最新一次。只有从「推进任务」点动作发出的轮次才有产物；
  // 自由输入（随口问、追问）没有产物，回复只在右侧事件流里，不会进左边，也不会覆盖任何动作的产物
  // 同名的动作（比如内置「方案设计」和自己建的「方案设计」）算同一份产物：后跑的覆盖前面的，不另开标签
  const stepKey = (r: { user: Turn }) => r.user.step?.name ?? "";
  const stepTabs = useMemo(() => {
    const m = new Map<string, { key: string; label: string; round: (typeof rounds)[number]; count: number }>();
    for (const r of rounds) if (r.user.step) m.set(stepKey(r), { key: stepKey(r), label: r.user.step.name, round: r, count: (m.get(stepKey(r))?.count ?? 0) + 1 });
    return [...m.values()];
  }, [rounds]);
  const [sel, setSel] = useState<number | null>(null);
  const [tabKey, setTabKey] = useState<string | null>(null);
  const selRound = rounds.find(r => r.n === sel && r.user.step);
  // 默认停在最新一个「动作」的产物上；一个动作都没跑过时，左边什么产物都没有
  const lastStep = [...rounds].reverse().find(r => r.user.step);
  const activeKey = selRound ? stepKey(selRound) : (tabKey ?? (lastStep ? stepKey(lastStep) : ""));
  const cur = selRound ?? stepTabs.find(t => t.key === activeKey)?.round ?? lastStep;
  // 发起新一轮时自动切到最新一轮
  const nRounds = rounds.length;
  useEffect(() => (setSel(null), setTabKey(null)), [nRounds, task.id]);
  // ───── 右侧事件流栏：宽度可拖动（记住上次的宽度，双击分隔条恢复默认），输入框高度可拖动 ─────
  const bodyRef = useRef<HTMLDivElement>(null);
  const [flowW, setFlowW] = useState(() => {
    const n = Number(localStorage.getItem("task.flowW"));
    return Number.isFinite(n) && n >= FLOW_MIN ? n : FLOW_DEFAULT;
  });
  const [taH, setTaH] = useState(() => {
    const n = Number(localStorage.getItem("task.inputH"));
    return Number.isFinite(n) && n >= 60 ? Math.min(n, 420) : 96;
  });
  const clampFlow = (w: number) => Math.max(FLOW_MIN, Math.min(w, Math.min(FLOW_MAX, (bodyRef.current?.clientWidth ?? 1200) - 360)));
  const drag = (onMove: (ev: MouseEvent) => void, onEnd: () => void, cursor: string) => {
    const prev = document.body.style.cursor;
    document.body.style.cursor = cursor;
    document.body.style.userSelect = "none";
    const up = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", up);
      document.body.style.cursor = prev;
      document.body.style.userSelect = "";
      onEnd();
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", up);
  };
  // 推拉：full = 右侧铺满（左侧产物区收起），hidden = 右侧收起（左侧铺满），normal = 回到拖动前的宽度
  const [flowMode, setFlowMode] = useState<"normal" | "full" | "hidden">("normal");
  const startFlowResize = (e: React.MouseEvent) => {
    if (flowMode !== "normal") return;
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = flowW;
    let w = w0;
    drag(
      ev => setFlowW((w = clampFlow(w0 + (x0 - ev.clientX)))),
      () => localStorage.setItem("task.flowW", String(w)),
      "col-resize",
    );
  };
  const startInputResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const y0 = e.clientY;
    const h0 = taH;
    let h = h0;
    drag(
      ev => setTaH((h = Math.max(60, Math.min(420, h0 + (y0 - ev.clientY))))),
      () => localStorage.setItem("task.inputH", String(h)),
      "ns-resize",
    );
  };

  // ───── 仓库 / 改动 / MCP ─────
  const [repos, setRepos] = useState<RepoInfo[]>([]);
  const [diff, setDiff] = useState<{ added: number; deleted: number; files: number; base?: string } | null>(null);
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

  // ───── 需求群：自动读这个需求在飞书项目里对应的群 ─────
  const [grp, setGrp] = useState<WorkChatDTO | null>(null);
  const [grpBusy, setGrpBusy] = useState(false);
  const [grpOpen, setGrpOpen] = useState(false);
  const [ctxOpen, setCtxOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [advOpen, setAdvOpen] = useState(false);
  // 推进任务里的「自定义」= 设置 → ACTIONS 里配的动作
  const steps = useMemo(() => visibleSteps(parseCfg(state.configText)), [state.configText]);
  const blocked = useMemo(() => blockedSteps(parseCfg(state.configText), task.repos), [state.configText, reposKey]);
  /** chatId：指定要读的群（刚关联 / 刚创建时用）；null = 用飞书项目里的默认群；不传 = 任务上记着的群，没有就用默认 */
  const loadGroup = useCallback(
    async (chatId?: string | null) => {
      setGrpBusy(true);
      const id = chatId === undefined ? task.groupId : chatId ?? undefined;
      const r = await api.workItemChat({ projectKey: task.projectKey, wid: task.itemId, url: task.url, chatId: id }).catch((e): WorkChatDTO => ({ ok: false, error: e instanceof Error ? e.message : String(e) }));
      setGrp(r);
      setGrpBusy(false);
      return r;
    },
    [task.projectKey, task.itemId, task.url, task.groupId],
  );
  useEffect(() => {
    if (task.source === "feishu" || task.groupId) void loadGroup();
  }, [task.source, loadGroup, task.groupId]);
  const bindGroup = async (ref: string): Promise<string | undefined> => {
    const r = await api.workItemChat({ projectKey: task.projectKey, wid: task.itemId, url: task.url, chatId: ref.trim() });
    if (!r.ok || !r.groupId) return r.error ?? "关联失败";
    tasks.update(task.id, { groupId: r.groupId });
    setGrp(r);
    return undefined;
  };
  const createGroup = async (): Promise<string | undefined> => {
    const r = await api.workItemChatCreate({ name: task.title, description: task.url ? `需求：${task.url}` : undefined });
    if (!r.ok || !r.groupId) return r.error ?? "建群失败";
    tasks.update(task.id, { groupId: r.groupId });
    setGrp(r);
    return undefined;
  };

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
  const pics = useImageAttach();
  const send = (override?: string, o?: { fresh?: boolean; step?: StepRef; extra?: string }) => {
    const { extra, ...opts } = o ?? {};
    const imgs = override === undefined ? pics.images : [];
    const text = (override ?? input).trim() || (imgs.length ? "请看附图。" : "");
    if (!text) return;
    if (override === undefined) {
      setInput("");
      pics.clear();
    }
    const need = turns.length === 0 || task.ctxSent !== sigOf(task) || !!opts.fresh;
    const base = need ? `${preamble(task, repos, state.larkBound)}\n\n${text}` : undefined;
    // extra：只发给 AI、不存进对话记录的附加内容（比如这一步已有的产物）
    const runInput = extra ? `${base ?? text}\n\n${extra}` : base;
    // AI 还在运行：先排队，这一轮结束后自动发
    if (running) chat.enqueue(text, onChanged, runInput, imgs, opts.step);
    else void chat.send(text, onChanged, runInput, { ...opts, ...(imgs.length ? { images: imgs } : {}) });
    tasks.update(task.id, { ctxSent: sigOf(task) });
  };
  /** 推进到下一步。「进行开发」先基于基线分支把开发分支（feature-需求名称-日期）建好、切过去，再让 AI 开工 */
  const advance = async (text: string, o: AdvanceOptions) => {
    // 记下这一轮是哪一步：左边的产物按步骤分开放，点了方案设计，业务分析的产物也还在
    const stepDef = o.stepId ? [...steps.builtins, ...steps.custom].find(a => a.id === o.stepId) : undefined;
    // 这一步之前已经有产物：让 AI 在它的基础上修改，最后仍交一份完整的最新产物，覆盖原来的，不另起一份
    const prevDone = stepDef ? [...rounds].reverse().find(r => r.user.step?.name === stepDef.name && r.ai?.status === "done" && r.ai.text) : undefined;
    const extra = prevDone?.ai?.text
      ? [
          `【这一步已有的产物】「${stepDef!.name}」之前已经产出过一份（见下）。这次是在它的基础上修改：保留仍然正确、已经确认的内容，只改需要变的地方；`,
          "最后仍然输出一份完整的最新产物（它会覆盖原来那份，不会另存一份）。已有内容里能直接用的结论不要重新查。",
          "---",
          prevDone.ai.text.length > 20000 ? prevDone.ai.text.slice(0, 20000) + "\n…（已截断）" : prevDone.ai.text,
          "---",
        ].join("\n")
      : undefined;
    const up = o.stepId && stepDef ? upstreamBlock(rounds, o.stepId, stepDef.name) : undefined;
    // 内置和自定义的步骤都带上：这一步的最后一条回复就是左边的产物，不能只是「已写入飞书」+ 链接
    const deliver = stepDef
      ? `【产物要求】这一步的最后一条回复会原样显示在左边「产物」里给用户审阅。即使你同时把内容写进了飞书文档 / 知识库 / 别的地方，最后一条回复仍然必须是完整的「${stepDef.name}」正文（和写进去的内容一致），不要只回复「已写入…」加链接和几条要点；链接最多在开头用一行带过。`
      : undefined;
    const extraAll = [up, extra, deliver].filter(Boolean).join("\n\n") || undefined;
    const opts = { fresh: o.fresh, ...(extraAll ? { extra: extraAll } : {}), ...(o.stepId && stepDef ? { step: { id: o.stepId, name: stepDef.name } } : {}) };
    if (o.stepId !== "build" || !task.repos.length) return send(text, opts);
    const rs = await api.repoStartBranch(task.repos, task.title).catch((e): StartBranchDTO[] => [{ name: task.repos[0], ok: false, error: e instanceof Error ? e.message : String(e) }]);
    loadRef.current();
    const note = branchNote(rs);
    send(note ? `${text}\n\n${note}` : text, opts);
  };
  /** 失败 / 超时 / 中断后「继续」：沿用刚才的问题（同一步骤），并把上次已经读过、搜过、做过的事带上，新开的 Agent 接着做 */
  const lastRound = rounds.at(-1);
  const retry = (r: (typeof rounds)[number]) => {
    if (running || !r.ai) return;
    const why = short((r.ai.text ?? "").split("\n")[0] || "没有跑完", 60);
    const digest = progressDigest(r.ai.events, r.ai.times?.length === r.ai.events.length ? r.ai.times : undefined);
    const note = [
      `【续跑】上一次运行没有跑完（${why}）。上面是同一个问题，请接着做，不要从头开始。`,
      "下面是上次已经做过的事：已读过的文件不要重复读，直接用你记得的结论往下做，只补读还缺的部分。",
      "如果这一步内容很多、一个人做不完，先把要查的点拆成几个互相独立的小问题，用 researcher 子代理同时去查，都回来以后再汇总写产物。",
      "",
      digest || "（上次没有留下可用的进度，只能重新开始，但请更快地定位，不要整仓遍历。）",
    ].join("\n");
    const up = r.user.step ? upstreamBlock(rounds, r.user.step.id, r.user.step.name) : undefined;
    void chat.send(r.user.text, onChanged, `${preamble(task, repos, state.larkBound)}\n\n${r.user.text}${up ? `\n\n${up}` : ""}\n\n${note}`, { ...(r.user.images?.length ? { images: r.user.images } : {}), ...(r.user.step ? { step: r.user.step } : {}) });
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

  const view = useMemo(() => (cur?.ai ? buildRunView(cur.ai.events, cur.ai.times?.length === cur.ai.events.length ? cur.ai.times : undefined) : null), [cur?.ai?.events, cur?.ai?.times]);
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
        <button className="btn sm primary" data-testid="task-advance-top" title="推进任务：选下一步（业务分析 / 方案设计 / 进行开发 / 代码CR / 联调 / 提测 / 你配置的动作）" onClick={() => setAdvOpen(true)} disabled={!!info?.problem}>
          <Icon name="spark" size={14} /> 推进
        </button>
        <button className="btn sm" data-testid="task-done" onClick={() => tasks.update(task.id, { done: !task.done })}>
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
                r.status.exists && r.status.branch && <BranchPicker dir={r.path} compact down initial={r.status.branch} refreshKey={`${r.status.branch}:${r.status.changed}`} onSwitched={() => loadRef.current()} />
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

        {/* 同步成功不再提示（分支名就在标签上）；只有出错、或者暂存了你的未提交改动（要告诉你去哪恢复）才显示 */}
        {picked.some(r => syncRes[r.name] && (syncRes[r.name].error || syncRes[r.name].stashed)) && (
          <div className="repo-notes" data-testid="task-repo-notes">
            {picked.map(r => {
              const s = syncRes[r.name];
              if (!s || !(s.error || s.stashed)) return null;
              const text = s.error ? `${r.name}：${s.error}` : `${r.name}：${s.skipped ?? `已暂存 ${s.stashed} 个未提交文件（git stash）`}`;
              return (
                <span key={r.name} className={`repo-note ${s.error ? "bad" : "warn"}`}>
                  <span className="repo-note-text" title={text}>
                    {text}
                  </span>
                  <button
                    className="repo-note-x"
                    data-testid="repo-note-close"
                    title="关闭这条提示"
                    aria-label="关闭这条提示"
                    onClick={() => setSyncRes(m => Object.fromEntries(Object.entries(m).filter(([k]) => k !== r.name)))}
                  >
                    ×
                  </button>
                </span>
              );
            })}
          </div>
        )}

        <div className="task-acts">
          <button className={`act-chip ${infoOpen ? "on" : ""}`} data-testid="task-info-btn" onClick={() => setInfoOpen(true)}>
            <Icon name="info" size={13} /> 基本信息
          </button>
          <button className={`act-chip ${ctxOpen ? "on" : ""}`} data-testid="task-ctx-btn" onClick={() => setCtxOpen(true)}>
            <Icon name="file" size={13} /> 任务上下文 <span className="num">{(task.docs?.length ?? 0) + (task.context.trim() ? 1 : 0)}</span>
          </button>
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
          <span className="act-chip static" data-testid="task-diff" title={diff ? `${diff.files} 个文件有改动（${diff.base ? `相对基线分支 ${diff.base}，含已提交的` : "未提交的改动，相对 HEAD"}）` : "关联仓库后统计改动"}>
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
          {(task.source === "feishu" || task.groupId) && (
            <button className={`act-chip ${grpOpen ? "on" : ""}`} data-testid="task-group-btn" onClick={() => setGrpOpen(true)} title={grp?.groupId ? `需求群：${grp.name ?? grp.groupId}` : "需求对应的飞书群"}>
              <Icon name="chat" size={13} /> 需求群
              {grpBusy && !grp ? <span className="num">…</span> : grp?.groupId ? <span className="dot ready" /> : null}
            </button>
          )}
        </div>
      </div>

      {advOpen && <AdvanceDialog builtins={steps.builtins} actions={steps.custom} blocked={blocked} hasHistory={turns.length > 0} agent={<><ProviderPicker providers={state.providers} value={provider} onChange={chat.setProvider} disabled={running} /><ModelPicker provider={provider} info={info} value={chat.model} onChange={chat.setModel} disabled={running} /></>} vars={{ taskTitle: task.title, taskId: task.id, repoPath: picked.find(r => r.path)?.path ?? "未关联仓库" }} onClose={() => setAdvOpen(false)} onAdvance={(t, o) => void advance(t, o)} />}
      {infoOpen && <InfoDialog task={task} repos={repos} sourceText={SOURCE_TEXT[task.source]} schedule={range(task)} onClose={() => setInfoOpen(false)} onSave={patch => tasks.update(task.id, patch)} onRepos={setTaskRepos} />}
      {ctxOpen && <ContextDialog task={task} onClose={() => setCtxOpen(false)} onChange={patch => tasks.update(task.id, patch)} />}
      {grpOpen && (
        <GroupDialog
          task={task}
          grp={grp}
          busy={grpBusy}
          onClose={() => setGrpOpen(false)}
          onReload={() => void loadGroup()}
          onBind={bindGroup}
          onCreate={createGroup}
          onUnbind={() => (tasks.update(task.id, { groupId: undefined }), void loadGroup(null))}
          onReply={r => tasks.update(task.id, { groupReply: r })}
        />
      )}

      <div className="task-body" ref={bodyRef} data-flow={flowMode} data-testid="task-body" style={{ ["--flow-w" as string]: `${flowW}px` }}>
        <div className="task-main">
          {cur ? (
            <>
              {stepTabs.length > 0 && (
                <div className="out-tabs out-steps" data-testid="out-steps">
                  {stepTabs.map(t => (
                    <button key={t.key} type="button" className={`out-tab${t.key === activeKey ? " on" : ""}`} data-testid="out-step" data-step={t.round.user.step?.id ?? t.key} title={t.count > 1 ? `跑了 ${t.count} 次，这里是最新一次` : undefined} onClick={() => (setSel(null), setTabKey(t.key))}>
                      {t.round.ai?.status === "running" ? <span className="spinner" /> : <span className={`dot ${t.round.ai?.status === "done" ? "ready" : t.round.ai?.status ? "error" : ""}`} />}
                      {t.label}
                      {t.count > 1 && <em>×{t.count}</em>}
                    </button>
                  ))}
                </div>
              )}
              <div className="out-tabs">
                <span className="out-title">
                  <Icon name="file" size={13} /> 产物
                  <em>#{cur.n}</em>
                </span>
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
              {/* 左边只放阶段产物（比如方案设计生成后的内容）；思考、工具调用这些过程在右侧事件流里 */}
              <div className="out-body" data-testid="out-body">
                {cur.ai?.status === "running" && (() => {
                  const ask = chat.asks.find(a => a.runKey === cur.ai!.id);
                  return ask ? <AskForm key={ask.id} req={ask} onSubmit={a => void chat.answerAsk(ask.id, a)} /> : null;
                })()}
                {cur.ai && (cur.ai.status === "error" || cur.ai.status === "aborted") ? (
                  <RunFailure text={cur.ai.text ?? ""} aborted={cur.ai.status === "aborted"} onRetry={!running && cur.n === lastRound?.n ? () => retry(cur) : undefined} />
                ) : cur.ai?.text ? (
                  <Markdown text={cur.ai.text} />
                ) : cur.ai?.status === "running" ? null : (
                  <div className="out-empty">这一轮还没有产出</div>
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
                点上方「推进任务」选一步（业务分析、方案设计……），那一步的产物会放在这里；右侧自由对话只在事件流里回复，不会生成产物。
              </p>
            </div>
          )}
        </div>

        <div
          className="task-resizer"
          data-testid="task-resizer"
          role="separator"
          aria-orientation="vertical"
          title={flowMode === "normal" ? "拖动调整右侧宽度，双击恢复默认" : "点击中间的箭头恢复"}
          onMouseDown={startFlowResize}
          onDoubleClick={() => {
            setFlowMode("normal");
            setFlowW(FLOW_DEFAULT);
            localStorage.removeItem("task.flowW");
          }}
        >
          <div className="rz-grip" onMouseDown={e => e.stopPropagation()} onDoubleClick={e => e.stopPropagation()}>
            <button
              type="button"
              className="rz-btn rz-left"
              data-testid="flow-expand"
              title={flowMode === "hidden" ? "恢复" : "右侧铺满"}
              onClick={() => setFlowMode(flowMode === "hidden" ? "normal" : "full")}
              disabled={flowMode === "full"}
            >
              <Icon name="right" size={14} />
            </button>
            <button
              type="button"
              className="rz-btn rz-right"
              data-testid="flow-collapse"
              title={flowMode === "full" ? "恢复" : "收起右侧（左侧铺满）"}
              onClick={() => setFlowMode(flowMode === "full" ? "normal" : "hidden")}
              disabled={flowMode === "hidden"}
            >
              <Icon name="right" size={14} />
            </button>
          </div>
        </div>
        <aside className="task-flow">
          <div className="flow-head">
            <b>事件流</b>
            <span className="muted">{rounds.length} 轮</span>
          </div>
          <div className="flow-list" ref={flow} data-testid="task-flow">
            {!rounds.length && <div className="flow-empty">还没有事件，发出第一条指令后会记录在这里</div>}
            {rounds.map(r => {
              const v = r.ai ? buildRunView(r.ai.events, r.ai.times?.length === r.ai.events.length ? r.ai.times : undefined) : null;
              const st = r.ai?.status;
              return (
                <div key={r.n} className="flow-round" data-testid="flow-round">
                  <div
                    className={`flow-user${r.user.step && cur?.n === r.n ? " cur" : ""}`}
                    style={r.user.step ? { cursor: "pointer" } : undefined}
                    title={r.user.step ? "点一下，左边产物区看这一轮的结果" : undefined}
                    onClick={r.user.step ? () => (setSel(r.n), setTabKey(null)) : undefined}
                  >
                    <span className="flow-who">我</span>
                    {r.user.step && <span className="flow-step">{r.user.step.name}</span>}
                    {r.user.step
                      ? (() => {
                          // 动作发出去的是一大段提示词，事件流里不贴原文，只写做什么；上一轮没跑完又原样发一次的就是「继续」
                          const prev = rounds[r.n - 2];
                          const again = !!prev && prev.user.step?.id === r.user.step!.id && prev.user.text === r.user.text && prev.ai?.status !== "done";
                          return `${again ? "继续" : "执行"}「${r.user.step!.name}」`;
                        })()
                      : short(r.user.text, 160)}
                    {r.ai?.startedAt ? <em className="flow-at">#{r.n} · {new Date(r.ai.startedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false })}</em> : null}
                    <MsgImages images={r.user.images} />
                  </div>
                  {r.ai && (
                    <div className="flow-proc" data-testid="flow-proc">
                      <FlowTranscript events={r.ai.events} times={r.ai.times?.length === r.ai.events.length ? r.ai.times : undefined} startedAt={r.ai.startedAt} running={st === "running"} brief={!!r.user.step} />
                      {(st === "error" || st === "aborted") && <RunFailure text={r.ai.text ?? ""} aborted={st === "aborted"} onRetry={!running && r.n === lastRound?.n ? () => retry(r) : undefined} />}
                    </div>
                  )}
                  {r.ai && st === "running" && !r.user.step && (() => {
                    // 自由对话中 AI 要问的问题：左边没有产物区，就在这一轮下面作答
                    const ask = chat.asks.find(a => a.runKey === r.ai!.id);
                    return ask ? <AskForm key={ask.id} req={ask} onSubmit={a => void chat.answerAsk(ask.id, a)} /> : null;
                  })()}
                  {r.ai && (
                    <div className={`flow-ai ${st}`} data-testid="flow-ai">
                      {st === "running" ? (
                        <FlowLive events={r.ai.events} times={r.ai.times?.length === r.ai.events.length ? r.ai.times : undefined} startedAt={r.ai.startedAt} />
                      ) : (
                        <>
                          <span className={`dot ${st === "done" ? "ready" : "error"}`} />
                          <span className="flow-ai-main">
                            <b>
                              #{r.n} {st === "done" ? (r.user.step ? "已完成，产出已更新" : "已回复") : st === "aborted" ? "已中断" : "失败"}
                            </b>
                            {v && v.totalMs ? <em>{fmtMs(v.totalMs)}</em> : null}
                            {r.ai.tokens ? <em title="这一轮用掉的 token 总数（输入 + 输出 + 缓存）">{fmtTokens(r.ai.tokens)} tokens</em> : null}
                          </span>
                        </>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="flow-composer">
            {info?.problem && <div className="inline-warn">{info.problem}</div>}
            <QueuedList items={chat.queued} onCancel={chat.dequeue} />
            <div className="composer" data-testid="task-composer">
              <div className="composer-grip" data-testid="task-input-grip" title="拖动调整输入框高度" onMouseDown={startInputResize} />
              <ImageStrip images={pics.images} error={pics.error} onRemove={pics.remove} />
              <textarea
                ref={area}
                data-testid="task-input"
                rows={2}
                style={{ height: taH }}
                value={input}
                placeholder={running ? "运行中…回车排队，这一轮结束后自动发送；也可点右下角停止" : "想改、想问、拖入文件引用路径，也可以直接粘贴图片（Enter 发送，Shift+Enter 换行）"}
                onChange={e => setInput(e.target.value)}
                onPaste={pics.onPaste}
                onKeyDown={e => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              {/* 左边是模型选择（栏窄时自己换行），右边是操作按钮（永远在、不会被挤出去） */}
              <div className="composer-row flow-row">
                <div className="row-pickers">
                  <ProviderPicker providers={state.providers} value={provider} onChange={chat.setProvider} disabled={running} />
                  <ModelPicker provider={provider} info={info} value={chat.model} onChange={chat.setModel} disabled={running} />
                </div>
                <div className="row-actions">
                  <button type="button" className="icon-btn" data-testid="task-advance-btn" title="推进任务：选下一步（业务分析 / 方案设计 / 进行开发 / 代码CR / 你配置的动作）" onClick={() => setAdvOpen(true)} disabled={!!info?.problem}>
                    <Icon name="spark" size={20} />
                  </button>
                  <button type="button" className="icon-btn" title="添加文件（插入路径）" onClick={() => void attach("file")} disabled={running}>
                    <Icon name="file" size={20} />
                  </button>
                  <button type="button" className="icon-btn" title="添加文件夹（插入路径）" onClick={() => void attach("folder")} disabled={running}>
                    <Icon name="folder" size={20} />
                  </button>
                  {running ? (
                    <button className="send stop" data-testid="task-stop" title="停止" onClick={() => session && chat.abort(session.id)}>
                      <Icon name="stop" size={19} />
                    </button>
                  ) : (
                    <button className="send" data-testid="task-send" title="发送" onClick={() => send()} disabled={(!input.trim() && !pics.images.length) || !!info?.problem}>
                      <Icon name="send" size={20} strokeWidth={2.2} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}

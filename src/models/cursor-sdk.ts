import type { AgentBackend, Asker } from "../core/types";
import { ASK_USER_DESCRIPTION, ASK_USER_JSON_SCHEMA, askOperator } from "../tools/ask-user";
import fs from "node:fs";
import path from "node:path";
import { loadImages } from "./images";

export interface CursorSdkOptions {
  id: string;
  apiKey: string;
  /** 会话存档文件（任务 → Agent id）。不给就取环境变量 HARNESS_SESSIONS_FILE；都没有则只在本次运行内记住 */
  sessionFile?: string;
  /** Cursor 模型 id，如 composer-2 */
  model?: string;
}

/**
 * 大任务让主 Agent 拆开，交给只读的调研子代理并行去查，自己只汇总、写产物。
 * 子代理各自有独立上下文，查完只回精简结论，主 Agent 的上下文不会被几十个文件撑爆，也不会一个人串行跑到超时。
 */
/** 会话 → Cursor Agent id：内存里一份，另外落盘一份（有 sessionFile 时），软件重启后也能 resume 接回同一个 Agent */
const SESSIONS = new Map<string, string>();
/** 落盘的会话超过这么久没用就不再接回（Cursor 那边的存档也会过期） */
const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;

type Stored = Record<string, { id: string; at: number }>;

function readStore(file: string): Stored {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

function writeStore(file: string, s: Stored): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(s), "utf8");
    fs.renameSync(tmp, file); // 先写临时文件再改名：写到一半断电不会把存档写坏
  } catch {
    /* 存档失败只是下次接不回，不影响这一轮 */
  }
}

/** 取会话对应的 Agent id：先看内存，再看落盘的（过期的忽略） */
export function sessionGet(key: string, file?: string): string | undefined {
  const m = SESSIONS.get(key);
  if (m) return m;
  const e = file ? readStore(file)[key] : undefined;
  return e && typeof e.id === "string" && Date.now() - e.at < SESSION_TTL_MS ? e.id : undefined;
}

export function sessionSet(key: string, id: string, file?: string): void {
  SESSIONS.set(key, id);
  if (!file) return;
  const s = readStore(file);
  const now = Date.now();
  for (const k of Object.keys(s)) if (now - (s[k]?.at ?? 0) >= SESSION_TTL_MS) delete s[k]; // 顺手清掉过期的
  s[key] = { id, at: now };
  writeStore(file, s);
}

export function sessionDel(key: string, file?: string): void {
  SESSIONS.delete(key);
  if (!file) return;
  const s = readStore(file);
  if (key in s) {
    delete s[key];
    writeStore(file, s);
  }
}

/** 只清内存缓存（测试用：模拟软件重启） */
export function sessionsResetMemory(): void {
  SESSIONS.clear();
}

/** 给 Cursor Agent 的 ask_user 自定义工具：把它的提问转给操作人，等回答后返回（和自带 loop 的 ask_user 同一个通道、同一份回答格式） */
export function cursorAskTool(ask: Asker, signal: AbortSignal) {
  return {
    description: ASK_USER_DESCRIPTION,
    inputSchema: ASK_USER_JSON_SCHEMA as unknown as Record<string, unknown>,
    execute: async (args: Record<string, unknown>): Promise<string> => {
      const raw = Array.isArray(args?.["questions"]) ? (args["questions"] as unknown[]) : [];
      const questions = raw
        .filter((q): q is Record<string, unknown> => !!q && typeof q === "object" && typeof (q as any).question === "string" && !!(q as any).question.trim())
        .map(q => ({
          question: String(q["question"]),
          ...(Array.isArray(q["options"]) ? { options: (q["options"] as unknown[]).filter((x): x is string => typeof x === "string") } : {}),
          ...(q["multiple"] === true ? { multiple: true } : {}),
          ...(q["allow_text"] === false ? { allow_text: false } : {}),
        }));
      if (!questions.length) return JSON.stringify({ answered: false, note: "questions 为空或格式不对，没有向操作人提问。请带上至少一个问题再调用。" });
      return askOperator(questions, ask, signal);
    },
  };
}

/** 自动重连：最多几次、每次等多久（毫秒） */
export const RECONNECT_DELAYS = [2000, 4000, 8000];

/** 判断一次失败是不是「连接 / 服务端临时问题」：这类值得原地重连续跑，别的（鉴权、额度、参数错误）重试也没用 */
export function isRetryable(msg: unknown): boolean {
  const s = typeof msg === "string" ? msg : msg instanceof Error ? msg.message : "";
  if (!s || /已中断|abort|cancel/i.test(s)) return false;
  return /network|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang|fetch failed|deadline|time(d)? ?out|unavailable|\b50[234]\b|repeated resume attempts|no progress|stream (closed|ended)|disconnect|connection (reset|closed|lost)/i.test(s);
}

/** 重连后发给同一个 Agent 的话：它自己记得做到哪了，只需要告诉它「刚才断了、接着干」 */
export const RECONNECT_PROMPT = "（系统消息：刚才连接中断，你上一轮被打断了。请从中断的地方继续——已经完成的不用重做、已经说过的不用重复，接着往下做完。）";

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

export const SUBAGENTS: Record<string, { description: string; prompt: string; model: "inherit" }> = {
  researcher: {
    description: "只读调研：在指定仓库 / 目录里查某一个具体问题（某个模块怎么实现、某类脚本怎么写、某个接口被谁调用），返回带 path:line 的精简结论。可以同时派多个，各查各的。",
    prompt: [
      "你是只读调研子代理，只回答主 Agent 交给你的那一个具体问题。",
      "- 只读：不改文件、不跑会改文件的命令、不提交、不推送。",
      "- 先 grep / 按文件名定位，再只读相关片段；能一次并行发出的读取就一次发出；同一文件不重复读。",
      "- 查到够回答问题就停，不要扩大范围。",
      "- 最后只回一份精简结论：每条结论带 `仓库/路径:行号` 出处；查不到的明确写「没找到」，不要编。不要贴大段源码，最多引用几行关键代码。",
    ].join("\n"),
    model: "inherit",
  },
};

/**
 * Cursor SDK（@cursor/sdk）后端：创建本地 Agent，在任务工作目录里执行，并把过程流式回传。
 * 注意：Cursor Agent 用的是它自己的文件/终端工具，运行在宿主机上，不受本 harness 的路径沙箱约束。
 * 包为可选依赖，只有用到时才动态加载。
 */
export function cursorSdk(o: CursorSdkOptions): AgentBackend {
  return {
    id: o.id,
    async run({ prompt, resumePrompt, sessionKey, freshSession, toolBudget, images, cwd, signal, onProgress, ask, hostTools }) {
      const pkg = "@cursor/sdk";
      let mod: any;
      try {
        mod = await import(/* @vite-ignore */ pkg);
      } catch {
        throw new Error("未安装 @cursor/sdk，请先执行 npm i @cursor/sdk（需要 Node >= 22.13）");
      }
      // settingSources: []：不加载本机 Cursor 里的用户 / 团队规则、技能、hooks（比如「多调度 subagents」「必须调用 xxx」这类账号级规则）。
      // 它们会让 Agent 多走很多步、多花 token；项目规则文件需要时由提示词让它自己去读。
      // 有人可以回答（桌面端的对话）时，给 Agent 挂 ask_user（SDK 的 customTools，在本进程里执行、不需要它再申请批准）：
      // 遇到要用户拍板的事让它先问，而不是自己挑一个做；飞书群、命令行这类没人在电脑前的场景不挂
      const agentOpts = { apiKey: o.apiKey, model: { id: o.model ?? "composer-2" }, local: { cwd, settingSources: [], ...(ask || hostTools ? { customTools: { ...(ask ? { ask_user: cursorAskTool(ask, signal) } : {}), ...(hostTools ?? {}) } } : {}) }, agents: SUBAGENTS };
      // 同一个任务的后续步骤续接同一个 Agent：它记得读过的文件和做过的事，不用每一步从头探索
      const keyId = sessionKey ? `${sessionKey}|${o.model ?? ""}|${cwd}` : undefined;
      const file = o.sessionFile ?? (process.env["HARNESS_SESSIONS_FILE"] || undefined);
      if (keyId && freshSession) sessionDel(keyId, file);
      const known = keyId ? sessionGet(keyId, file) : undefined;
      let agent: any;
      let resumed = false;
      if (known) {
        onProgress?.("沿用上一轮的 Cursor 会话（它记得读过的文件）…", "status");
        try {
          agent = await mod.Agent.resume(known, agentOpts);
          resumed = true;
        } catch {
          sessionDel(keyId!, file); // 旧会话找不到了（过期 / 被清理）：新开一个
        }
      }
      if (!agent) {
        onProgress?.(`正在创建 Cursor Agent（模型 ${o.model ?? "composer-2"}）…`, "status");
        agent = await mod.Agent.create(agentOpts);
      }
      if (keyId && agent.agentId) sessionSet(keyId, String(agent.agentId), file);
      onProgress?.("已创建，正在提交任务…", "status");
      // 中断监听要在 send 之前就挂上：创建 / 提交任务期间点停止，不能等到 run 出来才响应
      let run: any;
      const onAbort = () => void run?.cancel?.();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (signal.aborted) throw new Error("已中断");
        const pics = loadImages(images);
        // 带图片时用 SDK 的多模态消息；图片路径也在 prompt 里，agent 想用文件工具再读也行
        const msg = (text: string) => (pics.length ? { text, images: pics.map(i => ({ data: i.data, mimeType: i.mime })) } : text);
        try {
          run = await agent.send(msg(resumed ? resumePrompt ?? prompt : prompt));
        } catch (e) {
          // 续接的旧会话发不出去：丢掉它，新开一个、带完整提示再发一次
          if (!resumed || signal.aborted) throw e;
          try {
            agent.close();
          } catch {
            /* 关不掉也无所谓 */
          }
          onProgress?.("旧会话不可用，新开一个 Cursor Agent…", "status");
          agent = await mod.Agent.create(agentOpts);
          if (keyId && agent.agentId) sessionSet(keyId, String(agent.agentId), file);
          run = await agent.send(msg(prompt));
        }
        if (signal.aborted) onAbort(); // send 返回前已经被中断：补一次取消
        onProgress?.("任务已提交，等待 Cursor 开始处理…", "status");
        try {
          const seen = new Set<string>();
          const budget = toolBudget && toolBudget > 0 ? toolBudget : 0;
          const calls = new Set<string>();
          let cut = false;
          const consume = async (cur: any, limit: number) => {
            for await (const m of cur.stream()) {
              for (const [line, kind] of describeMessage(m, seen)) onProgress?.(line, kind);
              newToolCalls(m, calls);
              if (limit && !cut && calls.size >= limit) {
                // 探索预算用完：叫停这一轮，下面让同一个 Agent 直接收尾
                cut = true;
                onProgress?.(`已调用 ${calls.size} 次工具，到本步的探索上限，让它直接写结论…`, "status");
                void cur.cancel?.();
              }
            }
            return cur.wait();
          };
          // 自动重连（借鉴 Flowship）：连接 / 服务端临时问题导致这一轮中断时，resume 同一个 Agent，
          // 告诉它「刚才断了、接着干」，而不是把错误直接甩给用户；最多 RECONNECT_DELAYS.length 次，每次等久一点
          let attempt = 0;
          const reconnect = async () => {
            for (;;) {
              attempt++;
              onProgress?.(`连接中断、正在自动重连（第 ${attempt}/${RECONNECT_DELAYS.length} 次）…`, "status");
              await sleep(RECONNECT_DELAYS[attempt - 1] ?? 8000, signal);
              if (signal.aborted) throw new Error("已中断");
              const id = String(agent.agentId);
              try {
                try {
                  agent.close();
                } catch {
                  /* 关不掉也无所谓 */
                }
                agent = await mod.Agent.resume(id, agentOpts);
                run = await agent.send(RECONNECT_PROMPT);
                onProgress?.("重连成功，Agent 接着做", "status");
                return;
              } catch (e) {
                if (signal.aborted || attempt >= RECONNECT_DELAYS.length || !isRetryable(e)) throw e;
              }
            }
          };
          let r: any;
          for (;;) {
            let err: unknown;
            let thrown = false;
            try {
              r = await consume(run, budget);
              if (r.status === "error" && isRetryable(r.error?.message)) err = new Error(r.error?.message);
            } catch (e) {
              err = e ?? new Error("未知错误");
              thrown = true;
            }
            if (err === undefined) break;
            if (signal.aborted || cut || attempt >= RECONNECT_DELAYS.length || !isRetryable(err)) {
              if (thrown) throw err;
              break; // 不再重试：交给下面按 r.status 报原来的错
            }
            await reconnect();
          }
          if (cut && !signal.aborted) {
            const first = toUsage(r.usage)?.total ?? 0;
            run = await agent.send(wrapUpPrompt(calls.size));
            r = await consume(run, 0);
            if (signal.aborted) throw new Error("已中断");
            if (r.status !== "finished") throw new Error(r.error?.message ?? `Cursor run ${r.status}`);
            const second = toUsage(r.usage)?.total ?? 0;
            return { text: r.result ?? "", usage: first + second ? { input: 0, output: 0, total: first + second } : undefined };
          }
          if (signal.aborted) throw new Error("已中断");
          if (r.status !== "finished") throw new Error(r.error?.message ?? `Cursor run ${r.status}`);
          return { text: r.result ?? "", usage: toUsage(r.usage) };
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      } finally {
        signal.removeEventListener("abort", onAbort);
        agent.close();
      }
    },
  };
}

const clip = (v: unknown, n: number): string => {
  let s: string;
  try {
    s = typeof v === "string" ? v : JSON.stringify(v) ?? "";
  } catch {
    s = String(v);
  }
  s = s.replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, n) + "…" : s;
};

const STATUS_TEXT: Record<string, string> = {
  CREATING: "Cursor 正在创建运行环境…",
  RUNNING: "Cursor 已开始运行",
  FINISHED: "Cursor 运行结束",
  ERROR: "Cursor 运行出错",
  CANCELLED: "Cursor 运行已取消",
  EXPIRED: "Cursor 运行已过期",
};

/** 把 Cursor SDK 流里的一条消息翻译成界面能展示的过程行（思考 / 回复 / 工具 / 状态 / 错误） */
export function describeMessage(m: any, seen?: Set<string>): Array<[string, "thinking" | "text" | "tool" | "status" | "error"]> {
  const out: Array<[string, "thinking" | "text" | "tool" | "status" | "error"]> = [];
  switch (m?.type) {
    case "thinking":
      if (typeof m.text === "string" && m.text.trim()) out.push([m.text, "thinking"]);
      break;
    case "assistant":
      for (const b of m.message?.content ?? []) {
        if (b.type === "text" && b.text?.trim()) out.push([b.text, "text"]);
        else if (b.type === "tool_use") {
          if (typeof b.id === "string") seen?.add(b.id);
          out.push([`🔧 ${b.name} ${clip(b.input, 400)}`, "tool"]);
        }
      }
      break;
    case "tool_call": {
      // 工具调用有 running / completed 两次消息，参数在其中（有的只来 completed）：
      // 先发一行「🔧 名字 参数」，界面才知道这一步在做什么（读哪个文件、搜什么、跑什么命令）；已经发过就不重复
      const id = typeof m.call_id === "string" ? m.call_id : undefined;
      const started = id ? seen?.has(id) : false;
      if (!started || m.status === "running") {
        if (id) seen?.add(id);
        if (!started && (m.status === "running" || m.args !== undefined)) out.push([`🔧 ${m.name} ${m.args !== undefined ? clip(m.args, 400) : ""}`.trimEnd(), "tool"]);
      }
      if (m.status === "completed") out.push([`   ✓ ${m.name}${m.result !== undefined ? ` → ${clip(m.result, 600)}` : ""}`, "tool"]);
      else if (m.status === "error") out.push([`   ✗ ${m.name} 失败${m.result !== undefined ? `：${clip(m.result, 400)}` : ""}`, "error"]);
      break;
    }
    case "status": {
      const base = STATUS_TEXT[m.status] ?? `状态：${m.status}`;
      const failed = m.status === "ERROR" || m.status === "EXPIRED";
      out.push([m.message ? `${base}：${m.message}` : base, failed ? "error" : "status"]);
      break;
    }
    case "task":
      if (m.text?.trim()) out.push([m.text, "status"]);
      break;
    case "summary":
      if (m.status === "running") out.push(["Cursor 正在压缩对话上下文…", "status"]);
      else if (m.status === "error") out.push(["Cursor 压缩上下文失败（对话保持原样）", "error"]);
      break;
  }
  return out;
}

/**
 * 统计流里新出现的工具调用（按 id 去重，同一次调用的 running / completed 只算一次），记进 calls。
 * 返回这条消息新增了几次。
 */
export function newToolCalls(m: any, calls: Set<string>): number {
  let n = 0;
  const add = (id: unknown) => {
    if (typeof id !== "string" || !id || calls.has(id)) return;
    calls.add(id);
    n++;
  };
  if (m?.type === "tool_call") add(m.call_id);
  else if (m?.type === "assistant") for (const b of m.message?.content ?? []) if (b?.type === "tool_use") add(b.id);
  return n;
}

/** 到探索上限后发给同一个 Agent 的收尾指令（它已经记得读过的内容） */
export function wrapUpPrompt(used: number): string {
  return `【探索预算已用完】你这一步已经调用了 ${used} 次工具，不能再调用任何工具了。现在只基于已经读到的内容，直接写出这一步完整的产物（按要求的格式）。没查清的细节写进「待确认」，并明说是假设；不要说「我再查一下」。`;
}

function toUsage(u: any) {
  if (!u || typeof u !== "object") return undefined;
  const nums = Object.values(u).filter((v): v is number => typeof v === "number");
  const total = nums.reduce((a, b) => a + b, 0);
  return total ? { input: 0, output: 0, total } : undefined;
}

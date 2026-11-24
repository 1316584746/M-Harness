import type { AgentBackend } from "../core/types";
import { loadImages } from "./images";

export interface CursorSdkOptions {
  id: string;
  apiKey: string;
  /** Cursor 模型 id，如 composer-2 */
  model?: string;
}

/**
 * 大任务让主 Agent 拆开，交给只读的调研子代理并行去查，自己只汇总、写产物。
 * 子代理各自有独立上下文，查完只回精简结论，主 Agent 的上下文不会被几十个文件撑爆，也不会一个人串行跑到超时。
 */
/** 会话 → Cursor Agent id（只在本次软件运行期间有效；重启后第一步会新开） */
const SESSIONS = new Map<string, string>();

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
    async run({ prompt, resumePrompt, sessionKey, freshSession, toolBudget, images, cwd, signal, onProgress }) {
      const pkg = "@cursor/sdk";
      let mod: any;
      try {
        mod = await import(/* @vite-ignore */ pkg);
      } catch {
        throw new Error("未安装 @cursor/sdk，请先执行 npm i @cursor/sdk（需要 Node >= 22.13）");
      }
      // settingSources: []：不加载本机 Cursor 里的用户 / 团队规则、技能、hooks（比如「多调度 subagents」「必须调用 xxx」这类账号级规则）。
      // 它们会让 Agent 多走很多步、多花 token；项目规则文件需要时由提示词让它自己去读。
      const agentOpts = { apiKey: o.apiKey, model: { id: o.model ?? "composer-2" }, local: { cwd, settingSources: [] }, agents: SUBAGENTS };
      // 同一个任务的后续步骤续接同一个 Agent：它记得读过的文件和做过的事，不用每一步从头探索
      const keyId = sessionKey ? `${sessionKey}|${o.model ?? ""}|${cwd}` : undefined;
      if (keyId && freshSession) SESSIONS.delete(keyId);
      const known = keyId ? SESSIONS.get(keyId) : undefined;
      let agent: any;
      let resumed = false;
      if (known) {
        onProgress?.("沿用上一轮的 Cursor 会话（它记得读过的文件）…", "status");
        try {
          agent = await mod.Agent.resume(known, agentOpts);
          resumed = true;
        } catch {
          SESSIONS.delete(keyId!); // 旧会话找不到了（过期 / 被清理）：新开一个
        }
      }
      if (!agent) {
        onProgress?.(`正在创建 Cursor Agent（模型 ${o.model ?? "composer-2"}）…`, "status");
        agent = await mod.Agent.create(agentOpts);
      }
      if (keyId && agent.agentId) SESSIONS.set(keyId, String(agent.agentId));
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
          if (keyId && agent.agentId) SESSIONS.set(keyId, String(agent.agentId));
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
          let r = await consume(run, budget);
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

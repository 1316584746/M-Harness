import type { AgentBackend } from "../core/types";

export interface CursorSdkOptions {
  id: string;
  apiKey: string;
  /** Cursor 模型 id，如 composer-2 */
  model?: string;
}

/**
 * Cursor SDK（@cursor/sdk）后端：创建本地 Agent，在任务工作目录里执行，并把过程流式回传。
 * 注意：Cursor Agent 用的是它自己的文件/终端工具，运行在宿主机上，不受本 harness 的路径沙箱约束。
 * 包为可选依赖，只有用到时才动态加载。
 */
export function cursorSdk(o: CursorSdkOptions): AgentBackend {
  return {
    id: o.id,
    async run({ prompt, cwd, signal, onProgress }) {
      const pkg = "@cursor/sdk";
      let mod: any;
      try {
        mod = await import(/* @vite-ignore */ pkg);
      } catch {
        throw new Error("未安装 @cursor/sdk，请先执行 npm i @cursor/sdk（需要 Node >= 22.13）");
      }
      onProgress?.(`正在创建 Cursor Agent（模型 ${o.model ?? "composer-2"}）…`, "status");
      const agent = await mod.Agent.create({
        apiKey: o.apiKey,
        model: { id: o.model ?? "composer-2" },
        local: { cwd },
      });
      onProgress?.("已创建，正在提交任务…", "status");
      // 中断监听要在 send 之前就挂上：创建 / 提交任务期间点停止，不能等到 run 出来才响应
      let run: any;
      const onAbort = () => void run?.cancel?.();
      signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (signal.aborted) throw new Error("已中断");
        run = await agent.send(prompt);
        if (signal.aborted) onAbort(); // send 返回前已经被中断：补一次取消
        onProgress?.("任务已提交，等待 Cursor 开始处理…", "status");
        try {
          for await (const m of run.stream()) {
            for (const [line, kind] of describeMessage(m)) onProgress?.(line, kind);
          }
          const r = await run.wait();
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
export function describeMessage(m: any): Array<[string, "thinking" | "text" | "tool" | "status" | "error"]> {
  const out: Array<[string, "thinking" | "text" | "tool" | "status" | "error"]> = [];
  switch (m?.type) {
    case "thinking":
      if (typeof m.text === "string" && m.text.trim()) out.push([m.text, "thinking"]);
      break;
    case "assistant":
      for (const b of m.message?.content ?? []) {
        if (b.type === "text" && b.text?.trim()) out.push([b.text, "text"]);
        else if (b.type === "tool_use") out.push([`🔧 ${b.name} ${clip(b.input, 160)}`, "tool"]);
      }
      break;
    case "tool_call":
      if (m.status === "completed") out.push([`   ✓ ${m.name}${m.result !== undefined ? ` → ${clip(m.result, 160)}` : ""}`, "tool"]);
      else if (m.status === "error") out.push([`   ✗ ${m.name} 失败${m.result !== undefined ? `：${clip(m.result, 200)}` : ""}`, "error"]);
      break;
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

function toUsage(u: any) {
  if (!u || typeof u !== "object") return undefined;
  const nums = Object.values(u).filter((v): v is number => typeof v === "number");
  const total = nums.reduce((a, b) => a + b, 0);
  return total ? { input: 0, output: 0, total } : undefined;
}

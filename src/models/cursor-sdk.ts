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
      const agent = await mod.Agent.create({
        apiKey: o.apiKey,
        model: { id: o.model ?? "composer-2" },
        local: { cwd },
      });
      try {
        const run = await agent.send(prompt);
        const onAbort = () => void run.cancel();
        signal.addEventListener("abort", onAbort, { once: true });
        try {
          for await (const m of run.stream()) {
            if (m.type === "assistant") {
              for (const b of m.message.content) {
                if (b.type === "text" && b.text.trim()) onProgress?.(b.text);
                else if (b.type === "tool_use") onProgress?.(`🔧 ${b.name} ${JSON.stringify(b.input).slice(0, 120)}`);
              }
            } else if (m.type === "tool_call" && m.status !== "running") {
              onProgress?.(`   ${m.name} ${m.status}`);
            }
          }
          const r = await run.wait();
          if (signal.aborted) throw new Error("已中断");
          if (r.status !== "finished") throw new Error(r.error?.message ?? `Cursor run ${r.status}`);
          return { text: r.result ?? "", usage: toUsage(r.usage) };
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      } finally {
        agent.close();
      }
    },
  };
}

function toUsage(u: any) {
  if (!u || typeof u !== "object") return undefined;
  const nums = Object.values(u).filter((v): v is number => typeof v === "number");
  const total = nums.reduce((a, b) => a + b, 0);
  return total ? { input: 0, output: 0, total } : undefined;
}

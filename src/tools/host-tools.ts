import { truncate } from "../core/context";
import type { Guardrails, Approver } from "../core/guardrails";
import type { Asker, Emit, HostTool, Tool } from "../core/types";

const MAX_OUT = 30_000;

export interface HostToolEnv {
  guard: Guardrails;
  approve: Approver;
  root: string;
  signal: AbortSignal;
  ask?: Asker;
  emit?: Emit;
}

/**
 * 把本软件自己的工具（插件工具等）交给外部 Agent（Cursor）当自定义工具用。
 * 外部 Agent 对自定义工具不弹审批，所以这里自己走一遍护栏：写操作要操作人批准，被拒就把原因回给它。
 */
export function toHostTools(tools: Tool[], env: HostToolEnv): Record<string, HostTool> {
  const out: Record<string, HostTool> = {};
  const emit = env.emit ?? (() => {});
  for (const tool of tools) {
    out[tool.name] = {
      description: tool.description,
      inputSchema: (tool.jsonSchema ?? { type: "object", properties: {} }) as Record<string, unknown>,
      execute: async args => {
        const parsed = tool.schema.safeParse(args ?? {});
        if (!parsed.success) return `参数错误：${parsed.error.message}`;
        let verdict = env.guard.check(tool, parsed.data);
        if (verdict.action === "ask") {
          const ok = await env.approve({ tool, args: parsed.data, reason: verdict.reason }).catch(() => false);
          emit({ type: "approval", step: 0, name: tool.name, args: parsed.data, approved: ok });
          verdict = ok ? { action: "allow" } : { action: "deny", reason: "审批未通过" };
        }
        if (verdict.action === "deny") {
          emit({ type: "tool_blocked", step: 0, name: tool.name, reason: verdict.reason });
          return `被护栏拒绝：${verdict.reason}`;
        }
        const output = await tool.run(parsed.data, { signal: env.signal, root: env.root, ask: env.ask }).catch(e => `工具异常：${e?.message ?? e}`);
        return truncate(output, MAX_OUT);
      },
    };
  }
  return out;
}

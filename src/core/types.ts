import type { z } from "zod";

export type Role = "system" | "user" | "assistant" | "tool";

export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

export interface Msg {
  role: Role;
  content: string;
  /** assistant 消息发起的工具调用 */
  toolCalls?: ToolCall[];
  /** tool 消息对应的调用 id */
  toolCallId?: string;
}

export interface Usage {
  input: number;
  output: number;
  total: number;
}

export interface ModelReply {
  message: Msg;
  toolCalls?: ToolCall[];
  usage?: Usage;
}

/** 给模型看的工具描述 */
export interface ToolSpec {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  /** 外部来源（MCP）自带的 JSON Schema：优先于 schema 发给模型；schema 只做宽松校验 */
  jsonSchema?: Record<string, unknown>;
}

/** 风险等级：护栏按它决定放行 / 审批 / 拒绝 */
export type Risk = "read" | "write" | "exec" | "network";

export interface ToolCtx {
  signal: AbortSignal;
  /** 沙箱根目录：文件类工具只能访问它之内 */
  root: string;
}

export interface Tool extends ToolSpec {
  risk: Risk;
  run(args: any, ctx: ToolCtx): Promise<string>;
}

/** 由 harness 自己驱动 loop 的"裸模型"适配器：OpenAI 兼容 / Anthropic */
export interface ModelAdapter {
  id: string;
  chat(messages: Msg[], tools: ToolSpec[], signal: AbortSignal): Promise<ModelReply>;
}

export interface DelegateInput {
  prompt: string;
  cwd: string;
  signal: AbortSignal;
  /** 外部 agent 的过程输出（工具调用、思考等），用于写 trace / 展示 */
  onProgress?: (line: string) => void;
}

/** 自带 agent loop 的外部 Agent（Cursor SDK / Codex CLI / Claude Code CLI …）：harness 只做委托 + 观测 */
export interface AgentBackend {
  id: string;
  run(input: DelegateInput): Promise<{ text: string; usage?: Usage }>;
}

export type Provider =
  | { kind: "model"; id: string; adapter: ModelAdapter }
  | { kind: "agent"; id: string; backend: AgentBackend };

export type HarnessEvent =
  | { type: "run_start"; runId: string; provider: string; input: string }
  | { type: "model_call"; step: number; messages: Msg[] }
  | { type: "model_reply"; step: number; reply: ModelReply; ms: number; tokens: number }
  | { type: "tool_call"; step: number; name: string; args: unknown }
  | { type: "tool_blocked"; step: number; name: string; reason: string }
  | { type: "approval"; step: number; name: string; args: unknown; approved: boolean }
  | { type: "tool_result"; step: number; name: string; output: string; ms: number }
  | { type: "agent_progress"; line: string }
  | { type: "context_trim"; before: number; after: number; dropped: number }
  | { type: "done"; reason: DoneReason; text?: string; error?: string };

export type DoneReason = "final" | "max_steps" | "aborted" | "error";

export type Emit = (e: HarnessEvent) => void;

export interface RunResult {
  reason: DoneReason;
  text: string;
  steps: number;
  tokens: number;
  /** 本次运行结束时的完整会话，可作为下一轮的 history */
  messages: Msg[];
  error?: string;
}

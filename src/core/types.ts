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
  /** user 消息附带的图片（本机文件绝对路径；发给模型时才读成 base64，所以对话记录 / trace 里不会塞大段图片数据） */
  images?: string[];
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

/** AI 运行中向操作人提的一个问题：给几个选项，也允许自己写 */
export interface AskQuestion {
  id: string;
  question: string;
  options?: string[];
  /** 可以多选（默认单选） */
  multiple?: boolean;
  /** 除了选项，是否允许自己写回答（默认允许） */
  allowText?: boolean;
}

export interface AskAnswer {
  id: string;
  question: string;
  /** 选中的选项 */
  picked: string[];
  /** 自己写的回答 */
  text?: string;
}

/** 向操作人提问并等回答；返回 null = 操作人跳过 / 没法回答 */
export type Asker = (questions: AskQuestion[], signal: AbortSignal) => Promise<AskAnswer[] | null>;

export interface ToolCtx {
  signal: AbortSignal;
  /** 沙箱根目录：文件类工具只能访问它之内 */
  root: string;
  /** 向操作人提问（只有桌面端的对话提供；没有就不能问） */
  ask?: Asker;
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
  /**
   * 会话标识（同一个任务 / 对话用同一个）。支持续接的后端（Cursor SDK）据此复用上一轮的 Agent：
   * 它记得读过的文件和做过的事，不用每一步都从头探索。没有就每次新开。
   */
  sessionKey?: string;
  /** 续接上一轮的 Agent 时改用这份更短的提示（不再重复系统要求和此前对话）；没续接成功就用 prompt */
  resumePrompt?: string;
  /** 这一轮要开全新上下文：丢掉 sessionKey 对应的旧 Agent */
  freshSession?: boolean;
  /** 探索预算：工具调用达到这个数就叫停，让它基于已掌握的信息直接收尾（只给只读步骤用，如分析 / 方案 / CR） */
  toolBudget?: number;
  /** 用户附带的图片（本机文件绝对路径）；prompt 里已经列出了路径，支持图片输入的后端可以直接带上图片本身 */
  images?: string[];
  cwd: string;
  signal: AbortSignal;
  /** 外部 agent 的过程输出（工具调用、思考等），用于写 trace / 展示；kind 不传按 text 处理 */
  onProgress?: (line: string, kind?: ProgressKind) => void;
}

/** 外部 Agent 过程输出的类别：思考 / 回复文字 / 工具调用 / 状态（创建、排队、启动…）/ 错误 */
export type ProgressKind = "thinking" | "text" | "tool" | "status" | "error";

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
  | { type: "agent_progress"; line: string; kind?: ProgressKind }
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

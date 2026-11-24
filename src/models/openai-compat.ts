import type { ModelAdapter, ModelReply, Msg, ToolCall, ToolSpec } from "../core/types";
import { postJson, safeParseArgs, toJsonSchema } from "./http";
import { loadImages } from "./images";

export interface OpenAICompatOptions {
  id: string;
  /** 例如 https://api.openai.com/v1 、https://api.deepseek.com 、各类中转地址 */
  baseURL: string;
  apiKey: string;
  model: string;
  temperature?: number;
  extraHeaders?: Record<string, string>;
  /** 额外请求体字段（如 reasoning_effort、thinking 等厂商私有参数） */
  extraBody?: Record<string, unknown>;
}

/**
 * OpenAI Chat Completions 兼容适配器。
 * 一个适配器覆盖：OpenAI / Codex 系列模型 / DeepSeek / 通义 / Kimi / 智谱 / Ollama / vLLM / 各类中转。
 */
export function openaiCompat(o: OpenAICompatOptions): ModelAdapter {
  const url = o.baseURL.replace(/\/+$/, "") + "/chat/completions";
  return {
    id: o.id,
    async chat(messages, tools, signal): Promise<ModelReply> {
      const body: Record<string, unknown> = {
        model: o.model,
        messages: messages.map(toWire),
        ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
        ...o.extraBody,
      };
      if (tools.length) {
        body.tools = tools.map(toWireTool);
      }
      const json = await postJson(
        url,
        { authorization: `Bearer ${o.apiKey}`, ...o.extraHeaders },
        body,
        signal,
      );
      const msg = json?.choices?.[0]?.message;
      if (!msg) throw new Error(`响应缺少 choices：${JSON.stringify(json).slice(0, 300)}`);

      const toolCalls: ToolCall[] | undefined = msg.tool_calls?.length
        ? msg.tool_calls.map((c: any) => ({
            id: c.id,
            name: c.function?.name,
            args: safeParseArgs(c.function?.arguments),
          }))
        : undefined;
      const u = json.usage;
      return {
        message: { role: "assistant", content: msg.content ?? "" },
        toolCalls,
        usage: u
          ? { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0, total: u.total_tokens ?? 0 }
          : undefined,
      };
    },
  };
}

function toWireTool(t: ToolSpec) {
  return { type: "function", function: { name: t.name, description: t.description, parameters: toJsonSchema(t) } };
}

function toWire(m: Msg): Record<string, unknown> {
  if (m.role === "tool") return { role: "tool", tool_call_id: m.toolCallId, content: m.content };
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map(c => ({
        id: c.id,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) },
      })),
    };
  }
  if (m.role === "user" && m.images?.length) {
    const imgs = loadImages(m.images);
    if (imgs.length) {
      return {
        role: "user",
        content: [
          ...(m.content ? [{ type: "text", text: m.content }] : []),
          ...imgs.map(i => ({ type: "image_url", image_url: { url: `data:${i.mime};base64,${i.data}` } })),
        ],
      };
    }
  }
  return { role: m.role, content: m.content };
}

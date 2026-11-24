import type { ModelAdapter, ModelReply, Msg, ToolCall } from "../core/types";
import { postJson, toJsonSchema } from "./http";
import { loadImages } from "./images";

export interface AnthropicOptions {
  id: string;
  apiKey: string;
  model: string;
  baseURL?: string;
  maxTokens?: number;
  temperature?: number;
}

/** Anthropic Messages API 适配器（也适用于兼容 Anthropic 协议的中转 / 部分国产模型的 Anthropic 端点） */
export function anthropic(o: AnthropicOptions): ModelAdapter {
  const base = (o.baseURL ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const official = /^https?:\/\/api\.anthropic\.com$/i.test(base);
  const url = base + "/v1/messages";
  return {
    id: o.id,
    async chat(messages, tools, signal): Promise<ModelReply> {
      const system = messages
        .filter(m => m.role === "system")
        .map(m => m.content)
        .join("\n\n");
      const body: Record<string, unknown> = {
        model: o.model,
        max_tokens: o.maxTokens ?? 4096,
        messages: toWireMessages(messages.filter(m => m.role !== "system")),
        ...(system ? { system } : {}),
        ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
      };
      if (tools.length) {
        body.tools = tools.map(t => ({ name: t.name, description: t.description, input_schema: toJsonSchema(t) }));
      }
      const json = await postJson(
        url,
        // 官方只认 x-api-key；各家的 Anthropic 兼容地址（智谱、Kimi、MiniMax…）有的认 x-api-key，有的认 Bearer，两个都带
        { "x-api-key": o.apiKey, "anthropic-version": "2023-06-01", ...(official ? {} : { authorization: `Bearer ${o.apiKey}` }) },
        body,
        signal,
      );
      const blocks: any[] = json?.content ?? [];
      const text = blocks
        .filter(b => b.type === "text")
        .map(b => b.text)
        .join("");
      const toolCalls: ToolCall[] = blocks
        .filter(b => b.type === "tool_use")
        .map(b => ({ id: b.id, name: b.name, args: b.input ?? {} }));
      const u = json.usage;
      return {
        message: { role: "assistant", content: text },
        toolCalls: toolCalls.length ? toolCalls : undefined,
        usage: u
          ? { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, total: (u.input_tokens ?? 0) + (u.output_tokens ?? 0) }
          : undefined,
      };
    },
  };
}

/** Anthropic 要求 user/assistant 交替；连续的 tool 结果合并进同一条 user 消息 */
function toWireMessages(msgs: Msg[]): Array<{ role: "user" | "assistant"; content: any }> {
  const out: Array<{ role: "user" | "assistant"; content: any }> = [];
  const push = (role: "user" | "assistant", blocks: any[]) => {
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of msgs) {
    if (m.role === "user") {
      push("user", [
        ...loadImages(m.images).map(i => ({ type: "image", source: { type: "base64", media_type: i.mime, data: i.data } })),
        { type: "text", text: m.content },
      ]);
    } else if (m.role === "assistant") {
      const blocks: any[] = [];
      if (m.content) blocks.push({ type: "text", text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.args ?? {} });
      if (blocks.length) push("assistant", blocks);
    } else if (m.role === "tool") {
      push("user", [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }]);
    }
  }
  return out;
}

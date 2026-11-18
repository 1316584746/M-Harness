import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ModelAdapter, ModelReply } from "../../src/core/types";

/**
 * 测试用的「回声」LLM：本机起一个 OpenAI 兼容的 HTTP 服务，把用户最后一句话原样回出来。
 * 产品里没有任何内置的假模型；测试走的是真实的 openai-compat 适配器 + 真实 HTTP。
 */
export async function startEchoLlm(prefix = "【echo】"): Promise<{ url: string; provider: { type: "openai-compat"; baseURL: string; apiKey: string; model: string }; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      const body = raw ? JSON.parse(raw) : { messages: [] };
      const last = [...(body.messages ?? [])].reverse().find((m: any) => m.role === "user")?.content ?? "";
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `${prefix}${last}` } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  return { url, provider: { type: "openai-compat", baseURL: url, apiKey: "k", model: "echo" }, close: () => new Promise<void>(r => server.close(() => r())) };
}

/** 按脚本依次返回回复的模型适配器，只给 loop 的单元测试直接注入用 */
export function scriptedModel(script: ModelReply[], id = "scripted"): ModelAdapter {
  let i = 0;
  return {
    id,
    async chat() {
      const r = script[i++];
      if (!r) throw new Error("脚本已用尽");
      return r;
    },
  };
}

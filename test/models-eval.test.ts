import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProvider, parseConfig } from "../src/config";
import { checkAssertions, type EvalCase } from "../src/eval/eval";
import { anthropic } from "../src/models/anthropic";
import { openaiCompat } from "../src/models/openai-compat";
import type { HarnessEvent, Msg, RunResult } from "../src/core/types";
import { z } from "zod";

afterEach(() => vi.unstubAllGlobals());

const spec = { name: "read_file", description: "读文件", schema: z.object({ path: z.string() }) };
const history: Msg[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "读 a.txt" },
  { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", args: { path: "a.txt" } }] },
  { role: "tool", toolCallId: "c1", content: "内容" },
];

function stubFetch(resp: unknown) {
  const f = vi.fn(async () => new Response(JSON.stringify(resp), { status: 200 }));
  vi.stubGlobal("fetch", f);
  return f;
}

describe("OpenAI 兼容适配器", () => {
  it("请求格式正确，并解析 tool_calls 与 usage", async () => {
    const f = stubFetch({
      choices: [{ message: { content: null, tool_calls: [{ id: "x", function: { name: "read_file", arguments: '{"path":"b.txt"}' } }] } }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    });
    const m = openaiCompat({ id: "ds", baseURL: "https://api.deepseek.com/", apiKey: "k", model: "deepseek-chat" });
    const r = await m.chat(history, [spec], new AbortController().signal);

    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect(init.headers.authorization).toBe("Bearer k");
    const body = JSON.parse(init.body);
    expect(body.tools[0].function.parameters.properties.path.type).toBe("string");
    expect(body.tools[0].function.parameters.$schema).toBeUndefined();
    expect(body.messages[2].tool_calls[0].function.arguments).toBe('{"path":"a.txt"}');
    expect(body.messages[3]).toMatchObject({ role: "tool", tool_call_id: "c1" });

    expect(r.toolCalls).toEqual([{ id: "x", name: "read_file", args: { path: "b.txt" } }]);
    expect(r.usage).toEqual({ input: 10, output: 5, total: 15 });
  });

  it("非法的工具参数 JSON 不会让适配器崩溃", async () => {
    stubFetch({ choices: [{ message: { content: "", tool_calls: [{ id: "x", function: { name: "read_file", arguments: "{oops" } }] } }] });
    const m = openaiCompat({ id: "o", baseURL: "http://x", apiKey: "k", model: "m" });
    const r = await m.chat(history, [spec], new AbortController().signal);
    expect(r.toolCalls![0].args).toEqual({ __invalidJson: "{oops" });
  });

  it("4xx 不重试直接报错", async () => {
    const f = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", f);
    const m = openaiCompat({ id: "o", baseURL: "http://x", apiKey: "k", model: "m" });
    await expect(m.chat(history, [], new AbortController().signal)).rejects.toThrow("401");
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("Anthropic 适配器", () => {
  it("system 独立、tool_result 归入 user 消息，并解析 tool_use", async () => {
    const f = stubFetch({
      content: [{ type: "text", text: "稍等" }, { type: "tool_use", id: "tu1", name: "read_file", input: { path: "c.txt" } }],
      usage: { input_tokens: 7, output_tokens: 3 },
    });
    const m = anthropic({ id: "claude", apiKey: "k", model: "claude-x" });
    const r = await m.chat(history, [spec], new AbortController().signal);

    const [url, init] = f.mock.calls[0] as any;
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(init.headers["x-api-key"]).toBe("k");
    const body = JSON.parse(init.body);
    expect(body.system).toBe("sys");
    expect(body.messages.map((x: any) => x.role)).toEqual(["user", "assistant", "user"]);
    expect(body.messages[1].content[0]).toMatchObject({ type: "tool_use", id: "c1", input: { path: "a.txt" } });
    expect(body.messages[2].content[0]).toMatchObject({ type: "tool_result", tool_use_id: "c1" });
    expect(body.tools[0].input_schema.type).toBe("object");

    expect(r.message.content).toBe("稍等");
    expect(r.toolCalls).toEqual([{ id: "tu1", name: "read_file", args: { path: "c.txt" } }]);
    expect(r.usage).toEqual({ input: 7, output: 3, total: 10 });
  });
});

describe("配置与 provider 注册", () => {
  it("环境变量展开；缺 Key 时给出明确错误；可构造 4 种后端", () => {
    process.env.TEST_KEY_X = "sk-123";
    const cfg = parseConfig({
      providers: {
        ds: { type: "openai-compat", baseURL: "http://x", apiKey: "${TEST_KEY_X}", model: "m" },
        nokey: { type: "openai-compat", baseURL: "http://x", apiKey: "${NOT_SET_ANYWHERE}", model: "m" },
        codex: { type: "cli", preset: "codex" },
        cur: { type: "cursor-sdk", apiKey: "k" },
      },
    });
    expect(buildProvider("ds", cfg.providers.ds).kind).toBe("model");
    expect(() => buildProvider("nokey", cfg.providers.nokey)).toThrow("缺少 apiKey");
    expect(buildProvider("codex", cfg.providers.codex).kind).toBe("agent");
    expect(buildProvider("cur", cfg.providers.cur).kind).toBe("agent");
  });
});

describe("评测断言", () => {
  const c = (assert: any[]): EvalCase => ({ name: "t", input: "i", auto_approve: false, assert });
  const result = (over: Partial<RunResult> = {}): RunResult => ({ reason: "final", text: "安装完成", steps: 2, tokens: 100, messages: [], ...over });
  const events: HarnessEvent[] = [{ type: "tool_call", step: 1, name: "read_file", args: {} }];

  it("全部满足 → 无失败", async () => {
    const f = await checkAssertions(
      c([{ tool_called: "read_file", no_tool_blocked: true, max_steps: 5, final_contains: ["安装"], final_regex: "完成$" }]),
      events,
      result(),
    );
    expect(f).toEqual([]);
  });

  it("逐项报告失败原因", async () => {
    const f = await checkAssertions(
      c([{ tool_called: "write_file", max_steps: 1, max_tokens: 50, final_contains: ["卸载"], final_not_contains: ["安装"] }]),
      events,
      result(),
    );
    expect(f.map(x => x.assertion).sort()).toEqual(["final_contains", "final_not_contains", "max_steps", "max_tokens", "tool_called"]);
  });

  it("运行出错默认判失败；llm_judge 无裁判时明确提示", async () => {
    const f = await checkAssertions(c([{ llm_judge: "准确" }]), [], result({ reason: "error", error: "boom" }));
    expect(f.map(x => x.assertion)).toEqual(["done_reason", "llm_judge"]);
  });
});

import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildProvider } from "../src/config";
import { bodyError, cleanBase, detectProtocol, normalizeEndpoint } from "../src/models/endpoint";
import { pingModel } from "../src/models/ping";

describe("地址规整：按地址判断真正的协议", () => {
  it("选了 OpenAI 兼容却填了 …/anthropic：改成 anthropic，地址保持", () => {
    const n = normalizeEndpoint("openai-compat", "https://api.z.ai/api/anthropic");
    expect(n.type).toBe("anthropic");
    expect(n.baseURL).toBe("https://api.z.ai/api/anthropic");
    expect(n.notes.length).toBeGreaterThan(0);
  });

  it("anthropic 类型的地址不带结尾 /v1（适配器自己会补 /v1/messages）", () => {
    expect(normalizeEndpoint("anthropic", "https://x.com/anthropic/v1").baseURL).toBe("https://x.com/anthropic");
    expect(normalizeEndpoint("anthropic", "https://x.com/anthropic/v1/messages").baseURL).toBe("https://x.com/anthropic");
    expect(normalizeEndpoint("anthropic", "").baseURL).toBe("");
  });

  it("选了 Anthropic 却填了各家的 OpenAI 兼容地址：改成 openai-compat", () => {
    expect(normalizeEndpoint("anthropic", "https://open.bigmodel.cn/api/paas/v4").type).toBe("openai-compat");
    expect(normalizeEndpoint("anthropic", "https://dashscope.aliyuncs.com/compatible-mode/v1").type).toBe("openai-compat");
  });

  it("粘贴了完整接口地址：去掉多余路径和结尾斜杠", () => {
    expect(cleanBase("https://api.deepseek.com/chat/completions")).toBe("https://api.deepseek.com");
    expect(cleanBase("https://api.openai.com/v1/chat/completions/")).toBe("https://api.openai.com/v1");
    expect(cleanBase("https://api.openai.com/v1/models")).toBe("https://api.openai.com/v1");
    expect(cleanBase("https://api.x.com/v1?foo=1")).toBe("https://api.x.com/v1");
  });

  it("没有明显特征的地址保持用户选的类型，不乱改", () => {
    expect(detectProtocol("https://api.deepseek.com")).toBeUndefined();
    expect(normalizeEndpoint("openai-compat", "https://api.deepseek.com/v1")).toMatchObject({ type: "openai-compat", baseURL: "https://api.deepseek.com/v1", notes: [] });
    expect(normalizeEndpoint("anthropic", "https://relay.example.com")).toMatchObject({ type: "anthropic", baseURL: "https://relay.example.com" });
    expect(normalizeEndpoint("anthropic", "https://api.anthropic.com").notes).toEqual([]);
  });
});

describe("HTTP 200 但正文是错误（智谱等）", () => {
  it("识别出正文里的真实原因", () => {
    const m = bodyError({ code: 500, msg: "404 NOT_FOUND", success: false }, "https://x/chat/completions");
    expect(m).toContain("404");
    expect(m).toContain("https://x/chat/completions");
    expect(bodyError({ error: { message: "bad key", code: 401 } }, "u")).toContain("401");
    expect(bodyError({ code: 1113, msg: "余额不足", success: false }, "u")).toContain("余额不足");
  });
  it("正常响应不误报", () => {
    expect(bodyError({ choices: [{ message: { content: "hi" } }] }, "u")).toBeUndefined();
    expect(bodyError({ content: [{ type: "text", text: "hi" }], code: 0 }, "u")).toBeUndefined();
  });
});

describe("运行时：类型和地址对不上也能用", () => {
  const hits: string[] = [];
  let srv: http.Server;
  let base = "";
  beforeAll(async () => {
    srv = http.createServer((req, res) => {
      hits.push(`${req.method} ${req.url} auth=${req.headers.authorization ? "bearer" : ""} key=${req.headers["x-api-key"] ? "x" : ""}`);
      let body = "";
      req.on("data", d => (body += d));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url === "/zhipu/anthropic/v1/messages") return res.end(JSON.stringify({ content: [{ type: "text", text: "你好" }], usage: { input_tokens: 1, output_tokens: 1 } }));
        if (req.url === "/ok/v1/chat/completions") return res.end(JSON.stringify({ choices: [{ message: { content: "hello" } }] }));
        // 智谱式：地址不对时 HTTP 200 + 业务错误
        res.end(JSON.stringify({ code: 500, msg: "404 NOT_FOUND", success: false }));
      });
    });
    await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  });
  afterAll(() => srv.close());

  const ask = (p: ReturnType<typeof buildProvider>) => (p.kind === "model" ? p.adapter.chat([{ role: "user", content: "hi" }], [], new AbortController().signal) : Promise.reject(new Error("not model")));

  it("类型是 openai-compat 但地址是 …/anthropic：自动走 Anthropic 协议，不再 404", async () => {
    hits.length = 0;
    const r = await ask(buildProvider("智谱", { type: "openai-compat", baseURL: `${base}/zhipu/anthropic`, apiKey: "k", model: "glm" } as any));
    expect(r.message.content).toBe("你好");
    expect(hits).toEqual(["POST /zhipu/anthropic/v1/messages auth=bearer key=x"]);
  });

  it("类型对的 OpenAI 兼容地址照常工作，粘贴了 /chat/completions 也行", async () => {
    const r1 = await ask(buildProvider("a", { type: "openai-compat", baseURL: `${base}/ok/v1`, apiKey: "k", model: "m" } as any));
    expect(r1.message.content).toBe("hello");
    const r2 = await ask(buildProvider("b", { type: "openai-compat", baseURL: `${base}/ok/v1/chat/completions`, apiKey: "k", model: "m" } as any));
    expect(r2.message.content).toBe("hello");
  });

  it("地址确实不对：报出能看懂的原因（带请求地址），而不是「响应缺少 choices」", async () => {
    hits.length = 0;
    await expect(ask(buildProvider("c", { type: "openai-compat", baseURL: `${base}/wrong`, apiKey: "k", model: "m" } as any))).rejects.toThrow(/404.*\/wrong\/chat\/completions|请求地址不存在/);
    expect(hits.length).toBe(1); // 这类错误不重试
  });

  it("测试调用：对的地址通过，错的地址给出原因", async () => {
    const ok = await pingModel({ type: "openai-compat", baseURL: `${base}/zhipu/anthropic`, apiKey: "k", model: "glm" });
    expect(ok).toMatchObject({ ok: true, type: "anthropic" });
    const bad = await pingModel({ type: "openai-compat", baseURL: `${base}/wrong`, apiKey: "k", model: "m" });
    expect(bad.ok).toBe(false);
    expect(bad.error).toMatch(/404/);
    expect((await pingModel({ type: "anthropic", apiKey: "", model: "m" })).error).toContain("API Key");
  });
});

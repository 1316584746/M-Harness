import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { probeKey } from "../src/models/probe";

let server: http.Server;
let base: string;
const seen: Array<{ url?: string; auth?: string; xkey?: string }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, xkey: req.headers["x-api-key"] as string | undefined });
    if (req.url?.startsWith("/anthropic-ok")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ hello: "world" }));
    }
    if (req.url?.startsWith("/anthropic")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ code: 401, msg: "token expired or incorrect", success: false }));
    }
    // Anthropic 兼容地址：没有模型列表（错误码放在 200 的正文里），同一个 Key 在上一级的 /v1/models 上才有
    if (req.url?.startsWith("/ant2/anthropic") || req.url?.startsWith("/ant3/anthropic")) {
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ code: 404, msg: "not found", success: false }));
    }
    const good = req.headers.authorization === "Bearer sk-good-1234" || req.headers["x-api-key"] === "sk-good-1234";
    res.setHeader("content-type", "application/json");
    if (!good) {
      res.statusCode = 401;
      return res.end("{}");
    }
    if (req.url?.endsWith("/models")) return res.end(JSON.stringify({ data: [{ id: "b-model" }, { id: "a-model", display_name: "A Model" }, { id: "a-model" }] }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("probeKey", () => {
  it("openai 兼容：返回排序去重的模型与「Key 有效」说明", async () => {
    const r = await probeKey({ type: "openai-compat", baseURL: `${base}/v1`, apiKey: "sk-good-1234" });
    expect(r.ok).toBe(true);
    expect(r.models).toEqual(["a-model", "b-model"]);
    expect(r.labels).toEqual({ "a-model": "A Model" });
    expect(r.user?.note).toContain("Key 有效");
    expect(seen.at(-1)?.auth).toBe("Bearer sk-good-1234");
  });

  it("anthropic：用 x-api-key 头", async () => {
    const r = await probeKey({ type: "anthropic", baseURL: base, apiKey: "sk-good-1234" });
    expect(r.ok).toBe(true);
    expect(seen.at(-1)?.url).toBe("/v1/models");
    expect(seen.at(-1)?.xkey).toBe("sk-good-1234");
  });

  it("Key 无效给出明确提示", async () => {
    const r = await probeKey({ type: "openai-compat", baseURL: `${base}/v1`, apiKey: "sk-bad" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("无效");
  });

  it("HTTP 200 但正文是错误码（智谱 Anthropic 兼容地址）：不能当成 Key 有效", async () => {
    const r = await probeKey({ type: "openai-compat", baseURL: `${base}/anthropic`, apiKey: "sk-whatever" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("无效");
  });

  it("正文里没有模型列表：提示检查地址和类型，Anthropic 地址配 OpenAI 类型要点明", async () => {
    const r = await probeKey({ type: "openai-compat", baseURL: `${base}/anthropic-ok`, apiKey: "sk-good-1234" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("没有拿到模型列表");
    expect(r.error).toContain("Anthropic 兼容地址");
  });

  it("Anthropic 兼容地址上没有列表：同一个 Key 自动去上一级的 OpenAI 兼容接口取", async () => {
    const r = await probeKey({ type: "openai-compat", baseURL: `${base}/ant2/anthropic`, apiKey: "sk-good-1234" });
    expect(r.ok).toBe(true);
    expect(r.models).toEqual(["a-model", "b-model"]);
    const r2 = await probeKey({ type: "anthropic", baseURL: `${base}/ant2/anthropic`, apiKey: "sk-good-1234" });
    expect(r2.ok).toBe(true);
  });

  it("本地址不给列表、备用接口说「无权限」：不断言 Key 无效，提示手动填模型名", async () => {
    const r = await probeKey({ type: "openai-compat", baseURL: `${base}/ant3/anthropic`, apiKey: "sk-restricted" });
    expect(r.ok).toBe(false);
    expect(r.error).toContain("手动填写模型名");
    expect(r.error).toContain("不一定是无效");
    expect(r.error).not.toContain("API Key 无效");
  });

  it("地址里粘了完整的 /chat/completions 或没写 /v1，也能取到列表", async () => {
    expect((await probeKey({ type: "openai-compat", baseURL: `${base}/v1/chat/completions`, apiKey: "sk-good-1234" })).models).toEqual(["a-model", "b-model"]);
    expect((await probeKey({ type: "openai-compat", baseURL: `${base}/`, apiKey: "sk-good-1234" })).ok).toBe(true);
  });

  it("缺少 Key / Base URL / 不支持的类型", async () => {
    expect((await probeKey({ type: "openai-compat", baseURL: base, apiKey: "" })).ok).toBe(false);
    expect((await probeKey({ type: "openai-compat", apiKey: "x" })).error).toContain("Base URL");
    expect((await probeKey({ type: "cli" })).ok).toBe(false);
    expect((await probeKey({ type: "cursor-sdk", apiKey: "" })).error).toContain("API Key");
  });
});

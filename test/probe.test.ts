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

  it("缺少 Key / Base URL / 不支持的类型", async () => {
    expect((await probeKey({ type: "openai-compat", baseURL: base, apiKey: "" })).ok).toBe(false);
    expect((await probeKey({ type: "openai-compat", apiKey: "x" })).error).toContain("Base URL");
    expect((await probeKey({ type: "cli" })).ok).toBe(false);
    expect((await probeKey({ type: "cursor-sdk", apiKey: "" })).error).toContain("API Key");
  });
});

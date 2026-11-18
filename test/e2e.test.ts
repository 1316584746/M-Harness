import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer } from "../src/channels/server";
import { dingtalkSign } from "../src/channels/dingtalk";
import { parseConfig } from "../src/config";
import { readTrace } from "../src/core/trace";
import { Runtime } from "../src/runtime";

/** 假的 OpenAI 兼容服务：第 1 次请求让模型调用 list_dir，第 2 次给出最终回答 */
function fakeLLM() {
  const requests: any[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw);
      requests.push(body);
      const hasToolResult = body.messages.some((m: any) => m.role === "tool");
      const message = hasToolResult
        ? { role: "assistant", content: `目录里有：${body.messages.find((m: any) => m.role === "tool").content.replace(/\n/g, ",")}` }
        : { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "list_dir", arguments: '{"path":"."}' } }] };
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }));
    });
  });
  return { server, requests };
}

const dirs: string[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-"));
  dirs.push(d);
  return d;
};
afterAll(() => dirs.forEach(d => fs.rmSync(d, { recursive: true, force: true })));

describe("端到端：真实 HTTP 适配器 + loop + 工具 + trace + 办公通道", () => {
  const llm = fakeLLM();
  let llmPort = 0;
  let workspace = "";
  let traceDir = "";
  let rt: Runtime;

  beforeAll(async () => {
    await new Promise<void>(r => llm.server.listen(0, "127.0.0.1", r));
    llmPort = (llm.server.address() as AddressInfo).port;
    workspace = tmp();
    traceDir = tmp();
    fs.writeFileSync(path.join(workspace, "hello.txt"), "hi");
    rt = new Runtime(
      parseConfig({
        defaultProvider: "fake",
        workspace,
        traceDir,
        providers: { fake: { type: "openai-compat", baseURL: `http://127.0.0.1:${llmPort}/v1`, apiKey: "k", model: "m" }, other: { type: "openai-compat", baseURL: `http://127.0.0.1:${llmPort}/v1`, apiKey: "k", model: "m2" } },
        channels: {
          server: { host: "127.0.0.1", port: 0 },
          dingtalk: { appSecret: "sec" },
        },
      }),
    );
  });
  afterAll(() => llm.server.close());

  it("runTask：调用工具并写出可回放的 trace", async () => {
    const r = await rt.runTask({ input: "看看目录" });
    expect(r.reason).toBe("final");
    expect(r.text).toContain("hello.txt");
    expect(r.steps).toBe(2);
    expect(r.tokens).toBe(30);

    const types = readTrace(r.traceFile).map(l => l.event.type);
    expect(types).toEqual(["run_start", "model_call", "model_reply", "tool_call", "tool_result", "model_call", "model_reply", "done"]);
  });

  it("HTTP 服务：/healthz、/dev/chat、钉钉回调（带签名）", async () => {
    const server = startServer(rt, undefined, () => {});
    await new Promise(r => server.once("listening", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const health: any = await (await fetch(`${base}/healthz`)).json();
      expect(health.channels).toEqual(["dingtalk"]);
      expect(health.providers).toContain("fake");

      const chat: any = await (await fetch(`${base}/dev/chat`, { method: "POST", body: JSON.stringify({ text: "看看目录", conversationId: "t" }) })).json();
      expect(chat.replies[0]).toContain("hello.txt");

      const switched: any = await (await fetch(`${base}/dev/chat`, { method: "POST", body: JSON.stringify({ text: "/model other", conversationId: "t" }) })).json();
      expect(switched.replies[0]).toContain("已切换到 other");

      // 钉钉：伪造一个 sessionWebhook 接收方，验证完整回路
      const hook: any[] = [];
      const hookServer = http.createServer((req, res) => {
        let raw = "";
        req.on("data", c => (raw += c));
        req.on("end", () => {
          hook.push(JSON.parse(raw));
          res.setHeader("content-type", "application/json");
          res.end('{"errcode":0}');
        });
      });
      await new Promise<void>(r => hookServer.listen(0, "127.0.0.1", r));
      const hookUrl = `http://127.0.0.1:${(hookServer.address() as AddressInfo).port}/session`;
      const ts = String(Date.now());
      const res = await fetch(`${base}/dingtalk/callback`, {
        method: "POST",
        headers: { timestamp: ts, sign: dingtalkSign(ts, "sec"), "content-type": "application/json" },
        body: JSON.stringify({ msgtype: "text", text: { content: "你好" }, msgId: "m1", conversationId: "c1", senderStaffId: "u1", sessionWebhook: hookUrl }),
      });
      expect(res.status).toBe(200);
      for (let i = 0; i < 50 && !hook.length; i++) await new Promise(r => setTimeout(r, 50));
      expect(hook[0].text.content).toContain("hello.txt");
      hookServer.close();

      const forged = await fetch(`${base}/dingtalk/callback`, { method: "POST", headers: { timestamp: ts, sign: "forged" }, body: "{}" });
      expect(forged.status).toBe(401);
    } finally {
      server.close();
    }
  });

  it("办公通道默认只读：写文件被策略拒绝，文件不会生成", async () => {
    const r = await rt.runTask({
      input: "x",
      mode: "channel",
    });
    expect(r.reason).toBe("final");
    const g = rt.guardFor("channel");
    const { writeFile, runCommand, httpRequest } = await import("../src/tools/builtin");
    expect(g.check(writeFile, { path: "a", content: "b" }).action).toBe("deny");
    expect(g.check(runCommand, { command: "ls" }).action).toBe("deny");
    expect(g.check(httpRequest, { url: "https://example.com" }).action).toBe("deny");
    expect(rt.guardFor("local").check(writeFile, { path: "a", content: "b" }).action).toBe("ask");
  });
});

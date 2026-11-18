import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { Runtime } from "../src/runtime";

let dir: string;
let srv: http.Server;
let last: any;
let port = 0;

beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "rt-"));
  last = undefined;
  srv = http.createServer((req, res) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      last = JSON.parse(raw);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "好的" } }], usage: { total_tokens: 1 } }));
    });
  });
  await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
  port = (srv.address() as any).port;
});
afterEach(async () => {
  srv.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Runtime：规则 / 技能 / MCP 进入模型请求", () => {
  it("system 带上规则与技能目录，工具带上 MCP 工具和 use_skill", async () => {
    fs.writeFileSync(path.join(dir, "AGENTS.md"), "项目约定：回复末尾加【收到】");
    fs.mkdirSync(path.join(dir, "home", "skills", "review"), { recursive: true });
    fs.writeFileSync(path.join(dir, "home", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: 代码审查\n---\n先看改动范围");
    const rt = new Runtime(
      parseConfig({
        defaultProvider: "fake",
        workspace: dir,
        traceDir: path.join(dir, "traces"),
        providers: { fake: { type: "openai-compat", baseURL: `http://127.0.0.1:${port}`, apiKey: "k", model: "m" } },
        rules: { items: [{ id: "1", content: "回复一律使用中文" }] },
        skills: { disabled: [], scanUserDirs: false },
        mcpServers: { echo: { command: process.execPath, args: [path.resolve("test/fixtures/mcp-echo.mjs")], disabledTools: ["boom"] } },
      }),
      { home: path.join(dir, "home") },
    );
    try {
      const r = await rt.runTask({ input: "你好" });
      expect(r.reason).toBe("final");
      const system = last.messages[0].content as string;
      expect(system).toContain("回复一律使用中文");
      expect(system).toContain("回复末尾加【收到】");
      expect(system).toContain("- review：代码审查");
      const tools = last.tools.map((t: any) => t.function.name);
      expect(tools).toContain("use_skill");
      expect(tools).toContain("mcp__echo__echo");
      expect(tools).not.toContain("mcp__echo__boom");
      // MCP 工具发给模型的是它自带的 JSON Schema
      const echo = last.tools.find((t: any) => t.function.name === "mcp__echo__echo");
      expect(echo.function.parameters.properties.text.type).toBe("string");
    } finally {
      await rt.dispose();
    }
  }, 60_000);

  it("停用的技能不会进入 system", async () => {
    fs.mkdirSync(path.join(dir, "home", "skills", "review"), { recursive: true });
    fs.writeFileSync(path.join(dir, "home", "skills", "review", "SKILL.md"), "---\nname: review\ndescription: 代码审查\n---\nx");
    const rt = new Runtime(
      parseConfig({
        defaultProvider: "fake",
        workspace: dir,
        traceDir: path.join(dir, "traces"),
        providers: { fake: { type: "openai-compat", baseURL: `http://127.0.0.1:${port}`, apiKey: "k", model: "m" } },
        skills: { disabled: ["review"], scanUserDirs: false },
      }),
      { home: path.join(dir, "home") },
    );
    await rt.runTask({ input: "你好" });
    expect(last.messages[0].content).not.toContain("review：代码审查");
    expect(last.tools.map((t: any) => t.function.name)).not.toContain("use_skill");
  });
});

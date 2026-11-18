import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseConfig } from "../src/config";
import { McpManager } from "../src/mcp/manager";
import { Runtime } from "../src/runtime";

const server = path.resolve("test/fixtures/mcp-echo.mjs");
const cfg = (extra: object = {}) =>
  parseConfig({ mcpServers: { echo: { command: process.execPath, args: [server], ...extra }, bad: { command: "definitely-not-a-command-xyz" } } }).mcpServers;

let mgr: McpManager | undefined;
afterEach(async () => {
  await mgr?.dispose();
  mgr = undefined;
});

describe("McpManager", () => {
  it("连接本地服务、列出工具并能调用；连不上的服务只标记错误", async () => {
    mgr = new McpManager();
    mgr.configure(cfg());
    await mgr.ensure(30_000);
    const st = mgr.status();
    expect(st.find(s => s.name === "echo")?.state).toBe("ready");
    expect(st.find(s => s.name === "bad")?.state).toBe("error");
    expect(st.find(s => s.name === "bad")?.error).toBeTruthy();

    const tools = mgr.tools();
    expect(tools.map(t => t.name)).toEqual(["mcp__echo__echo", "mcp__echo__danger", "mcp__echo__boom"]);
    const echo = tools.find(t => t.name === "mcp__echo__echo")!;
    expect(echo.risk).toBe("read"); // readOnlyHint
    expect(tools.find(t => t.name === "mcp__echo__danger")!.risk).toBe("write");
    expect((echo.jsonSchema as any).properties.text.type).toBe("string");
    const ctx = { signal: new AbortController().signal, root: "." };
    expect(await echo.run({ text: "hi" }, ctx)).toBe("echo:hi");
    expect(await tools.find(t => t.name === "mcp__echo__boom")!.run({}, ctx)).toBe("错误：炸了");
  }, 60_000);

  it("permission=auto 时不带只读标注的工具也按 read 处理；disabledTools 会被隐藏", async () => {
    mgr = new McpManager();
    mgr.configure(cfg({ permission: "auto", disabledTools: ["boom"] }));
    await mgr.ensure(30_000);
    const tools = mgr.tools();
    expect(tools.find(t => t.name === "mcp__echo__danger")!.risk).toBe("read");
    expect(tools.some(t => t.name === "mcp__echo__boom")).toBe(false);
    expect(mgr.status().find(s => s.name === "echo")!.tools.find(t => t.name === "boom")!.enabled).toBe(false);
  }, 60_000);

  it("配置变化：只改 disabledTools 不重连；改命令会重连；停用的服务不连接", async () => {
    mgr = new McpManager();
    mgr.configure(cfg());
    await mgr.ensure(30_000);
    const before = (mgr as any).entries.get("echo").client;
    mgr.configure(cfg({ disabledTools: ["echo"] }));
    expect((mgr as any).entries.get("echo").client).toBe(before);
    mgr.configure(cfg({ enabled: false }));
    expect(mgr.status().find(s => s.name === "echo")!.state).toBe("disabled");
    expect(mgr.tools()).toHaveLength(0);
  }, 60_000);

  it("Runtime 把 MCP 工具并入 tools；自己创建的连接在 dispose 时关闭", async () => {
    const rt = new Runtime(parseConfig({ mcpServers: { echo: { command: process.execPath, args: [server] } } }));
    expect(rt.tools.some(t => t.name.startsWith("mcp__"))).toBe(false);
    await rt.prepare();
    expect(rt.tools.some(t => t.name === "mcp__echo__echo")).toBe(true);
    await rt.dispose();
    expect(rt.mcp.status()).toHaveLength(0);
  }, 60_000);
});

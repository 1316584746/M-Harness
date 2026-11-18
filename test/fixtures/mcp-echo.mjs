// 测试用的最小 MCP 服务（stdio）：一个只读工具、一个会改东西的工具
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const s = new McpServer({ name: "echo", version: "1.0.0" });
s.registerTool("echo", { description: "回显文本", inputSchema: { text: z.string() }, annotations: { readOnlyHint: true } }, async ({ text }) => ({
  content: [{ type: "text", text: `echo:${text}` }],
}));
s.registerTool("danger", { description: "会修改数据的操作", inputSchema: {} }, async () => ({ content: [{ type: "text", text: "done" }] }));
s.registerTool("boom", { description: "总是失败", inputSchema: {} }, async () => ({ isError: true, content: [{ type: "text", text: "炸了" }] }));
await s.connect(new StdioServerTransport());

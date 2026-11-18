import { z } from "zod";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "../config";
import type { Risk, Tool } from "../core/types";

export type McpState = "disabled" | "idle" | "connecting" | "ready" | "error";

export interface McpToolInfo {
  /** 原始工具名 */
  name: string;
  description: string;
  risk: Risk;
  enabled: boolean;
}

export interface McpServerStatus {
  name: string;
  state: McpState;
  error?: string;
  transport: "stdio" | "http";
  /** 命令行或地址，用于界面展示 */
  target: string;
  tools: McpToolInfo[];
}

interface RawTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  readOnly: boolean;
}

interface Entry {
  cfg: McpServerConfig;
  /** 与连接相关的配置指纹：变化时需要重连 */
  key: string;
  state: McpState;
  error?: string;
  client?: Client;
  tools: RawTool[];
  connecting?: Promise<void>;
  stderr: string;
}

const CONNECT_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_OUT = 100_000;

const connKey = (c: McpServerConfig) => JSON.stringify([c.enabled, c.command, c.args, c.env, c.cwd, c.url, c.headers]);
const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([p, new Promise<never>((_, rej) => (t = setTimeout(() => rej(new Error(`${what}超时（${ms / 1000} 秒）`)), ms)))]).finally(() => clearTimeout(t));
}

/** 把 MCP 工具返回的内容块拼成文本 */
function formatResult(res: any): string {
  const parts: string[] = [];
  for (const c of res?.content ?? []) {
    if (c.type === "text") parts.push(c.text);
    else if (c.type === "image") parts.push(`[图片 ${c.mimeType ?? ""}，已省略]`);
    else if (c.type === "resource") parts.push(c.resource?.text ?? `[资源 ${c.resource?.uri ?? ""}]`);
    else parts.push(JSON.stringify(c));
  }
  if (!parts.length && res?.structuredContent) parts.push(JSON.stringify(res.structuredContent));
  let out = parts.join("\n");
  if (out.length > MAX_OUT) out = out.slice(0, MAX_OUT) + "\n…（输出过长，已截断）";
  return res?.isError ? `错误：${out || "工具返回了错误"}` : out;
}

/** MCP 连接管理：按配置连接各服务、列出工具并包装成 harness 的 Tool。配置变化时只重连有变化的服务。 */
export class McpManager {
  private entries = new Map<string, Entry>();

  /** 应用最新配置：新增 / 变更的服务重连，删除的断开，其余保持连接 */
  configure(servers: Record<string, McpServerConfig>): void {
    for (const [name, e] of this.entries) {
      const next = servers[name];
      if (!next || connKey(next) !== e.key) {
        void this.close(e);
        this.entries.delete(name);
      }
    }
    for (const [name, cfg] of Object.entries(servers)) {
      const e = this.entries.get(name);
      if (e) e.cfg = cfg; // disabledTools / permission 变化不需要重连
      else this.entries.set(name, { cfg, key: connKey(cfg), state: cfg.enabled ? "idle" : "disabled", tools: [], stderr: "" });
    }
  }

  /** 保证已启用的服务都尝试连接过（最多等 maxWaitMs；没连上的不影响本次运行） */
  async ensure(maxWaitMs = 20_000): Promise<void> {
    const pending = [...this.entries.entries()].filter(([, e]) => e.state === "idle" || e.state === "connecting").map(([n, e]) => e.connecting ?? this.start(n, e));
    if (!pending.length) return;
    await Promise.race([Promise.allSettled(pending), new Promise(r => setTimeout(r, maxWaitMs))]);
  }

  async reconnect(name: string): Promise<void> {
    const e = this.entries.get(name);
    if (!e || !e.cfg.enabled) return;
    await this.close(e);
    e.state = "idle";
    await this.start(name, e);
  }

  status(): McpServerStatus[] {
    return [...this.entries.entries()].map(([name, e]) => ({
      name,
      state: e.state,
      error: e.error,
      transport: e.cfg.command ? "stdio" : "http",
      target: e.cfg.command ? [e.cfg.command, ...e.cfg.args].join(" ") : (e.cfg.url ?? ""),
      tools: e.tools.map(t => ({
        name: t.name,
        description: t.description,
        risk: this.riskOf(e, t),
        enabled: !e.cfg.disabledTools.includes(t.name),
      })),
    }));
  }

  private riskOf(e: Entry, t: RawTool): Risk {
    return t.readOnly || e.cfg.permission === "auto" ? "read" : "write";
  }

  /** 已连接服务里已启用的工具，包装成 harness 的 Tool（名字为 mcp__服务__工具） */
  tools(): Tool[] {
    const out: Tool[] = [];
    for (const [server, e] of this.entries) {
      if (e.state !== "ready" || !e.client) continue;
      for (const t of e.tools) {
        if (e.cfg.disabledTools.includes(t.name)) continue;
        const client = e.client;
        out.push({
          name: `mcp__${safe(server)}__${safe(t.name)}`.slice(0, 64),
          description: `[MCP · ${server}] ${t.description}`.trim(),
          risk: this.riskOf(e, t),
          schema: z.preprocess(v => v ?? {}, z.record(z.string(), z.unknown())),
          jsonSchema: t.inputSchema,
          run: async (args, ctx) => {
            try {
              const res = await client.callTool({ name: t.name, arguments: args }, undefined, { signal: ctx.signal, timeout: CALL_TIMEOUT_MS });
              return formatResult(res);
            } catch (err: any) {
              if (e.client !== client) throw new Error(`MCP 服务 ${server} 已断开，请在设置里重连`);
              throw err;
            }
          },
        });
      }
    }
    return out;
  }

  async dispose(): Promise<void> {
    await Promise.allSettled([...this.entries.values()].map(e => this.close(e)));
    this.entries.clear();
  }

  private start(name: string, e: Entry): Promise<void> {
    e.connecting = this.connect(name, e).finally(() => {
      e.connecting = undefined;
    });
    return e.connecting;
  }

  private async close(e: Entry): Promise<void> {
    const c = e.client;
    e.client = undefined;
    e.tools = [];
    if (c) await c.close().catch(() => {});
  }

  private async connect(name: string, e: Entry): Promise<void> {
    e.state = "connecting";
    e.error = undefined;
    e.stderr = "";
    const cfg = e.cfg;
    try {
      const client = await withTimeout(this.open(e, cfg), CONNECT_TIMEOUT_MS, "连接");
      const tools: RawTool[] = [];
      let cursor: string | undefined;
      do {
        const r = await withTimeout(client.listTools(cursor ? { cursor } : undefined), 30_000, "获取工具列表");
        for (const t of r.tools) {
          const schema: any = { ...(t.inputSchema as object) };
          delete schema.$schema;
          if (schema.type !== "object") schema.type = "object";
          schema.properties ??= {};
          tools.push({ name: t.name, description: t.description ?? t.title ?? "", inputSchema: schema, readOnly: t.annotations?.readOnlyHint === true });
        }
        cursor = r.nextCursor;
      } while (cursor);
      e.client = client;
      e.tools = tools;
      e.state = "ready";
      client.onclose = () => {
        if (e.client === client) {
          e.client = undefined;
          e.state = "error";
          e.error = "连接已断开";
        }
      };
    } catch (err: any) {
      e.state = "error";
      const tail = e.stderr.trim().split(/\r?\n/).slice(-4).join("\n");
      e.error = `${err?.message ?? err}${tail ? `\n${tail}` : ""}`;
      await this.close(e);
    }
  }

  private async open(e: Entry, cfg: McpServerConfig): Promise<Client> {
    const mk = () => new Client({ name: "m-harness", version: "0.1.0" }, { capabilities: {} });
    if (cfg.command) {
      const transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        env: { ...getDefaultEnvironment(), ...(cfg.env ?? {}) },
        cwd: cfg.cwd || undefined,
        stderr: "pipe",
      });
      transport.stderr?.on("data", (b: Buffer) => (e.stderr = (e.stderr + b.toString("utf8")).slice(-4000)));
      const client = mk();
      await client.connect(transport as Transport);
      return client;
    }
    if (cfg.url) {
      const url = new URL(cfg.url);
      const opts = { requestInit: { headers: cfg.headers ?? {} } };
      const first = mk();
      try {
        await first.connect(new StreamableHTTPClientTransport(url, opts));
        return first;
      } catch (err) {
        await first.close().catch(() => {});
        const second = mk();
        try {
          await second.connect(new SSEClientTransport(url, opts));
          return second;
        } catch {
          await second.close().catch(() => {});
          throw err;
        }
      }
    }
    throw new Error("需要填写 command（本地命令）或 url（远程地址）");
  }
}

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Tool } from "../../src/core/types";
import type { PluginAiInfo } from "../shared/pluginhost";
import type { AiPluginRef, AiRawTool, PluginHost } from "./pluginhost";

/** PluginAi 需要的宿主能力：已装插件的列表、工具、调用。DBX 插件和 DSH 插件各实现一份，由调用方合起来 */
export type AiHost = Pick<PluginHost, "aiPlugins" | "aiTools" | "aiCall">;

/**
 * 让 AI 使用「已装插件」自带的工具。不挑插件：只要清单里有 mcp 贡献、带后台程序、用户确认信任过，
 * 并且用户在「插件 → 设置」里允许 AI 使用它，它的工具就会和内置工具、MCP 工具一起交给模型。
 * 插件的后台程序由本软件自己启动（不需要 DBX），协议是 DBX 插件平台的 mcp/tools、mcp/call。
 */

const TTL_MS = 5 * 60_000;
const MAX_OUT = 100_000;
const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

interface Cached {
  key: string;
  at: number;
  tools: AiRawTool[];
  error?: string;
}

/** 把 mcp/call 的返回（MCP 内容块）拼成文本 */
export function formatToolResult(res: unknown): string {
  const r = res as { content?: Array<{ type?: string; text?: string; mimeType?: string; resource?: { text?: string; uri?: string } }>; structuredContent?: unknown; isError?: boolean } | null;
  const parts: string[] = [];
  for (const c of r?.content ?? []) {
    if (c.type === "text") parts.push(String(c.text ?? ""));
    else if (c.type === "image") parts.push(`[图片 ${c.mimeType ?? ""}，已省略]`);
    else if (c.type === "resource") parts.push(c.resource?.text ?? `[资源 ${c.resource?.uri ?? ""}]`);
    else parts.push(JSON.stringify(c));
  }
  if (!parts.length && r?.structuredContent) parts.push(JSON.stringify(r.structuredContent));
  if (!parts.length && r && !Array.isArray(r.content)) parts.push(JSON.stringify(res));
  let out = parts.join("\n");
  if (out.length > MAX_OUT) out = out.slice(0, MAX_OUT) + "\n…（输出过长，已截断）";
  return r?.isError ? `错误：${out || "工具返回了错误"}` : out;
}

export class PluginAi {
  private cache = new Map<string, Cached>();
  private loading = new Map<string, Promise<Cached>>();

  constructor(
    private host: () => AiHost,
    private file: string,
  ) {}

  // ───────── 开关 ─────────

  enabledIds(): string[] {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(j?.enabled) ? j.enabled.map(String) : [];
    } catch {
      return [];
    }
  }

  isEnabled(id: string): boolean {
    return this.enabledIds().some(x => x.toLowerCase() === id.toLowerCase());
  }

  setEnabled(id: string, on: boolean): void {
    const rest = this.enabledIds().filter(x => x.toLowerCase() !== id.toLowerCase());
    if (on) rest.push(id);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ enabled: rest }, null, 2));
  }

  /** 插件更新 / 卸载后：丢掉它缓存的工具列表；卸载时顺便把开关也清掉 */
  forget(id: string, removed = false): void {
    this.cache.delete(id);
    if (removed && this.isEnabled(id)) this.setEnabled(id, false);
  }

  // ───────── 工具列表 ─────────

  private load(p: AiPluginRef, force: boolean): Promise<Cached> {
    const key = `${p.id}@${p.version}`;
    const hit = this.cache.get(p.id);
    if (!force && hit && hit.key === key && !hit.error && Date.now() - hit.at < TTL_MS) return Promise.resolve(hit);
    const going = this.loading.get(p.id);
    if (going) return going;
    const job = this.host()
      .aiTools(p.id)
      .then<Cached>(tools => ({ key, at: Date.now(), tools }))
      .catch<Cached>(e => ({ key, at: Date.now(), tools: [], error: e instanceof Error ? e.message : String(e) }))
      .then(c => {
        this.cache.set(p.id, c);
        return c;
      })
      .finally(() => this.loading.delete(p.id));
    this.loading.set(p.id, job);
    return job;
  }

  /** 设置页用：所有能给 AI 用的插件，已确认信任的会把工具列表一起取回来 */
  async list(): Promise<PluginAiInfo[]> {
    const refs = this.host().aiPlugins();
    return Promise.all(
      refs.map(async p => {
        const c = p.trusted ? await this.load(p, true) : undefined;
        return {
          id: p.id,
          name: p.name,
          version: p.version,
          trusted: p.trusted,
          enabled: this.isEnabled(p.id),
          connKind: p.connKind,
          connCount: p.conns.length,
          description: p.description,
          tools: (c?.tools ?? []).map(t => ({ name: t.name, description: t.description, readOnly: t.readOnly })),
          error: c?.error,
          ecosystem: p.ecosystem,
        } satisfies PluginAiInfo;
      }),
    );
  }

  /** 每次运行前：把允许 AI 用且已信任的插件的工具列表准备好（有缓存，不会每次都启动后台程序） */
  async prepare(): Promise<void> {
    const on = new Set(this.enabledIds().map(x => x.toLowerCase()));
    if (!on.size) return;
    const refs = this.host()
      .aiPlugins()
      .filter(p => p.trusted && on.has(p.id.toLowerCase()));
    await Promise.allSettled(refs.map(p => this.load(p, false)));
  }

  /** 交给模型的工具（同步取缓存；prepare 没准备好的插件这次先不给） */
  tools(): Tool[] {
    const on = new Set(this.enabledIds().map(x => x.toLowerCase()));
    if (!on.size) return [];
    const out: Tool[] = [];
    const used = new Set<string>();
    for (const p of this.host().aiPlugins()) {
      if (!p.trusted || !on.has(p.id.toLowerCase())) continue;
      const c = this.cache.get(p.id);
      if (!c || c.key !== `${p.id}@${p.version}`) continue;
      for (const t of c.tools) {
        const name = `plugin__${safe(p.id)}__${safe(t.name)}`.slice(0, 64);
        if (used.has(name)) continue;
        used.add(name);
        out.push(this.wrap(p, t, name));
      }
    }
    return out;
  }

  private wrap(p: AiPluginRef, t: AiRawTool, name: string): Tool {
    const schema: Record<string, unknown> = { ...t.inputSchema, properties: { ...(t.inputSchema.properties as Record<string, unknown>) } };
    const props = schema.properties as Record<string, unknown>;
    // 连接类插件：要告诉它用哪个连接。只有一个时不用说；工具自己已经有 connection 参数就不插手
    const addConn = !!p.connKind && !("connection" in props);
    if (addConn) {
      props.connection = {
        type: "string",
        description: p.conns.length ? `用哪个连接（名称）。可用：${p.conns.map(c => c.name).join("、")}${p.conns.length === 1 ? "；只有一个时可不填" : ""}` : "用哪个连接（还没有可用连接，请先到「设置 → 连接」添加）",
      };
    }
    const host = this.host;
    return {
      name,
      description: `[插件 · ${p.name}] ${t.description}`.trim(),
      risk: t.readOnly ? "read" : "write",
      schema: z.preprocess(v => v ?? {}, z.record(z.string(), z.unknown())),
      jsonSchema: schema,
      run: async (args, ctx) => {
        const { connection, ...rest } = (args ?? {}) as Record<string, unknown>;
        const call = addConn ? host().aiCall(p.id, t.name, rest, typeof connection === "string" ? connection : undefined) : host().aiCall(p.id, t.name, (args ?? {}) as Record<string, unknown>);
        const aborted = new Promise<never>((_, rej) => ctx.signal.addEventListener("abort", () => rej(new Error("已取消")), { once: true }));
        try {
          return formatToolResult(await Promise.race([call, aborted]));
        } catch (e) {
          return `错误：${e instanceof Error ? e.message : String(e)}`;
        }
      },
    };
  }
}

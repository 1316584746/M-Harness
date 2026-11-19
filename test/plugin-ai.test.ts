import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionStore } from "../desktop/main/connections";
import { PluginAi, formatToolResult } from "../desktop/main/plugin-ai";
import { PluginHost } from "../desktop/main/pluginhost";
import { DEFAULTS, type ConnectionInput } from "../desktop/shared/connections";

// 假的后台：和真插件一样回应 mcp/tools、mcp/call（连接配置放在 params.lifecycle.connection 里）
const SIDECAR = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = o => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", l => {
  const m = JSON.parse(l);
  const ok = r => send({ jsonrpc: "2.0", id: m.id, result: r });
  if (m.method === "plugin/initialize") return ok({ protocolVersion: 1, plugin: { id: process.env.DBX_PLUGIN_ID }, capabilities: [] });
  if (m.method === "mcp/tools") return ok({ tools: [
    { name: "list_things", description: "列出东西", inputSchema: { type: "object", properties: { limit: { type: "number" } } }, annotations: { readOnlyHint: true } },
    { name: "do_it", description: "会改东西", inputSchema: { type: "object", properties: { id: { type: "number" } }, required: ["id"] } },
  ] });
  if (m.method === "mcp/call") {
    const c = m.params.lifecycle && m.params.lifecycle.connection;
    if (m.params.tool === "boom") return ok({ isError: true, content: [{ type: "text", text: "炸了" }] });
    return ok({ content: [{ type: "text", text: JSON.stringify({ tool: m.params.tool, args: m.params.arguments, host: c && c.host, user: c && c.username }) }] });
  }
  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no method" } });
});
`;

let tmp: string;
let store: ConnectionStore;
const hosts: PluginHost[] = [];

function install(id: string, opts: { provider?: boolean; mcp?: boolean } = {}) {
  const dir = path.join(tmp, "plugins", id, "versions", "1.0.0");
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "s.js"), SIDECAR);
  fs.writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({
      id,
      name: id,
      version: "1.0.0",
      permissions: [],
      entrypoints: { backend: { executable: "bin/s.js" } },
      contributions: [...(opts.provider ? [{ type: "connection-provider", database_type: "xxl-job-dbx-plugin", id: `${id}.c` }] : []), ...(opts.mcp === false ? [] : [{ type: "mcp", id: `${id}.mcp` }])],
    }),
  );
}

function mk(): PluginHost {
  const h = new PluginHost({
    localDir: path.join(tmp, "plugins"),
    dataRoot: path.join(tmp, "data"),
    consentFile: path.join(tmp, "consent.json"),
    launch: exe => ({ command: process.execPath, args: [exe] }),
    connections: {
      list: kind => store.list().filter(c => c.kind === kind),
      get: id => {
        const conn = store.get(id);
        return conn && { conn, secrets: store.secretsOf(id) };
      },
    },
  });
  hosts.push(h);
  return h;
}

const xxl = (name: string): ConnectionInput => ({
  kind: "xxljob",
  name,
  env: "生产",
  machine: "m1",
  fields: { ...DEFAULTS.xxljob, url: "https://job.example.com:8443/xxl-job-admin/", username: "admin" },
  secrets: { password: "pw-123" },
});

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "plugai-"));
  store = new ConnectionStore(path.join(tmp, "home"));
});
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.stopAll();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const ctx = () => ({ signal: new AbortController().signal, root: tmp });

describe("让 AI 使用插件：不挑插件", () => {
  it("只列出声明了 mcp 贡献且有后台程序的插件", () => {
    install("io.t.a");
    install("io.t.nomcp", { mcp: false });
    const h = mk();
    expect(h.aiPlugins().map(p => p.id)).toEqual(["io.t.a"]);
  });

  it("没确认信任不启动后台；默认不开，开了才把工具交给模型", async () => {
    install("io.t.a");
    const h = mk();
    const ai = new PluginAi(() => h, path.join(tmp, "ai.json"));
    expect((await ai.list())[0]).toMatchObject({ trusted: false, enabled: false, tools: [] });
    ai.setEnabled("io.t.a", true);
    await ai.prepare();
    expect(ai.tools()).toEqual([]); // 还没信任
    h.trust("io.t.a");
    await ai.prepare();
    const names = ai.tools().map(t => t.name);
    expect(names).toEqual(["plugin__io_t_a__list_things", "plugin__io_t_a__do_it"]);
    ai.setEnabled("io.t.a", false);
    expect(ai.tools()).toEqual([]);
  });

  it("只读工具是 read，其余是 write；调用结果拼成文本", async () => {
    install("io.t.a");
    const h = mk();
    h.trust("io.t.a");
    const ai = new PluginAi(() => h, path.join(tmp, "ai.json"));
    ai.setEnabled("io.t.a", true);
    await ai.prepare();
    const [list, doit] = ai.tools();
    expect(list.risk).toBe("read");
    expect(doit.risk).toBe("write");
    const out = JSON.parse(await doit.run({ id: 7 }, ctx()));
    expect(out).toMatchObject({ tool: "do_it", args: { id: 7 } });
    expect(list.jsonSchema).toMatchObject({ type: "object" });
  });

  it("设置页列表带工具与只读标记", async () => {
    install("io.t.a");
    const h = mk();
    h.trust("io.t.a");
    const ai = new PluginAi(() => h, path.join(tmp, "ai.json"));
    const [p] = await ai.list();
    expect(p.tools).toEqual([
      { name: "list_things", description: "列出东西", readOnly: true },
      { name: "do_it", description: "会改东西", readOnly: false },
    ]);
  });

  it("连接类插件：自动把「设置 → 连接」里的连接交给插件；多个要指定；连接不进模型的参数", async () => {
    install("io.t.xxl", { provider: true });
    const a = store.save(xxl("调度-生产"));
    const h = mk();
    h.trust("io.t.xxl");
    const ai = new PluginAi(() => h, path.join(tmp, "ai.json"));
    ai.setEnabled("io.t.xxl", true);
    await ai.prepare();
    const t = ai.tools()[0];
    expect((t.jsonSchema as any).properties.connection.type).toBe("string");
    // 只有一个连接：不用指定
    const one = JSON.parse(await t.run({ limit: 3 }, ctx()));
    expect(one).toMatchObject({ tool: "list_things", args: { limit: 3 }, host: "job.example.com", user: "admin" });
    expect(JSON.stringify(one.args)).not.toContain("connection");
    // 两个连接：必须指定
    store.save({ ...xxl("调度-测试"), env: "测试" });
    await ai.prepare();
    const t2 = ai.tools()[0];
    expect(await t2.run({}, ctx())).toMatch(/有多个连接/);
    expect(JSON.parse(await t2.run({ connection: "调度-测试" }, ctx())).tool).toBe("list_things");
    expect(await t2.run({ connection: "没有的" }, ctx())).toMatch(/没有叫「没有的」/);
    // 秘密只在主进程交给插件，不会出现在工具描述里
    expect(JSON.stringify(t2.jsonSchema) + t2.description).not.toContain("pw-123");
    void a;
  });

  it("连接类插件没有可用连接时给出明确提示", async () => {
    install("io.t.xxl", { provider: true });
    const h = mk();
    h.trust("io.t.xxl");
    const ai = new PluginAi(() => h, path.join(tmp, "ai.json"));
    ai.setEnabled("io.t.xxl", true);
    await ai.prepare();
    expect(await ai.tools()[0].run({}, ctx())).toMatch(/还没有可用的连接/);
  });

  it("结果格式化：文本块、错误标记、超长截断", () => {
    expect(formatToolResult({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] })).toBe("a\nb");
    expect(formatToolResult({ isError: true, content: [{ type: "text", text: "炸了" }] })).toBe("错误：炸了");
    expect(formatToolResult({ content: [{ type: "text", text: "x".repeat(200_000) }] })).toContain("已截断");
  });
});

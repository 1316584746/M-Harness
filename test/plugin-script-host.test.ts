import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PluginHost } from "../desktop/main/pluginhost";

// 后台程序是 .cjs 脚本（跨平台 Node 插件）：不指定 launch 也要能用内置 Node 跑起来
const SIDECAR = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = o => process.stdout.write(JSON.stringify(o) + "\\n");
rl.on("line", l => {
  const m = JSON.parse(l);
  if (m.method === "plugin/initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, plugin: { id: process.env.DBX_PLUGIN_ID } } });
  if (m.method === "hi") return send({ jsonrpc: "2.0", id: m.id, result: { pid: process.pid, dir: process.env.DBX_PLUGIN_DATA_DIR } });
});
`;

let tmp: string;
let host: PluginHost;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scripthost-"));
  const dir = path.join(tmp, "plugins", "js-plugin", "versions", "1.0.0");
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.mkdirSync(path.join(dir, "ui"), { recursive: true });
  fs.writeFileSync(path.join(dir, "bin", "backend.cjs"), SIDECAR);
  fs.writeFileSync(path.join(dir, "ui", "index.html"), "<html><head></head><body>x</body></html>");
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id: "js-plugin", name: "JS", version: "1.0.0", permissions: [], entrypoints: { backend: { executable: "bin/backend.cjs" }, ui: { root: "ui", entry: "ui/index.html" } } }));
  host = new PluginHost({ localDir: path.join(tmp, "plugins"), dataRoot: path.join(tmp, "data"), consentFile: path.join(tmp, "consent.json") });
});
afterAll(async () => {
  await host.stopAll();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("脚本型后台程序（.js / .mjs / .cjs）", () => {
  it("没有 launch 也用内置 Node 运行，一个包三个系统通用", async () => {
    expect(host.trust("js-plugin")).toBe(true);
    const r = await host.request("js-plugin", "backend.invoke", { method: "hi", params: {} });
    expect(r.ok).toBe(true);
    expect((r.result as any).pid).toBeGreaterThan(0);
    expect((r.result as any).dir).toContain("js-plugin");
  });
});

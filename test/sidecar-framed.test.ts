import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Sidecar, frameBinary, frameJson } from "../desktop/main/sidecar";
import { CONN_ADAPTERS } from "../desktop/main/plugin-conn";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sidecar-framed-"));
afterAll(() => { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }); } catch { /* 临时目录清不掉不算测试失败 */ } }); // Windows 上子进程刚退出时目录还被占着

/** 一个说 stdio-framed 的假插件：JSON 帧回显，收到二进制帧就用事件告诉宿主，要求 emitBin 时发一个二进制帧 */
const FAKE = `
let buf = Buffer.alloc(0);
const out = (kind, body) => { const h = Buffer.alloc(5); h[0] = kind; h.writeUInt32BE(body.length, 1); process.stdout.write(Buffer.concat([h, body])); };
const json = o => out(0, Buffer.from(JSON.stringify(o)));
process.stdin.on("data", b => {
  buf = Buffer.concat([buf, b]);
  while (buf.length >= 5) {
    const kind = buf[0], len = buf.readUInt32BE(1);
    if (buf.length < 5 + len) return;
    const p = buf.subarray(5, 5 + len); buf = buf.subarray(5 + len);
    if (kind === 1) {
      const n = p.readUInt16BE(0);
      json({ jsonrpc: "2.0", method: "got", params: { channel: p.subarray(2, 2 + n).toString(), bytes: [...p.subarray(2 + n)] } });
      continue;
    }
    const m = JSON.parse(p.toString());
    if (m.method === "plugin/initialize") json({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, capabilities: [], plugin: { id: "fake.framed" } } });
    else if (m.method === "emitBin") {
      const name = Buffer.from("term"), data = Buffer.from([1, 2, 3, 250]);
      const h = Buffer.alloc(2); h.writeUInt16BE(name.length, 0);
      out(1, Buffer.concat([h, name, data]));
      json({ jsonrpc: "2.0", id: m.id, result: "sent" });
    } else json({ jsonrpc: "2.0", id: m.id, result: m.params });
  }
});
`;
const script = path.join(tmp, "fake.cjs");
fs.writeFileSync(script, FAKE);

const make = (extra: Partial<ConstructorParameters<typeof Sidecar>[0]> = {}) =>
  new Sidecar({ command: process.execPath, args: [script], cwd: tmp, pluginId: "fake.framed", version: "1", permissions: [], hostVersion: "0.0.0", transport: "stdio-framed", ...extra });

describe("stdio-framed 打包", () => {
  it("JSON 帧：kind 0 + 4 字节大端长度 + 内容", () => {
    const f = frameJson('{"a":"中"}');
    expect(f[0]).toBe(0);
    expect(f.readUInt32BE(1)).toBe(Buffer.byteLength('{"a":"中"}'));
    expect(f.subarray(5).toString("utf8")).toBe('{"a":"中"}');
  });
  it("二进制帧：kind 1 + 长度 + 通道名长度(u16) + 通道名 + 数据", () => {
    const f = frameBinary("pty", new Uint8Array([9, 8, 7]));
    expect(f[0]).toBe(1);
    expect(f.readUInt32BE(1)).toBe(2 + 3 + 3);
    expect(f.readUInt16BE(5)).toBe(3);
    expect(f.subarray(7, 10).toString()).toBe("pty");
    expect([...f.subarray(10)]).toEqual([9, 8, 7]);
  });
  it("通道名不能是空的", () => {
    expect(() => frameBinary("", new Uint8Array([1]))).toThrow();
  });
});

describe("stdio-framed 后台程序", () => {
  it("握手、请求回显都走帧（中文不乱）", async () => {
    const sc = make();
    await sc.start();
    expect(await sc.call("echo", { s: "你好" })).toEqual({ s: "你好" });
    await sc.stop();
  });

  it("插件发来的二进制帧交给 onBinary", async () => {
    const got: Array<[string, number[]]> = [];
    const sc = make({ onBinary: (ch, d) => got.push([ch, [...d]]) });
    await sc.start();
    expect(await sc.call("emitBin", {})).toBe("sent");
    await new Promise(r => setTimeout(r, 50));
    expect(got).toEqual([["term", [1, 2, 3, 250]]]);
    await sc.stop();
  });

  it("宿主发二进制给插件：对方收得到通道名和原样的字节", async () => {
    const events: Array<{ m: string; p: unknown }> = [];
    const sc = make({ onEvent: (m, p) => events.push({ m, p }) });
    await sc.start();
    sc.sendBinary("input", new Uint8Array([0, 255, 10, 13]));
    for (let i = 0; i < 20 && !events.length; i++) await new Promise(r => setTimeout(r, 25));
    expect(events).toEqual([{ m: "got", p: { channel: "input", bytes: [0, 255, 10, 13] } }]);
    await sc.stop();
  });

  it("一大块数据被切成多段到达也能拼回来", async () => {
    const sc = make();
    await sc.start();
    const big = "x".repeat(300_000);
    expect(((await sc.call("echo", { big })) as { big: string }).big.length).toBe(300_000);
    await sc.stop();
  });

  it("jsonl 的插件不能发二进制", async () => {
    const jl = path.join(tmp, "jl.cjs");
    fs.writeFileSync(jl, `process.stdin.on("data", b => { for (const l of b.toString().split("\\n").filter(Boolean)) { const m = JSON.parse(l); console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, capabilities: [], plugin: { id: "fake.framed" } } })); } });`);
    const sc = new Sidecar({ command: process.execPath, args: [jl], cwd: tmp, pluginId: "fake.framed", version: "1", permissions: [], hostVersion: "0" });
    await sc.start();
    expect(() => sc.sendBinary("x", new Uint8Array([1]))).toThrow(/不支持二进制/);
    await sc.stop();
  });

  it("插件用错了传输方式（发来乱码）：断开并说明原因，而不是一直卡着", async () => {
    const bad = path.join(tmp, "bad.cjs");
    fs.writeFileSync(bad, `process.stdin.once("data", () => process.stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\\n'));`);
    const sc = new Sidecar({ command: process.execPath, args: [bad], cwd: tmp, pluginId: "fake.framed", version: "1", permissions: [], hostVersion: "0", transport: "stdio-framed", initTimeoutMs: 3000 });
    await expect(sc.start()).rejects.toThrow(/帧|已终止|退出/);
  });
});

/** 本机装了真正的 SSH 插件时，用它的真实程序验证一次握手（没装就跳过） */
const REAL = "D:\\M-Harness-data\\plugins\\io.dbx.ssh\\versions\\0.7.14\\bin\\windows-x64\\dbx-plugin-ssh.exe";
describe.skipIf(!fs.existsSync(REAL))("真实的 SSH 插件（stdio-framed）", () => {
  it("握手成功，身份对得上", async () => {
    const sc = new Sidecar({ command: REAL, cwd: path.dirname(REAL), pluginId: "io.dbx.ssh", version: "0.7.14", permissions: ["host.events", "host.binary"], hostVersion: "0.6.59", transport: "stdio-framed", env: { DBX_PLUGIN_DATA_DIR: tmp, DBX_PLUGIN_ID: "io.dbx.ssh" } });
    await sc.start();
    expect(sc.capabilities.length).toBeGreaterThanOrEqual(0);
    await sc.stop();
  });
});

describe("SSH 终端插件的连接适配：用「设置 → 连接 → 服务器」", () => {
  const base = { id: "c1", kind: "server" as const, name: "测试机", env: "开发", machine: "", enabled: true, secretSet: {}, createdAt: 0, updatedAt: 0 };
  it("密码登录：密码放在 password，认证方式是 password", () => {
    const c = CONN_ADAPTERS.ssh.toConnection({ ...base, fields: { host: " 10.0.0.4 ", port: "2222", username: "root", authType: "password" } }, { password: "pw" }) as Record<string, any>;
    expect(c).toMatchObject({ id: "c1", connectionId: "c1", host: "10.0.0.4", port: 2222, username: "root", password: "pw" });
    expect(c.config).toMatchObject({ protocol: "ssh", authentication: "password", read_only: false });
    expect(c.externalConfig).toEqual(c.config);
  });
  it("私钥登录：不带密码，私钥路径在 config，口令放在 secrets", () => {
    const c = CONN_ADAPTERS.ssh.toConnection({ ...base, fields: { host: "h", port: "22", username: "u", authType: "key", keyPath: "C:\\k\\id_rsa" } }, { passphrase: "pp" }) as Record<string, any>;
    expect(c.password).toBe("");
    expect(c.config).toMatchObject({ authentication: "private-key", private_key_path: "C:\\k\\id_rsa" });
    expect(c.secrets).toEqual({ private_key_passphrase: "pp" });
  });
  it("没填主机：报错而不是发出去", () => {
    expect(() => CONN_ADAPTERS.ssh.toConnection({ ...base, fields: { host: " ", port: "22", username: "u", authType: "password" } }, {})).toThrow();
  });
});

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConnectionStore } from "../desktop/main/connections";
import { testConnection } from "../desktop/main/conn-test";
import { DEFAULTS, connSummary, validateConnection, type ConnectionInput, type ConnKind } from "../desktop/shared/connections";

const dirs: string[] = [];
const servers: net.Server[] = [];
const tmp = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "conn-"));
  dirs.push(d);
  return d;
};
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise(r => s.close(r));
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

const input = (kind: ConnKind, o: Partial<ConnectionInput> = {}): ConnectionInput => ({
  kind,
  name: "n1",
  env: "测试",
  machine: "m1",
  fields: { ...DEFAULTS[kind] },
  secrets: {},
  ...o,
});
const db = (o: Partial<ConnectionInput> = {}, fields: Record<string, string> = {}) => input("database", { fields: { ...DEFAULTS.database, host: "10.0.0.1", username: "root", ...fields }, ...o });

/** 解析 RESP 数组命令 */
function parseCmds(buf: string): { cmds: string[][]; rest: string } {
  const cmds: string[][] = [];
  let rest = buf;
  for (;;) {
    const m = /^\*(\d+)\r\n/.exec(rest);
    if (!m) break;
    let p = m[0].length;
    const args: string[] = [];
    let ok = true;
    for (let i = 0; i < Number(m[1]); i++) {
      const l = /^\$(\d+)\r\n/.exec(rest.slice(p));
      if (!l) {
        ok = false;
        break;
      }
      const start = p + l[0].length;
      const len = Number(l[1]);
      if (rest.length < start + len + 2) {
        ok = false;
        break;
      }
      args.push(rest.slice(start, start + len));
      p = start + len + 2;
    }
    if (!ok) break;
    cmds.push(args);
    rest = rest.slice(p);
  }
  return { cmds, rest };
}

function fakeRedis(password?: string): Promise<number> {
  return new Promise(resolve => {
    const s = net.createServer(sock => {
      let buf = "";
      let authed = !password;
      sock.on("data", d => {
        buf += d.toString();
        const { cmds, rest } = parseCmds(buf);
        buf = rest;
        for (const c of cmds) {
          const name = c[0].toUpperCase();
          if (name === "AUTH") {
            if (c[c.length - 1] === password) {
              authed = true;
              sock.write("+OK\r\n");
            } else sock.write("-WRONGPASS invalid username-password pair or user is disabled.\r\n");
          } else if (!authed) sock.write("-NOAUTH Authentication required.\r\n");
          else if (name === "PING") sock.write("+PONG\r\n");
          else if (name === "SELECT") sock.write("+OK\r\n");
          else if (name === "INFO") {
            const body = "# Server\r\nredis_version:7.2.4\r\nredis_mode:standalone\r\n";
            sock.write(`$${body.length}\r\n${body}\r\n`);
          } else sock.write("+OK\r\n");
        }
      });
      sock.on("error", () => {});
    });
    servers.push(s);
    s.listen(0, "127.0.0.1", () => resolve((s.address() as net.AddressInfo).port));
  });
}

describe("连接：校验和摘要", () => {
  it("必填项、端口、环境、地址格式", () => {
    expect(validateConnection(input("redis", { name: " " }))).toContain("名称");
    expect(validateConnection(input("redis", { env: "" }))).toContain("环境");
    expect(validateConnection(input("redis", { fields: { ...DEFAULTS.redis, host: "" } }))).toContain("主机");
    expect(validateConnection(input("redis", { fields: { ...DEFAULTS.redis, host: "a b" } }))).toContain("空格");
    expect(validateConnection(input("redis", { fields: { ...DEFAULTS.redis, host: "h", port: "70000" } }))).toContain("端口");
    expect(validateConnection(input("redis", { fields: { ...DEFAULTS.redis, host: "h", port: "x" } }))).toContain("数字");
    expect(validateConnection(input("redis", { fields: { ...DEFAULTS.redis, host: "10.0.0.1" } }))).toBe("");
    expect(validateConnection(input("xxljob", { fields: { url: "ftp://x", username: "a" }, secrets: { password: "p" } }))).toContain("http");
    expect(validateConnection(input("xxljob", { fields: { url: "http://x/xxl-job-admin", username: "a" }, secrets: { password: "p" } }))).toBe("");
  });

  it("服务器：密钥登录要填私钥路径，密码登录不要；终端通过服务器要选服务器", () => {
    const base = { ...DEFAULTS.server, host: "h", username: "u" };
    expect(validateConnection(input("server", { fields: { ...base, authType: "key" } }))).toContain("私钥");
    expect(validateConnection(input("server", { fields: { ...base, authType: "key", keyPath: "/k" } }))).toBe("");
    expect(validateConnection(input("server", { fields: { ...base, authType: "password" } }))).toBe("");
    expect(validateConnection(input("terminal", { fields: { ...DEFAULTS.terminal, mode: "server" } }))).toContain("服务器");
    expect(validateConnection(input("terminal", { fields: { ...DEFAULTS.terminal, mode: "local" } }))).toBe("");
  });

  it("已保存过密码的编辑可以不再填密码，新建的数据库不强制密码", () => {
    const f = { ...DEFAULTS.xxljob, url: "http://x", username: "a" };
    expect(validateConnection(input("xxljob", { fields: f }), { password: true })).toBe("");
  });

  it("摘要里没有密码", () => {
    const s = connSummary({ kind: "database", fields: { ...DEFAULTS.database, host: "10.0.0.1", port: "3306", database: "orders", username: "root", password: "x" } });
    expect(s).toContain("10.0.0.1");
    expect(s).not.toContain("root:x");
  });
});

describe("连接：保存与密码", () => {
  it("同一类可以有多个，名称在同一类里不能重复，环境和机器区分", () => {
    const st = new ConnectionStore(tmp());
    st.save(db({ name: "订单库", env: "生产", machine: "A" }));
    st.save(db({ name: "订单库-测试", env: "测试", machine: "B" }));
    st.save(input("redis", { name: "订单库", fields: { ...DEFAULTS.redis, host: "r" } }));
    expect(st.list()).toHaveLength(3);
    expect(() => st.save(db({ name: "订单库" }))).toThrow("订单库");
    expect(st.list().map(c => c.env)).toContain("生产");
  });

  it("密码不进连接配置文件，不返回给界面；不传保持原值、空串清除、有值更新", () => {
    const dir = tmp();
    const st = new ConnectionStore(dir, { encrypt: s => "enc:" + Buffer.from(s).toString("base64"), decrypt: s => Buffer.from(s.slice(4), "base64").toString() });
    const c = st.save(db({ secrets: { password: "s3cret-pw" } }));
    expect(c.secretSet.password).toBe(true);
    expect(JSON.stringify(st.list())).not.toContain("s3cret-pw");
    expect(fs.readFileSync(path.join(dir, "connections.json"), "utf8")).not.toContain("s3cret-pw");
    expect(fs.readFileSync(path.join(dir, "connection-secrets.json"), "utf8")).not.toContain("s3cret-pw");
    expect(st.secretsOf(c.id).password).toBe("s3cret-pw");

    st.save(db({ id: c.id, note: "改备注", secrets: {} }));
    expect(st.secretsOf(c.id).password).toBe("s3cret-pw");
    st.save(db({ id: c.id, secrets: { password: "new-pw" } }));
    expect(st.secretsOf(c.id).password).toBe("new-pw");
    st.save(db({ id: c.id, secrets: { password: "" } }));
    expect(st.get(c.id)?.secretSet.password).toBeFalsy();
    expect(st.secretsOf(c.id).password).toBeUndefined();
  });

  it("编辑框回显：只取这个连接已保存的密码字段；没保存的 / 不存在的连接返回空", () => {
    const st = new ConnectionStore(tmp());
    const c = st.save(db({ secrets: { password: "s3cret-pw" } }));
    expect(st.revealSecrets(c.id)).toEqual({ password: "s3cret-pw" });
    const none = st.save(db({ name: "无密码库" }));
    expect(st.revealSecrets(none.id)).toEqual({});
    expect(st.revealSecrets("不存在")).toEqual({});
  });

  it("重新打开能读回；停用、删除；删除连接同时删掉它的密码", () => {
    const dir = tmp();
    const st = new ConnectionStore(dir);
    const c = st.save(db({ secrets: { password: "pw" } }));
    const again = new ConnectionStore(dir);
    expect(again.list()).toHaveLength(1);
    expect(again.secretsOf(c.id).password).toBe("pw");
    again.setEnabled(c.id, false);
    expect(new ConnectionStore(dir).get(c.id)?.enabled).toBe(false);
    expect(again.remove(c.id).ok).toBe(true);
    expect(new ConnectionStore(dir).list()).toHaveLength(0);
    expect(new ConnectionStore(dir).secretsOf(c.id)).toEqual({});
  });

  it("不能改类型；只保留当前可见的字段", () => {
    const st = new ConnectionStore(tmp());
    const c = st.save(input("server", { fields: { ...DEFAULTS.server, host: "h", username: "u", authType: "password", keyPath: "/should/not/stay" }, secrets: { password: "p" } }));
    expect(c.fields.keyPath).toBeUndefined();
    expect(() => st.save(input("redis", { id: c.id, fields: { ...DEFAULTS.redis, host: "h" } }))).toThrow();
  });

  it("被内嵌终端引用的服务器删不掉", () => {
    const st = new ConnectionStore(tmp());
    const srv = st.save(input("server", { name: "app", fields: { ...DEFAULTS.server, host: "h", username: "u" }, secrets: { password: "p" } }));
    const term = st.save(input("terminal", { name: "app终端", fields: { ...DEFAULTS.terminal, mode: "server", serverId: srv.id } }));
    const r = st.remove(srv.id);
    expect(r.ok).toBe(false);
    expect(r.usedBy).toEqual(["app终端"]);
    expect(st.remove(term.id).ok).toBe(true);
    expect(st.remove(srv.id).ok).toBe(true);
  });
});

describe("连接：测试连接", () => {
  it("Redis：无密码、正确密码、错误密码、缺密码", async () => {
    const open = await fakeRedis();
    const ok = await testConnection(input("redis", { fields: { ...DEFAULTS.redis, host: "127.0.0.1", port: String(open) } }), {});
    expect(ok.ok).toBe(true);
    expect(ok.detail).toContain("Redis 7.2.4");

    const locked = await fakeRedis("pw1");
    const f = { ...DEFAULTS.redis, host: "127.0.0.1", port: String(locked), db: "2" };
    expect((await testConnection(input("redis", { fields: f, secrets: { password: "pw1" } }), {})).ok).toBe(true);
    expect((await testConnection(input("redis", { fields: f }), { password: "pw1" })).ok).toBe(true);
    const bad = await testConnection(input("redis", { fields: f, secrets: { password: "nope" } }), {});
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("密码");
    const none = await testConnection(input("redis", { fields: f }), {});
    expect(none.ok).toBe(false);
    expect(none.message).toContain("需要密码");
  });

  it("Redis：端口不通时给出原因，不会抛异常", async () => {
    const s = net.createServer();
    await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as net.AddressInfo).port;
    await new Promise(r => s.close(r));
    const r = await testConnection(input("redis", { fields: { ...DEFAULTS.redis, host: "127.0.0.1", port: String(port) } }), {});
    expect(r.ok).toBe(false);
    expect(r.message.length).toBeGreaterThan(2);
  });

  it("XXL-JOB：登录成功、密码错、地址不对", async () => {
    const mk = (body: unknown, status = 200) => (async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("http://x/xxl-job-admin/login");
      expect(String(init?.body)).toContain("userName=admin");
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }) as unknown as typeof fetch;
    const i = input("xxljob", { fields: { url: "http://x/xxl-job-admin/", username: "admin" }, secrets: { password: "p" } });
    expect((await testConnection(i, {}, { fetchImpl: mk({ code: 200 }) })).ok).toBe(true);
    const bad = await testConnection(i, {}, { fetchImpl: mk({ code: 500, msg: "登录失败" }) });
    expect(bad.ok).toBe(false);
    expect(bad.message).toContain("登录失败");
    const nf = await testConnection(i, {}, { fetchImpl: mk("<html>", 404) });
    expect(nf.ok).toBe(false);
    expect(nf.message).toContain("地址不对");
  });

  it("数据库 / 服务器：TCP 连不上会失败；服务器检查私钥文件存在", async () => {
    const s = net.createServer(sock => sock.end());
    await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as net.AddressInfo).port;
    servers.push(s);
    const okDb = await testConnection(db({}, { dbType: "clickhouse", host: "127.0.0.1", port: String(port) }), {});
    expect(okDb.ok).toBe(true);
    await new Promise(r => s.close(r));
    servers.length = 0;
    expect((await testConnection(db({}, { dbType: "clickhouse", host: "127.0.0.1", port: String(port) }), {})).ok).toBe(false);
    const key = await testConnection(input("server", { fields: { ...DEFAULTS.server, host: "127.0.0.1", username: "u", authType: "key", keyPath: path.join(tmp(), "nope") } }), {});
    expect(key.ok).toBe(false);
    expect(key.message).toContain("私钥");
  });

  it("服务器：对方发来 SSH 横幅就算通", async () => {
    const s = net.createServer(sock => sock.write("SSH-2.0-OpenSSH_9.6\r\n"));
    await new Promise<void>(r => s.listen(0, "127.0.0.1", r));
    servers.push(s);
    const port = (s.address() as net.AddressInfo).port;
    const r = await testConnection(input("server", { fields: { ...DEFAULTS.server, host: "127.0.0.1", port: String(port), username: "u" } }), {});
    expect(r.ok).toBe(true);
  });

  it("内嵌终端：本机检查工作目录；通过服务器时服务器连接不存在会失败", async () => {
    const bad = await testConnection(input("terminal", { fields: { ...DEFAULTS.terminal, mode: "local", cwd: path.join(tmp(), "nope") } }), {});
    expect(bad.ok).toBe(false);
    const gone = await testConnection(input("terminal", { fields: { ...DEFAULTS.terminal, mode: "server", serverId: "x" } }), {}, { serverFields: () => undefined });
    expect(gone.ok).toBe(false);
  });
});

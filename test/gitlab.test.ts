import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConnectionStore } from "../desktop/main/connections";
import { testConnection } from "../desktop/main/conn-test";
import { PluginHost } from "../desktop/main/pluginhost";
import { DEFAULTS, connSummary, validateConnection, type ConnectionInput } from "../desktop/shared/connections";

const gl = (o: Partial<ConnectionInput> = {}, fields: Record<string, string> = {}): ConnectionInput => ({
  kind: "gitlab",
  name: "测试 GitLab",
  env: "生产",
  machine: "",
  fields: { ...DEFAULTS.gitlab, url: "https://gitlab.example.com", ...fields },
  secrets: { token: "glpat-secret" },
  ...o,
});

describe("GitLab 连接：校验和摘要", () => {
  it("地址、令牌必填；地址不能带 /api/v4；账号密码方式要用户名和密码", () => {
    expect(validateConnection(gl())).toBe("");
    expect(validateConnection(gl({ secrets: {} }))).toContain("访问令牌");
    expect(validateConnection(gl({}, { url: "ftp://x" }))).toContain("http");
    expect(validateConnection(gl({}, { url: "https://g.com/api/v4" }))).toContain("/api/v4");
    expect(validateConnection(gl({ secrets: {} }, { authMethod: "password" }))).toContain("用户名");
    expect(validateConnection(gl({ secrets: { password: "p" } }, { authMethod: "password", username: "me" }))).toBe("");
    // 编辑时令牌留空 = 沿用已保存的
    expect(validateConnection(gl({ secrets: undefined }), { token: true })).toBe("");
  });

  it("摘要不含令牌", () => {
    const s = connSummary({ kind: "gitlab", fields: { ...DEFAULTS.gitlab, url: "https://g.com" } });
    expect(s).toBe("https://g.com · 访问令牌 · 只读");
    expect(connSummary({ kind: "gitlab", fields: { ...DEFAULTS.gitlab, url: "https://g.com", readOnly: "false", authMethod: "password", username: "me" } })).toBe("https://g.com · 账号 me");
  });
});

describe("GitLab 连接：测试", () => {
  const res = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  const mk = (fn: (url: string, init: RequestInit) => Response) => (async (u: string, init: RequestInit) => fn(String(u), init)) as unknown as typeof fetch;

  it("令牌正确：显示用户和版本；请求头带 PRIVATE-TOKEN，地址按子路径拼", async () => {
    const seen: Array<{ url: string; token: string | null }> = [];
    const f = mk((url, init) => {
      seen.push({ url, token: new Headers(init.headers).get("private-token") });
      return url.endsWith("/user") ? res(200, { username: "tester", name: "测试用户" }) : res(200, { version: "16.11.2" });
    });
    const r = await testConnection(gl({}, { url: "https://g.com/gitlab/" }), {}, { fetchImpl: f });
    expect(r).toMatchObject({ ok: true, message: expect.stringContaining("测试用户"), detail: "GitLab 16.11.2 · @tester" });
    expect(seen[0]).toEqual({ url: "https://g.com/gitlab/api/v4/user", token: "glpat-secret" });
  });

  it("令牌不对 / 权限不够 / 地址不是 GitLab，各给清楚的提示", async () => {
    expect((await testConnection(gl(), {}, { fetchImpl: mk(() => res(401, { message: "401 Unauthorized" })) })).message).toContain("令牌不对");
    expect((await testConnection(gl(), {}, { fetchImpl: mk(() => res(403, {})) })).message).toContain("权限");
    expect((await testConnection(gl(), {}, { fetchImpl: mk(() => res(404, "<html>")) })).message).toContain("子路径");
    expect((await testConnection(gl(), {}, { fetchImpl: mk(() => res(200, "<html>login</html>")) })).message).toContain("不是 GitLab");
  });

  it("编辑时令牌留空，用已保存的", async () => {
    let token: string | null = null;
    const f = mk((url, init) => ((token = new Headers(init.headers).get("private-token")), res(200, { username: "u" })));
    await testConnection(gl({ secrets: undefined }), { token: "saved-token" }, { fetchImpl: f });
    expect(token).toBe("saved-token");
  });

  it("账号密码：先换令牌再取用户；密码错给提示", async () => {
    const f = mk((url, init) => {
      if (url.endsWith("/oauth/token")) return String(init.body).includes("password=right") ? res(200, { access_token: "AT" }) : res(400, { error: "invalid_grant" });
      return new Headers(init.headers).get("authorization") === "Bearer AT" ? res(200, { username: "me" }) : res(401, {});
    });
    const pw = (p: string) => gl({ secrets: { password: p } }, { authMethod: "password", username: "me" });
    expect((await testConnection(pw("right"), {}, { fetchImpl: f })).ok).toBe(true);
    expect((await testConnection(pw("wrong"), {}, { fetchImpl: f })).message).toContain("账号或密码不对");
  });
});

// 假的 GitLab 插件后台：照真插件的约定——connection/connect 里读 host / port / external_config / api_token，没连过就报错
const SIDECAR = `
const rl = require("node:readline").createInterface({ input: process.stdin });
const send = o => process.stdout.write(JSON.stringify(o) + "\\n");
const sessions = new Map();
rl.on("line", l => {
  const m = JSON.parse(l);
  const ok = r => send({ jsonrpc: "2.0", id: m.id, result: r });
  const bad = s => send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: s } });
  if (m.method === "plugin/initialize") return ok({ protocolVersion: 1, plugin: { id: process.env.DBX_PLUGIN_ID }, capabilities: [] });
  if (m.method === "connection/connect") {
    const c = m.params.connection || {};
    if (!c.id) return bad("missing connection id");
    sessions.set(c.id, { host: c.host, port: c.port, scheme: (c.external_config || {}).scheme, base: (c.external_config || {}).base_path, auth: (c.external_config || {}).auth_method, ro: (c.external_config || {}).read_only, token: c.api_token, secretToken: (c.secrets || {}).token });
    return ok({ success: true });
  }
  if (m.method === "gitlab/whoami") {
    if (!m.params.connectionId) return bad("missing connectionId");
    const s = sessions.get(m.params.connectionId);
    return s ? ok(s) : bad("connection not found");
  }
  bad("no method");
});
`;

describe("GitLab 插件：用本软件的连接", () => {
  let tmp: string;
  let store: ConnectionStore;
  const hosts: PluginHost[] = [];
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gl-"));
    store = new ConnectionStore(path.join(tmp, "home"));
    const dir = path.join(tmp, "plugins", "io.t.gitlab", "versions", "1.0.0");
    fs.mkdirSync(path.join(dir, "ui"), { recursive: true });
    fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
    fs.writeFileSync(path.join(dir, "ui", "index.html"), "<html><head></head><body>x</body></html>");
    fs.writeFileSync(path.join(dir, "bin", "s.js"), SIDECAR);
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify({ id: "io.t.gitlab", name: "GitLab", version: "1.0.0", permissions: [], entrypoints: { backend: { executable: "bin/s.js" }, ui: { root: "ui", entry: "ui/index.html" } }, contributions: [{ type: "connection-provider", database_type: "gitlab", id: "io.t.gitlab.connection", workbench: "io.t.gitlab.workbench" }, { type: "workbench", id: "io.t.gitlab.workbench" }] }));
  });
  afterEach(async () => {
    for (const h of hosts.splice(0)) await h.stopAll();
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const mkHost = () => {
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
  };

  it("插件被识别成 GitLab 连接类；没有连接时可选列表为空（不再带着空连接去调后台）", () => {
    const h = mkHost();
    expect(h.list()[0].connKind).toBe("gitlab");
    expect(h.connectionsFor("io.t.gitlab")).toEqual([]);
  });

  it("用连接里的地址和令牌连上，后台拿到 host / port / external_config / 令牌", async () => {
    const h = mkHost();
    h.trust("io.t.gitlab");
    const c = store.save(gl({}, { url: "https://git.corp.local:8443/gitlab" }));
    expect(h.connectionsFor("io.t.gitlab").map(x => x.id)).toEqual([c.id]);
    const r = await h.request("io.t.gitlab", "backend.invoke", { method: "gitlab/whoami", params: { connectionId: c.id } });
    expect(r).toMatchObject({ ok: true, result: { host: "git.corp.local", port: 8443, scheme: "https", base: "/gitlab", auth: "token", ro: true, token: "glpat-secret", secretToken: "glpat-secret" } });
  });

  it("账号密码方式 / 关闭只读 / http 默认端口，都按连接设置传给后台", async () => {
    const h = mkHost();
    h.trust("io.t.gitlab");
    const c = store.save(gl({ name: "内网", secrets: { password: "pw" } }, { url: "http://10.0.0.5", authMethod: "password", username: "me", readOnly: "false" }));
    const r = await h.request("io.t.gitlab", "backend.invoke", { method: "gitlab/whoami", params: { connectionId: c.id } });
    expect(r).toMatchObject({ ok: true, result: { host: "10.0.0.5", port: 80, scheme: "http", auth: "password", ro: false, token: "" } });
  });
});


describe("GitLab：用「代码托管」里的令牌一键建连接", () => {
  it("没有令牌不能建；有令牌建出来的连接带着地址和令牌，重复点是更新而不是再建一个", async () => {
    const { Backend } = await import("../desktop/main/backend");
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "glhosts-"));
    fs.writeFileSync(path.join(home, "harness.config.json"), JSON.stringify({ defaultProvider: "x", providers: { x: { type: "openai-compat", baseURL: "http://127.0.0.1:1", apiKey: "k", model: "m" } }, gitHosts: { gitlab: { baseURL: "https://git.corp.local/gitlab/" } } }));
    const old = process.env.GITLAB_TOKEN;
    try {
      // 置空而不是删除：删了的话，读配置时会把项目目录里 .env 的真令牌又加载进来
      process.env.GITLAB_TOKEN = "";
      const b = new Backend(home, { send() {} });
      expect(b.gitlabHostsInfo()).toEqual({ hasToken: false, url: "https://git.corp.local/gitlab", exists: false });
      expect((b.connectionFromHosts()).ok).toBe(false);
      process.env.GITLAB_TOKEN = "glpat-from-env";
      const r = b.connectionFromHosts();
      expect(r.ok).toBe(true);
      expect(r.conn).toMatchObject({ kind: "gitlab", fields: { url: "https://git.corp.local/gitlab", authMethod: "token", readOnly: "true" }, secretSet: { token: true } });
      expect(JSON.stringify(r)).not.toContain("glpat-from-env");
      expect(b.connections.secretsOf(r.conn!.id).token).toBe("glpat-from-env");
      expect(b.gitlabHostsInfo().exists).toBe(true);
      process.env.GITLAB_TOKEN = "glpat-new";
      expect(b.connectionFromHosts().ok).toBe(true);
      expect(b.connectionList().filter(c => c.kind === "gitlab")).toHaveLength(1);
      expect(b.connections.secretsOf(r.conn!.id).token).toBe("glpat-new");
    } finally {
      if (old === undefined) delete process.env.GITLAB_TOKEN;
      else process.env.GITLAB_TOKEN = old;
      fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
});
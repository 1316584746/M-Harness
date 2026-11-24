import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { CONN_FIELDS, DEFAULTS, fieldVisible, isSecretField, type ConnTestResult, type ConnectionInput } from "../shared/connections";

/**
 * 测试连接：只做「能不能连上、对面是不是想要的服务」这类探测，不执行任何业务操作。
 *  - Redis：真的发 AUTH / SELECT / PING，并读出版本。
 *  - XXL-JOB：真的用账号密码登录调度中心。
 *  - 服务器：连 SSH 端口，读到 SSH 横幅。（不做登录，本软件没有内置 SSH 客户端）
 *  - 数据库：连端口；MySQL / PostgreSQL 会再识别协议。（不做登录，没有内置数据库驱动）
 *  - 内嵌终端：本机检查 shell 是否存在；通过服务器的，测那个服务器连接。
 */

const TIMEOUT = 8000;

const fail = (ms: number, message: string, detail?: string): ConnTestResult => ({ ok: false, ms, message, detail });

interface Probe {
  ok: boolean;
  ms: number;
  error?: string;
  data?: Buffer;
}

/** 连上 host:port；可选先发一段数据，再读第一段回包 */
function probe(host: string, port: number, o: { send?: Buffer; read?: boolean; tls?: boolean; timeout?: number } = {}): Promise<Probe> {
  return new Promise(resolve => {
    const t0 = Date.now();
    let done = false;
    const finish = (p: Omit<Probe, "ms">) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ ...p, ms: Date.now() - t0 });
    };
    const timer = setTimeout(() => finish({ ok: false, error: `连接超时（${Math.round((o.timeout ?? TIMEOUT) / 1000)} 秒）` }), o.timeout ?? TIMEOUT);
    const sock: net.Socket = o.tls ? tls.connect({ host, port, rejectUnauthorized: false, servername: net.isIP(host) ? undefined : host }) : net.connect({ host, port });
    sock.once(o.tls ? "secureConnect" : "connect", () => {
      if (o.send) sock.write(o.send);
      if (!o.read && !o.send) finish({ ok: true });
    });
    sock.once("data", d => finish({ ok: true, data: Buffer.from(d) }));
    sock.once("error", e => finish({ ok: false, error: friendly(e as NodeJS.ErrnoException) }));
    sock.once("close", () => finish({ ok: !!o.read ? false : true, error: o.read ? "对方没有返回数据就断开了" : undefined }));
  });
}

function friendly(e: NodeJS.ErrnoException): string {
  switch (e.code) {
    case "ECONNREFUSED":
      return "连接被拒绝（端口没有服务在监听，或被防火墙拦了）";
    case "ENOTFOUND":
      return "找不到这个主机名（检查拼写和 DNS）";
    case "EHOSTUNREACH":
    case "ENETUNREACH":
      return "网络不通，到不了这个地址";
    case "ETIMEDOUT":
      return "连接超时";
    case "ECONNRESET":
      return "连接被对方重置";
    default:
      return e.message;
  }
}

// ───────── Redis ─────────

const resp = (...args: string[]): string => `*${args.length}\r\n${args.map(a => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join("")}`;

/** 最小的 RESP 客户端：依次发命令，每条读一个完整回复（只处理 +、-、:、$ 几种） */
function redisSession(host: string, port: number, useTls: boolean, cmds: string[][]): Promise<{ replies: string[]; error?: string }> {
  return new Promise(resolve => {
    const replies: string[] = [];
    let buf = Buffer.alloc(0);
    let i = 0;
    let done = false;
    const finish = (error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      resolve({ replies, error });
    };
    const timer = setTimeout(() => finish(`连接超时（${TIMEOUT / 1000} 秒）`), TIMEOUT);
    const sock: net.Socket = useTls ? tls.connect({ host, port, rejectUnauthorized: false, servername: net.isIP(host) ? undefined : host }) : net.connect({ host, port });
    const send = () => sock.write(resp(...cmds[i]));
    sock.once(useTls ? "secureConnect" : "connect", send);
    sock.on("error", e => finish(friendly(e as NodeJS.ErrnoException)));
    sock.on("close", () => finish(replies.length < cmds.length ? "对方中途断开了连接" : undefined));
    sock.on("data", d => {
      buf = Buffer.concat([buf, d]);
      for (;;) {
        const r = parseReply(buf);
        if (!r) return;
        buf = buf.subarray(r.used);
        replies.push(r.text);
        if (r.text.startsWith("-")) return finish();
        if (++i >= cmds.length) return finish();
        send();
      }
    });
  });
}

function parseReply(b: Buffer): { text: string; used: number } | null {
  const nl = b.indexOf("\r\n");
  if (nl < 0) return null;
  const line = b.toString("utf8", 0, nl);
  if (line[0] === "$") {
    const n = Number(line.slice(1));
    if (n < 0) return { text: "$nil", used: nl + 2 };
    if (b.length < nl + 2 + n + 2) return null;
    return { text: `$${b.toString("utf8", nl + 2, nl + 2 + n)}`, used: nl + 2 + n + 2 };
  }
  return { text: line, used: nl + 2 };
}

async function testRedis(f: Record<string, string>, sec: Record<string, string>): Promise<ConnTestResult> {
  const t0 = Date.now();
  const cmds: string[][] = [];
  if (sec.password) cmds.push(f.username ? ["AUTH", f.username, sec.password] : ["AUTH", sec.password]);
  const db = Number(f.db || 0);
  if (db > 0) cmds.push(["SELECT", String(db)]);
  cmds.push(["PING"], ["INFO", "server"]);
  const r = await redisSession(f.host, Number(f.port), f.tls === "true", cmds);
  const ms = Date.now() - t0;
  const bad = r.replies.find(x => x.startsWith("-"));
  if (bad) {
    const msg = bad.slice(1);
    if (/WRONGPASS|invalid password|invalid username-password/i.test(msg)) return fail(ms, "密码或用户名不对");
    if (/NOAUTH|Authentication required/i.test(msg)) return fail(ms, "这个 Redis 需要密码，请填写密码");
    if (/no password is set|without any password/i.test(msg)) return fail(ms, "这个 Redis 没有设置密码，请把密码留空");
    if (/DB index is out of range/i.test(msg)) return fail(ms, `库号 ${db} 超出范围`);
    return fail(ms, `Redis 返回错误：${msg}`);
  }
  if (r.error && r.replies.length === 0) return fail(ms, r.error);
  const ping = r.replies[cmds.findIndex(c => c[0] === "PING")];
  if (ping !== "+PONG") return fail(ms, r.error ?? "对方没有按 Redis 协议回应，端口可能不是 Redis（如果开了 TLS，请勾选「使用 TLS」）");
  const info = r.replies[r.replies.length - 1] ?? "";
  const ver = /redis_version:([\w.-]+)/.exec(info)?.[1];
  const mode = /redis_mode:(\w+)/.exec(info)?.[1];
  return { ok: true, ms, message: "连接成功", detail: [ver && `Redis ${ver}`, mode, f.tls === "true" && "TLS"].filter(Boolean).join(" · ") };
}

// ───────── XXL-JOB ─────────

async function testXxl(f: Record<string, string>, sec: Record<string, string>, fetchImpl: typeof fetch): Promise<ConnTestResult> {
  const t0 = Date.now();
  const base = f.url.replace(/\/+$/, "").replace(/\/login$/, "");
  try {
    const res = await fetchImpl(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ userName: f.username, password: sec.password ?? "" }).toString(),
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const ms = Date.now() - t0;
    const text = await res.text();
    let j: { code?: number; msg?: string } | null = null;
    try {
      j = JSON.parse(text);
    } catch {
      /* 不是 JSON */
    }
    if (j && typeof j.code === "number") return j.code === 200 ? { ok: true, ms, message: "登录成功", detail: "xxl-job-admin" } : fail(ms, `登录失败：${j.msg || `错误码 ${j.code}`}`);
    if (res.status === 404) return fail(ms, "地址不对：这里没有 xxl-job-admin（检查是不是漏了 /xxl-job-admin 这一层）");
    if (res.status >= 300 && res.status < 400) return fail(ms, "地址被重定向了，请填最终的 xxl-job-admin 地址");
    return fail(ms, `这个地址看起来不是 xxl-job-admin（HTTP ${res.status}）`);
  } catch (e) {
    const ms = Date.now() - t0;
    const err = e as Error & { cause?: NodeJS.ErrnoException; name: string };
    if (err.name === "TimeoutError" || err.name === "AbortError") return fail(ms, `连接超时（${TIMEOUT / 1000} 秒）`);
    return fail(ms, err.cause ? friendly(err.cause) : err.message);
  }
}

// ───────── GitLab ─────────

/** 发一个请求；自签名证书（跳过校验）时用 node 自带的 https，否则用传进来的 fetch */
async function gitlabCall(fetchImpl: typeof fetch, url: string, init: { method?: string; headers?: Record<string, string>; body?: string }, insecure: boolean): Promise<{ status: number; text: string }> {
  if (insecure && url.startsWith("https:")) {
    const https = await import("node:https");
    return new Promise((resolve, reject) => {
      const r = https.request(url, { method: init.method ?? "GET", headers: init.headers, rejectUnauthorized: false, timeout: TIMEOUT }, res => {
        const chunks: Buffer[] = [];
        res.on("data", d => chunks.push(d));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
      });
      r.on("timeout", () => r.destroy(Object.assign(new Error("timeout"), { name: "TimeoutError" })));
      r.on("error", reject);
      r.end(init.body);
    });
  }
  const res = await fetchImpl(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(TIMEOUT) });
  return { status: res.status, text: await res.text() };
}

async function testGitlab(f: Record<string, string>, sec: Record<string, string>, fetchImpl: typeof fetch): Promise<ConnTestResult> {
  const t0 = Date.now();
  const base = f.url.trim().replace(/\/+$/, "");
  const insecure = f.insecureSkipVerify === "true";
  try {
    const headers: Record<string, string> = { accept: "application/json" };
    if (f.authMethod === "password") {
      const body = new URLSearchParams({ grant_type: "password", username: f.username ?? "", password: sec.password ?? "", scope: "api" }).toString();
      const tok = await gitlabCall(fetchImpl, `${base}/oauth/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" }, body }, insecure);
      if (tok.status === 400 || tok.status === 401) return fail(Date.now() - t0, "账号或密码不对（开了两步验证的账号不能用密码，请改用访问令牌）");
      let access = "";
      try {
        access = JSON.parse(tok.text).access_token ?? "";
      } catch {
        /* 不是 JSON */
      }
      if (!access) return fail(Date.now() - t0, tok.status === 404 ? "地址不对：这里没有 GitLab" : `密码登录失败（HTTP ${tok.status}）`);
      headers.authorization = `Bearer ${access}`;
    } else {
      if (!sec.token) return fail(0, "请填写访问令牌");
      headers["private-token"] = sec.token;
    }
    const me = await gitlabCall(fetchImpl, `${base}/api/v4/user`, { headers }, insecure);
    const ms = Date.now() - t0;
    if (me.status === 401) return fail(ms, "访问令牌不对或已过期");
    if (me.status === 403) return fail(ms, "令牌没有权限（需要 api 或 read_api）");
    if (me.status >= 300 && me.status < 400) return fail(ms, "地址被重定向了，请填最终的 GitLab 地址（注意 http 和 https）");
    let u: { username?: string; name?: string } | null = null;
    try {
      u = JSON.parse(me.text);
    } catch {
      /* 不是 JSON */
    }
    if (me.status === 200 && u?.username) {
      let ver = "";
      try {
        ver = JSON.parse((await gitlabCall(fetchImpl, `${base}/api/v4/version`, { headers }, insecure)).text).version ?? "";
      } catch {
        /* 取不到版本不影响 */
      }
      return { ok: true, ms, message: `连接成功，当前用户 ${u.name || u.username}`, detail: `GitLab${ver ? ` ${ver}` : ""} · @${u.username}` };
    }
    if (me.status === 404) return fail(ms, "地址不对：这里没有 GitLab 接口（检查是不是漏了子路径，比如 /gitlab）");
    return fail(ms, `这个地址看起来不是 GitLab（HTTP ${me.status}）`);
  } catch (e) {
    const ms = Date.now() - t0;
    const err = e as Error & { cause?: NodeJS.ErrnoException; name: string; code?: string };
    if (err.name === "TimeoutError" || err.name === "AbortError") return fail(ms, `连接超时（${TIMEOUT / 1000} 秒）`);
    if (/self[- ]signed|certificate|UNABLE_TO_VERIFY|CERT_/i.test(String(err.code ?? err.cause?.code ?? err.message))) return fail(ms, "证书不被信任（自签名证书）。如果确认是内网自己的 GitLab，可以打开「跳过 TLS 证书校验」");
    return fail(ms, err.cause ? friendly(err.cause) : err.code ? friendly(err as NodeJS.ErrnoException) : err.message);
  }
}

// ───────── 服务器 / 数据库 ─────────

async function testSsh(f: Record<string, string>): Promise<ConnTestResult> {
  const p = await probe(f.host, Number(f.port), { read: true });
  if (!p.ok) return fail(p.ms, p.error ?? "连接失败");
  const banner = p.data?.toString("latin1").split(/\r?\n/)[0] ?? "";
  if (!banner.startsWith("SSH-")) return fail(p.ms, "端口通了，但对方不是 SSH 服务", banner.slice(0, 60));
  return { ok: true, ms: p.ms, message: "端口可达，SSH 服务正常（只检查了端口，账号密码要打开终端才会验证）", detail: banner.replace(/^SSH-[\d.]+-/, "") };
}

const PG_SSL_REQUEST = Buffer.from([0, 0, 0, 8, 4, 210, 22, 47]);

async function testDatabase(f: Record<string, string>, sec: Record<string, string> = {}, login?: TestDeps["dbLogin"]): Promise<ConnTestResult> {
  const port = Number(f.port);
  if (login && (f.dbType === "mysql" || f.dbType === "postgresql")) {
    const t0 = Date.now();
    try {
      const v = await login(f, sec);
      return { ok: true, ms: Date.now() - t0, message: "登录成功", detail: `${f.dbType === "mysql" ? "MySQL" : "PostgreSQL"} ${v}` };
    } catch (e) {
      return fail(Date.now() - t0, e instanceof Error ? e.message : String(e));
    }
  }
  if (f.dbType === "mysql") {
    const p = await probe(f.host, port, { read: true });
    if (!p.ok) return fail(p.ms, p.error ?? "连接失败");
    const b = p.data!;
    // MySQL 握手包：4 字节包头 + 协议号 0x0a + 以 0 结尾的版本串；出错包协议号是 0xff
    if (b.length > 6 && b[4] === 0x0a) return { ok: true, ms: p.ms, message: "端口可达，MySQL 服务正常", detail: `MySQL ${b.toString("latin1", 5, b.indexOf(0, 5))}` };
    if (b.length > 6 && b[4] === 0xff) return fail(p.ms, "MySQL 拒绝了这个来源", b.toString("latin1", 7).slice(0, 80));
    return fail(p.ms, "端口通了，但对方不像 MySQL");
  }
  if (f.dbType === "postgresql") {
    const p = await probe(f.host, port, { send: PG_SSL_REQUEST, read: true });
    if (!p.ok) return fail(p.ms, p.error ?? "连接失败");
    const c = p.data![0];
    if (c === 0x53 || c === 0x4e) return { ok: true, ms: p.ms, message: "端口可达，PostgreSQL 服务正常", detail: c === 0x53 ? "支持 SSL" : "未启用 SSL" };
    return fail(p.ms, "端口通了，但对方不像 PostgreSQL");
  }
  const p = await probe(f.host, port);
  return p.ok ? { ok: true, ms: p.ms, message: "端口可达", detail: "只检查了端口能否连通，没有验证账号" } : fail(p.ms, p.error ?? "连接失败");
}

// ───────── 内嵌终端 ─────────

function localShell(f: Record<string, string>): string | undefined {
  const win = process.platform === "win32";
  const pick = (cands: string[]) => cands.find(c => fs.existsSync(c));
  const pathDirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  const onPath = (names: string[]) => {
    for (const d of pathDirs) for (const n of names) if (fs.existsSync(path.join(d, n))) return path.join(d, n);
    return undefined;
  };
  switch (f.shell) {
    case "custom":
      return f.shellPath && fs.existsSync(f.shellPath) ? f.shellPath : undefined;
    case "powershell":
      return win ? onPath(["pwsh.exe", "powershell.exe"]) : onPath(["pwsh"]);
    case "cmd":
      return win ? (process.env.ComSpec ?? onPath(["cmd.exe"])) : undefined;
    case "bash":
      return onPath(win ? ["bash.exe"] : ["bash"]) ?? (win ? pick(["C:\\Program Files\\Git\\bin\\bash.exe"]) : undefined);
    case "zsh":
      return onPath(["zsh"]);
    default:
      return win ? (onPath(["pwsh.exe", "powershell.exe"]) ?? process.env.ComSpec) : (process.env.SHELL ?? onPath(["bash", "sh"]));
  }
}

function testLocalTerminal(f: Record<string, string>): ConnTestResult {
  const t0 = Date.now();
  const sh = localShell(f);
  if (!sh) return fail(Date.now() - t0, f.shell === "custom" ? "找不到这个 Shell 文件，请检查路径" : "这台电脑上找不到这个 Shell");
  const cwd = f.cwd ? f.cwd.replace(/^~(?=$|[\\/])/, os.homedir()) : "";
  if (cwd && !(fs.existsSync(cwd) && fs.statSync(cwd).isDirectory())) return fail(Date.now() - t0, "起始目录不存在");
  return { ok: true, ms: Date.now() - t0, message: "Shell 可用", detail: sh };
}

// ───────── 入口 ─────────

export interface TestDeps {
  fetchImpl?: typeof fetch;
  /** 内嵌终端通过服务器连接时，取那个服务器连接的字段 */
  serverFields?: (id: string) => Record<string, string> | undefined;
  /** 真的登录一次数据库，返回版本号（MySQL / PostgreSQL） */
  dbLogin?: (fields: Record<string, string>, secrets: Record<string, string>) => Promise<string>;
}

/** 用界面上填的内容（加上已保存的秘密）测一次连接 */
export async function testConnection(input: ConnectionInput, saved: Record<string, string>, deps: TestDeps = {}): Promise<ConnTestResult> {
  const f: Record<string, string> = { ...DEFAULTS[input.kind], ...input.fields };
  for (const d of CONN_FIELDS[input.kind]) if (!fieldVisible(d, f)) delete f[d.key];
  // 秘密：界面传了新值就用新值，没传（保持原值）用已保存的
  const sec: Record<string, string> = {};
  for (const d of CONN_FIELDS[input.kind].filter(isSecretField)) {
    const v = input.secrets?.[d.key];
    const val = v === undefined ? saved[d.key] : v;
    if (val) sec[d.key] = val;
  }
  try {
    switch (input.kind) {
      case "redis":
        return await testRedis(f, sec);
      case "xxljob":
        return await testXxl(f, sec, deps.fetchImpl ?? fetch);
      case "gitlab":
        return await testGitlab(f, sec, deps.fetchImpl ?? fetch);
      case "server": {
        if (f.authType === "key" && !(f.keyPath && fs.existsSync(f.keyPath))) return fail(0, "找不到私钥文件，请检查路径");
        return await testSsh(f);
      }
      case "database":
        return await testDatabase(f, sec, deps.dbLogin);
      case "terminal": {
        if (f.mode !== "server") return testLocalTerminal(f);
        const sf = deps.serverFields?.(f.serverId);
        if (!sf) return fail(0, "选的服务器连接已经不存在了");
        const r = await testSsh(sf);
        return r.ok ? { ...r, message: "通过服务器连接可以打开终端", detail: `${sf.username}@${sf.host}:${sf.port}` } : r;
      }
    }
  } catch (e) {
    return fail(0, e instanceof Error ? e.message : String(e));
  }
}

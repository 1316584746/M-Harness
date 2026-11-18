import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/**
 * 插件后台程序（sidecar）：一个常驻子进程，stdin / stdout 走 JSON-RPC 2.0（一行一条消息，stdio-jsonl），
 * 日志走 stderr。协议见 DBX 插件平台文档的 Backend protocol。
 * 启动后先发 plugin/initialize 握手，插件返回协议版本和自己的 id，id 对不上就拒绝（防止包里放错了程序）。
 */

export interface SidecarOptions {
  command: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
  pluginId: string;
  version: string;
  permissions: string[];
  /** 宿主版本：握手时告诉插件（兼容用） */
  hostVersion: string;
  onEvent?: (method: string, params: unknown) => void;
  onExit?: (reason: string) => void;
  initTimeoutMs?: number;
}

const MAX_LINE = 8 * 1024 * 1024;
const ERR_KEEP = 4000;

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class Sidecar {
  private child?: ChildProcessWithoutNullStreams;
  private buf = "";
  private seq = 0;
  private pending = new Map<number, Pending>();
  private err = "";
  private dead?: string;
  capabilities: string[] = [];

  constructor(private o: SidecarOptions) {}

  get alive(): boolean {
    return !!this.child && !this.dead;
  }

  /** 最近的 stderr（出错时给用户看） */
  get stderr(): string {
    return this.err.trim();
  }

  async start(): Promise<void> {
    const o = this.o;
    const child = spawn(o.command, o.args ?? [], { cwd: o.cwd, env: { ...process.env, ...o.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (s: string) => this.onData(s));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (s: string) => (this.err = (this.err + s).slice(-ERR_KEEP)));
    child.stdin.on("error", () => {});
    const spawnErr = new Promise<never>((_, reject) => child.once("error", e => reject(new Error(`启动失败：${e.message}`))));
    child.on("exit", (code, sig) => this.die(`后台程序已退出（${sig ?? `退出码 ${code}`}）${this.stderr ? `：${this.stderr.slice(-300)}` : ""}`));
    child.on("error", e => this.die(`后台程序出错：${e.message}`));
    try {
      const r = (await Promise.race([
        this.call("plugin/initialize", { host: { dbxVersion: o.hostVersion, hostApiVersion: "1.0.0", protocolVersions: [1] }, plugin: { id: o.pluginId, version: o.version }, permissions: o.permissions }, o.initTimeoutMs ?? 15_000),
        spawnErr,
      ])) as { protocolVersion?: number; capabilities?: string[]; plugin?: { id?: string } };
      if (r?.protocolVersion !== 1) throw new Error(`插件使用的协议版本 ${String(r?.protocolVersion)} 本软件不支持`);
      if (r.plugin?.id !== o.pluginId) throw new Error(`后台程序的身份（${String(r.plugin?.id)}）和插件（${o.pluginId}）对不上，已拒绝运行`);
      this.capabilities = Array.isArray(r.capabilities) ? r.capabilities.map(String) : [];
    } catch (e) {
      this.stop();
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  call(method: string, params: unknown, timeoutMs = 60_000): Promise<unknown> {
    if (this.dead) return Promise.reject(new Error(this.dead));
    const child = this.child;
    if (!child) return Promise.reject(new Error("后台程序没有启动"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`调用 ${method} 超时（${Math.round(timeoutMs / 1000)} 秒）`));
      }, Math.max(1000, Math.min(timeoutMs, 600_000)));
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params: params ?? {} })}\n`);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  /** 单向通知（没有回复） */
  notify(method: string, params: unknown): void {
    if (this.dead) return;
    try {
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params: params ?? {} })}\n`);
    } catch {
      /* 对方已退出 */
    }
  }

  /** 停掉后台程序；返回的 Promise 在进程真正退出后（最多等 3 秒）才完成，Windows 上删目录前要等它 */
  stop(): Promise<void> {
    this.die("后台程序已停止");
    const c = this.child;
    if (!c || c.exitCode !== null || c.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => {
      const t = setTimeout(resolve, 3000);
      c.once("exit", () => {
        clearTimeout(t);
        resolve();
      });
      try {
        c.kill();
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
  }

  private die(reason: string): void {
    if (this.dead) return;
    this.dead = reason;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
    this.o.onExit?.(reason);
  }

  private onData(s: string): void {
    this.buf += s;
    if (this.buf.length > MAX_LINE && !this.buf.includes("\n")) {
      this.die("后台程序输出了超长的一行，已终止");
      this.child?.kill();
      return;
    }
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let m: { id?: unknown; method?: unknown; params?: unknown; result?: unknown; error?: { message?: string; code?: number } };
    try {
      m = JSON.parse(line);
    } catch {
      return; // 不是协议消息（插件不小心打到 stdout 的日志）
    }
    if (typeof m.method === "string") {
      if (m.id === undefined || m.id === null) this.o.onEvent?.(m.method, m.params);
      else this.reply(m.id, undefined, { code: -32601, message: `本软件不支持插件调用宿主方法 ${m.method}` }); // 插件主动请求宿主（如 host/requestUserInput）
      return;
    }
    if (typeof m.id !== "number") return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new Error(m.error.message || `错误 ${m.error.code ?? ""}`));
    else p.resolve(m.result);
  }

  private reply(id: unknown, result: unknown, error?: { code: number; message: string }): void {
    try {
      this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...(error ? { error } : { result }) })}\n`);
    } catch {
      /* 对方已退出 */
    }
  }
}

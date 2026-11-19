import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { DSH_NOTE, foreignId, type LocalPluginInfo, type PluginEntry } from "../shared/plugins";
import { installDeps, installNpmPackage, untgz, type NpmOpts } from "./dsh-npm";
import { ensureRuntime, HOST_PACKAGES, SHIM_NAMES, type RuntimeOpts } from "./dsh-shims";
import { dshEntryInTree, isDshPackage } from "./foreign";
import type { AiPluginRef, AiRawTool } from "./pluginhost";
import { loadTree, makeCtx, parseGithubUrl } from "./repo-import";

/**
 * DSH 插件（DeepSeek Harness 的 npm 插件）的安装和运行：
 *   · 安装：从 npm 或固定提交的 GitHub 仓库取代码，装到 <dir>/plugins/<包名>/，依赖一并装好（不跑任何安装脚本）。
 *   · 运行：每个插件一个 Node 子进程，里面是真的 Cordis + 本软件提供的 tools / commands 服务（见 dsh-runner.mjs）。
 *     插件注册的工具交给 AI 使用；DSH 的界面、设置页等专有功能没有。
 *   · 信任：插件是第三方的 JavaScript，能做 Node 能做的任何事。第一次运行前要用户确认，换版本要重新确认。
 */

const IDLE_MS = 10 * 60_000;
const ERR_KEEP = 4000;
const MAX_FILE = 25 * 1024 * 1024;

export interface DshMeta {
  id: string;
  pkg: string;
  version: string;
  name: string;
  description?: string;
  at: number;
  /** 上次读到的 AI 工具数 */
  tools?: number;
  source?: PluginEntry["install"];
  repo?: string;
  /** 装的时候看出来的提醒（比如没发现它提供 AI 工具） */
  note?: string;
}

/** 静态看一眼插件代码：有没有碰「工具」或「命令」这两个本软件能接的服务；一个都没有，装了多半没用 */
export function usesToolsOrCommands(dir: string): boolean {
  const re = /defineTool|dsh-tools|["'`](?:tools|commands)["'`]|\.(?:tools|commands)\.register|ctx\.(?:tools|commands)\b|\btools\.register\b/;
  let budget = 30 * 1024 * 1024;
  let hit = false;
  const walk = (d: string, depth: number) => {
    if (hit || depth > 8) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(m?js|cjs)$/.test(e.name)) {
        const t = fs.readFileSync(p, "utf8");
        budget -= t.length;
        if (budget < 0) return;
        if (re.test(t)) hit = true;
      }
      if (hit) return;
    }
  };
  try {
    walk(dir, 0);
  } catch {
    return true; // 读不了就不下结论
  }
  return hit;
}

export interface DshOpts {
  /** 数据目录：<dir>/plugins、<dir>/meta、<dir>/data、<dir>/node_modules（运行环境） */
  dir: string;
  /** 用户确认过的记录 */
  consentFile: string;
  fetchImpl?: typeof fetch;
  npm?: NpmOpts;
  runtime?: RuntimeOpts;
  /** 测试用：自定义怎么启动运行器 */
  launch?: (runner: string, runtimeRoot: string, pluginDir: string) => { command: string; args: string[]; env?: Record<string, string> };
}

/** 本软件自带的 node_modules 可能在哪（开发、打包后的 app.asar、测试），里面有 Cordis 就直接复制，不用联网下载 */
export function appModuleRoots(): string[] {
  const roots = [path.resolve(__dirname, "..", "..", "node_modules"), path.resolve(__dirname, "..", "node_modules"), path.join(process.cwd(), "node_modules")];
  const res = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (res) roots.push(path.join(res, "app.asar", "node_modules"), path.join(res, "app", "node_modules"));
  return roots;
}

/** 本软件提供的 DSH 宿主包（别的 @deepseek-ai/* 都没有） */
const PROVIDED = new Set([...HOST_PACKAGES.map(p => p.name), "@deepseek-ai/cosmokit", ...SHIM_NAMES.map(n => `@deepseek-ai/${n}`)]);

/** 插件代码里静态 import 了、但本软件没有提供的 @deepseek-ai/* 包（动态 import 不算，插件可能用 try 包着） */
export function missingHostPackages(dir: string): string[] {
  const found = new Set<string>();
  const re = /(?:^|[\s;}])(?:import|export)\s[^'"`]*?from\s*["'](@deepseek-ai\/[^"'/]+)|(?:^|[\s;}])import\s*["'](@deepseek-ai\/[^"'/]+)["']/g;
  let budget = 30 * 1024 * 1024;
  const walk = (d: string, depth: number) => {
    if (depth > 8) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(m?js|cjs)$/.test(e.name)) {
        const text = fs.readFileSync(p, "utf8");
        budget -= text.length;
        if (budget < 0) return;
        for (const m of text.matchAll(re)) found.add(m[1] ?? m[2]);
      }
    }
  };
  try {
    walk(dir, 0);
  } catch {
    /* 读不了的目录跳过 */
  }
  return [...found].filter(n => !PROVIDED.has(n)).sort();
}

export function hostMissingText(pkgs: string[], atInstall: boolean): string {
  const list = pkgs.map(p => p.replace("@deepseek-ai/", "")).join("、");
  return `这个插件需要 DSH 本体才有的内部服务（${list}），本软件没有提供，${atInstall ? "装了也运行不起来，已取消安装" : "所以运行不起来"}。本软件的 DSH 兼容只支持提供「AI 工具」和「命令」的插件；上下文压缩、会话存储这类给 DSH 自己用的插件不能用。`;
}

/** 仓库里没有 DSH 插件：索引里标「未验证」的条目只是 GitHub 上带 dsh-plugin 标签的仓库，不少其实是技能 / 文档仓库 */
export function notPluginError(skillRepo: boolean): Error {
  return new Error(
    skillRepo
      ? "这个仓库不是 DSH 插件：它是技能（SKILL.md）仓库，里面没有 package.json。可以到「设置 → 技能 → 从 GitHub 导入」把它导入成技能。"
      : "这个仓库里没有 DSH 插件（根目录和常见子目录都找不到带 dsh 字段的 package.json）。市场里标「未验证」的条目只是 GitHub 上带 dsh-plugin 标签的仓库，不保证是插件。",
  );
}

export const pluginSlug = (pkg: string): string => pkg.replace(/^@/, "").replace(/\//g, "__");
export const pkgOfId = (id: string): string => id.replace(/^dsh:/, "");

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 一个运行中的插件子进程（stdin / stdout 一行一条 JSON） */
class Runner {
  private child?: ChildProcessWithoutNullStreams;
  private buf = "";
  private seq = 0;
  private pending = new Map<number, Pending>();
  private err = "";
  dead?: string;
  private idle?: ReturnType<typeof setTimeout>;
  loaded?: { name?: string; version?: string; tools: AiRawTool[]; warnings: string[] };

  constructor(
    private cmd: { command: string; args: string[]; env?: Record<string, string>; cwd: string },
    private onGone: () => void,
  ) {}

  get alive(): boolean {
    return !!this.child && !this.dead;
  }

  get stderr(): string {
    return this.err.trim();
  }

  start(): void {
    const child = spawn(this.cmd.command, this.cmd.args, { cwd: this.cmd.cwd, env: { ...process.env, ...this.cmd.env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.child = child;
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (s: string) => {
      this.buf += s;
      let i: number;
      while ((i = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line) this.onLine(line);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (s: string) => (this.err = (this.err + s).slice(-ERR_KEEP)));
    child.stdin.on("error", () => {});
    child.on("exit", (code, sig) => this.die(`插件进程已退出（${sig ?? `退出码 ${code}`}）${this.stderr ? `：${this.stderr.slice(-400)}` : ""}`));
    child.on("error", e => this.die(`插件进程启动失败：${e.message}`));
  }

  private onLine(line: string): void {
    let m: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      m = JSON.parse(line);
    } catch {
      return;
    }
    const p = typeof m.id === "number" ? this.pending.get(m.id) : undefined;
    if (!p) return;
    this.pending.delete(m.id!);
    clearTimeout(p.timer);
    if (m.error) p.reject(new Error(m.error.message || "插件出错"));
    else p.resolve(m.result);
  }

  call<T = any>(method: string, params: unknown, timeoutMs = 120_000): Promise<T> {
    if (this.dead) return Promise.reject(new Error(this.dead));
    const child = this.child;
    if (!child) return Promise.reject(new Error("插件进程没有启动"));
    this.touch();
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`调用 ${method} 超时（${Math.round(timeoutMs / 1000)} 秒）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
      } catch (e) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });
  }

  private touch(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => void this.stop(), IDLE_MS);
    this.idle.unref?.();
  }

  private die(reason: string): void {
    if (this.dead) return;
    this.dead = reason;
    clearTimeout(this.idle);
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
      this.pending.delete(id);
    }
    this.onGone();
  }

  /** 停掉进程；Promise 在进程真的退出后（最多等 3 秒）才完成，Windows 上删目录前要等它 */
  stop(): Promise<void> {
    this.die("插件进程已停止");
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
}

export class DshPlugins {
  private runners = new Map<string, Runner>();
  private starting = new Map<string, Promise<Runner>>();

  constructor(private o: DshOpts) {}

  private get f(): typeof fetch {
    return this.o.fetchImpl ?? fetch;
  }
  private get pluginsDir() {
    return path.join(this.o.dir, "plugins");
  }
  private get metaDir() {
    return path.join(this.o.dir, "meta");
  }
  private metaFile(id: string) {
    return path.join(this.metaDir, `${pluginSlug(pkgOfId(id))}.json`);
  }
  private codeDir(id: string) {
    return path.join(this.pluginsDir, pluginSlug(pkgOfId(id)));
  }

  // ───────── 已装的插件 ─────────

  installed(): DshMeta[] {
    let files: string[] = [];
    try {
      files = fs.readdirSync(this.metaDir).filter(n => n.endsWith(".json"));
    } catch {
      return [];
    }
    const out: DshMeta[] = [];
    for (const n of files) {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(this.metaDir, n), "utf8")) as DshMeta;
        if (m?.id && m.pkg && fs.existsSync(path.join(this.codeDir(m.id), "package.json"))) out.push(m);
      } catch {
        /* 坏文件忽略 */
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  }

  /** 装的时候看出来的提醒（没有就是 undefined） */
  noteOf(id: string): string | undefined {
    return this.get(id)?.note;
  }

  get(id: string): DshMeta | undefined {
    return this.installed().find(m => m.id.toLowerCase() === id.toLowerCase());
  }

  private saveMeta(m: DshMeta): void {
    fs.mkdirSync(this.metaDir, { recursive: true });
    fs.writeFileSync(this.metaFile(m.id), JSON.stringify(m, null, 2));
  }

  /** 给「已安装」页用的摘要（和 DBX 插件放在同一张表里） */
  localInfo(): Record<string, LocalPluginInfo> {
    const out: Record<string, LocalPluginInfo> = {};
    for (const m of this.installed())
      out[m.id] = {
        version: m.version,
        listed: m.source?.kind === "dsh" ? m.source.version : undefined,
        name: m.name,
        ecosystem: "dsh",
        ui: false,
        backend: true,
        permissions: [],
        kinds: ["dsh"],
        tools: m.tools ?? 0,
        summary: `DSH 插件（${m.pkg}）。${m.tools !== undefined ? `上次读到 ${m.tools} 个 AI 工具。` : "还没有运行过，运行后才知道有几个 AI 工具。"}${m.note ? `注意：${m.note}。` : ""}${DSH_NOTE}`,
      };
    return out;
  }

  // ───────── 信任 ─────────

  private consent(): Record<string, { version: string; at: number }> {
    try {
      const j = JSON.parse(fs.readFileSync(this.o.consentFile, "utf8"));
      return j && typeof j === "object" ? j : {};
    } catch {
      return {};
    }
  }

  isTrusted(id: string): boolean {
    const m = this.get(id);
    return !!m && this.consent()[m.id]?.version === m.version;
  }

  trust(id: string): boolean {
    const m = this.get(id);
    if (!m) return false;
    const c = this.consent();
    c[m.id] = { version: m.version, at: Date.now() };
    fs.mkdirSync(path.dirname(this.o.consentFile), { recursive: true });
    fs.writeFileSync(this.o.consentFile, JSON.stringify(c, null, 2));
    return true;
  }

  // ───────── 安装 / 卸载 ─────────

  /** 下载一个提交的整库压缩包（codeload.github.com，不占 GitHub API 的匿名限额）：路径 → 内容，去掉 node_modules / .git */
  private async githubTarball(gh: { owner: string; repo: string }, commit: string): Promise<Map<string, Buffer>> {
    const res = await this.f(`https://codeload.github.com/${gh.owner}/${gh.repo}/tar.gz/${commit}`, { signal: AbortSignal.timeout(420_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > 150 * 1024 * 1024) throw new Error("仓库压缩包太大（超过 150MB）");
    const files = untgz(Buffer.from(await res.arrayBuffer()));
    const out = new Map<string, Buffer>();
    for (const f of files) if (!/(^|\/)(node_modules|\.git)\//.test(f.path)) out.set(f.path, f.data);
    return out;
  }

  /** 固定提交里某个文件在不在（raw.githubusercontent.com，不占 GitHub 接口限额）：返回 HTTP 状态码，请求本身失败返回 undefined */
  private async rawStatus(gh: { owner: string; repo: string }, commit: string, file: string): Promise<number | undefined> {
    try {
      const res = await this.f(`https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${commit}/${file}`, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
      return res.status;
    } catch {
      return undefined;
    }
  }

  /** 在仓库里找 DSH 插件所在目录（package.json 带 dsh 字段）；找不到返回 "" */
  private async findDshDir(read: (p: string, max?: number) => Promise<Buffer>, tree: string[], pkgName: string): Promise<string> {
    const cands = tree
      .filter(p => /(^|\/)package\.json$/.test(p) && p.split("/").length <= 5)
      .filter(p => !/(^|\/)(node_modules|tests?|__tests__|fixtures?|examples?|docs?)\//i.test(p))
      .sort((a, b) => Number(/dsh|deepseek/i.test(b)) - Number(/dsh|deepseek/i.test(a)) || a.length - b.length)
      .slice(0, 12);
    const hits: { dir: string; name: string }[] = [];
    for (const p of cands) {
      try {
        const pkg = JSON.parse((await read(p, 200_000)).toString("utf8"));
        if (isDshPackage(pkg)) hits.push({ dir: p.replace(/\/?package\.json$/, ""), name: String(pkg.name ?? "") });
      } catch {
        /* 读不到或不是合法 JSON，跳过 */
      }
    }
    if (!hits.length) return "";
    const tail = pkgName.replace(/^@[^/]+\//, "");
    return (hits.find(h => h.name === pkgName || h.name.replace(/^@[^/]+\//, "") === tail) ?? hits[0]).dir;
  }

  /** 取代码放进 tmp 目录：npm 包，或固定提交的 GitHub 仓库 */
  private async fetchCode(entry: PluginEntry & { install: { kind: "dsh" } }, tmp: string, progress: (s: string) => void): Promise<Record<string, any>> {
    const ins = entry.install;
    const npm: NpmOpts = { ...this.o.npm, fetchImpl: this.f, progress };
    if (ins.source.type === "npm") {
      if (ins.source.registry) npm.registries = [ins.source.registry, ...(npm.registries ?? ["https://registry.npmjs.org", "https://registry.npmmirror.com"])];
      return installNpmPackage(ins.pkg, ins.version, tmp, npm);
    }
    const gh = parseGithubUrl(ins.source.url);
    if (!gh) throw new Error("这个插件的来源不是 GitHub 仓库，暂不支持");
    const src = { ...gh, ref: ins.source.commit, dir: "" };
    progress("读取仓库文件清单");
    let tree: string[];
    let read: (p: string, max?: number) => Promise<Buffer>;
    try {
      tree = await loadTree(this.f, src, true);
      const c = makeCtx(this.f, src, tree);
      read = (p, max = MAX_FILE) => c.fetchBytes(p, max);
    } catch (e) {
      // GitHub 的文件清单接口匿名每小时只有 60 次，用光了就装不了；整库压缩包（codeload）不走这个限额，改下载它
      // 但很多「插件」其实是技能 / 文档仓库（有 SKILL.md、没有 package.json），先花一个小请求看一眼，别为它下几十兆
      if (!ins.source.dir) {
        const [pkgHere, skillHere] = await Promise.all([this.rawStatus(gh, ins.source.commit, "package.json"), this.rawStatus(gh, ins.source.commit, "SKILL.md")]);
        if (pkgHere === 404 && skillHere === 200) throw notPluginError(true);
      }
      progress("GitHub 接口不可用，改为下载整个仓库的压缩包");
      const got = await this.githubTarball(gh, ins.source.commit).catch(() => undefined);
      if (!got) throw e;
      tree = [...got.keys()];
      read = async p => {
        const b = got.get(p);
        if (!b) throw new Error(`压缩包里没有 ${p}`);
        return b;
      };
    }
    let dir = ins.source.dir ?? "";
    if (!dir && !tree.includes("package.json")) {
      // 索引没写插件在仓库哪个目录：在仓库里找带 dsh 字段的 package.json（很多多平台仓库把它放在 plugins/dsh 之类的子目录）
      progress("在仓库里查找 DSH 插件目录");
      dir = await this.findDshDir(read, tree, ins.pkg);
    }
    const base = dir ? `${dir}/` : "";
    const files = tree.filter(p => p.startsWith(base) && !/(^|\/)(\.git|node_modules)\//.test(p));
    if (!files.some(p => p === `${base}package.json`)) throw notPluginError(tree.some(p => /(^|\/)SKILL\.md$/.test(p)));
    if (files.length > 3000) throw new Error("仓库文件太多（超过 3000 个），不像是一个预编译好的插件");
    fs.rmSync(tmp, { recursive: true, force: true });
    let total = 0;
    let next = 0;
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        while (next < files.length) {
          const p = files[next++];
          const data = await read(p, MAX_FILE);
          total += data.length;
          if (total > 150 * 1024 * 1024) throw new Error("仓库太大（超过 150MB）");
          const rel = p.slice(base.length);
          const target = path.resolve(tmp, rel);
          if (!target.startsWith(path.resolve(tmp) + path.sep)) throw new Error(`不安全的路径：${rel}`);
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, data);
        }
      }),
    );
    const pkg = JSON.parse(fs.readFileSync(path.join(tmp, "package.json"), "utf8"));
    if (!dshEntryInTree(pkg, "", fs.readdirSync(tmp, { recursive: true }).map(x => String(x).replace(/\\/g, "/")))) throw new Error("这个插件仓库里没有编译好的入口文件（需要先编译），本软件不能编译插件");
    progress("安装依赖");
    await installDeps(tmp, pkg.dependencies ?? {}, npm);
    return pkg;
  }

  /** 装（或更新）一个 DSH 插件；返回装好的版本 */
  async install(entry: PluginEntry, progress: (s: string) => void = () => {}): Promise<string> {
    if (entry.install.kind !== "dsh") throw new Error("这不是 DSH 插件");
    const e = entry as PluginEntry & { install: { kind: "dsh" } };
    const id = foreignId("dsh", e.install.pkg);
    progress("准备 DSH 运行环境");
    await ensureRuntime(this.o.dir, { appModuleRoots: appModuleRoots(), ...this.o.runtime, npm: { ...this.o.npm, fetchImpl: this.f, progress } });
    await this.stop(id);
    fs.mkdirSync(this.pluginsDir, { recursive: true });
    const tmp = path.join(this.pluginsDir, `.tmp-${pluginSlug(e.install.pkg)}-${Date.now().toString(36)}`);
    try {
      const pkg = await this.fetchCode(e, tmp, progress);
      if (!isDshPackage(pkg) && e.install.source.type === "git") throw new Error("这个仓库不是 DSH 插件（package.json 里没有 dsh 字段）");
      // 宿主自己提供的包，不能让插件带一份旧的顶替
      fs.rmSync(path.join(tmp, "node_modules", "@deepseek-ai"), { recursive: true, force: true });
      // 插件代码里 import 了本软件没有的 DSH 内部包（如压缩引擎、会话存储）：装了也加载不起来，直接说清楚
      const missing = missingHostPackages(tmp);
      if (missing.length) throw new Error(hostMissingText(missing, true));
      const dest = this.codeDir(id);
      fs.rmSync(dest, { recursive: true, force: true });
      fs.renameSync(tmp, dest);
      const version = String(pkg.version ?? e.install.version);
      const note = usesToolsOrCommands(dest) ? undefined : "没发现这个插件提供 AI 工具或命令，它可能只有 DSH 的界面功能（本软件运行不了界面），装了不一定有用";
      this.saveMeta({ id, pkg: e.install.pkg, version, name: e.name, description: e.description || pkg.description, at: Date.now(), source: e.install, repo: e.repo, note });
      return version;
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  async uninstall(id: string): Promise<boolean> {
    const m = this.get(id);
    if (!m) return false;
    await this.stop(m.id);
    fs.rmSync(this.codeDir(m.id), { recursive: true, force: true });
    fs.rmSync(this.metaFile(m.id), { force: true });
    fs.rmSync(path.join(this.o.dir, "data", pluginSlug(m.pkg)), { recursive: true, force: true });
    const c = this.consent();
    if (c[m.id]) {
      delete c[m.id];
      fs.writeFileSync(this.o.consentFile, JSON.stringify(c, null, 2));
    }
    return true;
  }

  // ───────── 运行 ─────────

  private async runner(id: string): Promise<Runner> {
    const live = this.runners.get(id);
    if (live?.alive) return live;
    const going = this.starting.get(id);
    if (going) return going;
    const p = this.startRunner(id).finally(() => this.starting.delete(id));
    this.starting.set(id, p);
    return p;
  }

  private async startRunner(id: string): Promise<Runner> {
    const m = this.get(id);
    if (!m) throw new Error("这个插件已经不在了");
    if (!this.isTrusted(m.id)) throw new Error("还没有确认信任这个插件");
    const rt = await ensureRuntime(this.o.dir, { appModuleRoots: appModuleRoots(), ...this.o.runtime, npm: { ...this.o.npm, fetchImpl: this.f } });
    const dir = this.codeDir(m.id);
    const data = path.join(this.o.dir, "data", pluginSlug(m.pkg));
    fs.mkdirSync(data, { recursive: true });
    const cmd = this.o.launch?.(rt.runner, rt.root, dir) ?? { command: process.execPath, args: [rt.runner, rt.root, dir] };
    const r = new Runner({ ...cmd, env: { ELECTRON_RUN_AS_NODE: "1", NODE_NO_WARNINGS: "1", HARNESS_DSH: "1", DSH_HOME: data, ...cmd.env }, cwd: data }, () => {
      if (this.runners.get(m.id) === r) this.runners.delete(m.id);
    });
    r.start();
    try {
      r.loaded = await r.call("load", {}, 60_000);
    } catch (e) {
      const tail = r.stderr.split("\n").slice(-6).join("\n");
      await r.stop();
      const lack = /Cannot find (?:package|module) '(@deepseek-ai\/[^'/]+)/.exec(`${e instanceof Error ? e.message : String(e)}\n${tail}`);
      if (lack) throw new Error(hostMissingText([lack[1]], false));
      if (/invalid plugin, expect function or object with an "apply" method/.test(String(e instanceof Error ? e.message : e))) throw new Error("这个包的入口不是 DSH 插件的写法（像是给别的工具写的，只是带了 DSH 标签），本软件加载不了它");
      throw new Error(`${e instanceof Error ? e.message : String(e)}${tail && !String(e).includes(tail.slice(-60)) ? `\n${tail}` : ""}`);
    }
    this.runners.set(m.id, r);
    if (r.loaded && m.tools !== r.loaded.tools.length) this.saveMeta({ ...m, tools: r.loaded.tools.length });
    return r;
  }

  /** 读插件提供的工具（必须已确认信任）；返回前会启动插件进程 */
  async aiTools(id: string): Promise<AiRawTool[]> {
    const r = await this.runner(id);
    const l = r.loaded ?? { tools: [], warnings: [] };
    if (!l.tools.length) {
      const why = l.warnings.length ? l.warnings.join("；") : "插件启动了，但没有注册 AI 工具（它可能只有 DSH 的界面或设置功能）";
      throw new Error(why);
    }
    return l.tools;
  }

  async aiCall(id: string, tool: string, args: Record<string, unknown>, _conn?: string, timeoutMs = 120_000): Promise<unknown> {
    const r = await this.runner(id);
    const text = await r.call<string>("call", { tool, args }, timeoutMs);
    return { content: [{ type: "text", text: String(text ?? "") }] };
  }

  /** 插件启动时的警告（缺少哪些 DSH 宿主服务之类），给界面提示用 */
  warnings(id: string): string[] {
    return this.runners.get(this.get(id)?.id ?? id)?.loaded?.warnings ?? [];
  }

  aiPlugins(): AiPluginRef[] {
    return this.installed().map(m => ({ id: m.id, name: m.name, version: m.version, description: m.description, trusted: this.isTrusted(m.id), conns: [], ecosystem: "dsh" as const }));
  }

  async stop(id: string): Promise<void> {
    const m = this.get(id);
    const r = this.runners.get(m?.id ?? id);
    if (r) await r.stop();
    this.runners.delete(m?.id ?? id);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runners.values()].map(r => r.stop()));
    this.runners.clear();
  }
}

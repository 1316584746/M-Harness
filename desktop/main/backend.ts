import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LarkCliChannel } from "../../src/channels/lark-cli";
import { SessionManager } from "../../src/channels/session";
import { dropMockProviders, loadConfig, parseConfig, type HarnessConfig } from "../../src/config";
import { readTrace } from "../../src/core/trace";
import type { HarnessEvent, Tool } from "../../src/core/types";
import { McpManager } from "../../src/mcp/manager";
import { loadProjectRules } from "../../src/prompt/rules";
import { SKILL_NAME } from "../../src/prompt/skills";
import { Runtime } from "../../src/runtime";
import { probeKey } from "../../src/models/probe";
import { dwsCheckUpdate, dwsStatus, larkCheckUpdate, larkStatus } from "../../src/tools/cli-status";
import { feishuProjectSpaces, feishuProjectStatus } from "../../src/tools/feishu-project";
import { PluginMarket } from "./plugins";
import { AutomationEngine, type RunResult } from "./automation";
import { DefectWatcher } from "./defects";
import { dingtalkTransition, dingtalkTransitions, feishuTransition, feishuTransitions, fetchDingtalkDefects, fetchFeishuDefects } from "./defects-source";
import { ENTRY_NAME, type DefectActResult, type DefectsResult, type DefectTransitions } from "../shared/defects";
import { DbxBridge } from "./dbx";
import { PluginHost } from "./pluginhost";
import { ConnectionStore, plainBox, type SecretBox } from "./connections";
import { testConnection } from "./conn-test";
import { DbEngine } from "./db-engine";
import { DEFAULTS, type ConnTestResult, type Connection, type ConnectionInput } from "../shared/connections";
import { PluginRepos } from "./pluginrepos";
import type { PluginReply, UiPlugin } from "../shared/pluginhost";
import { TODO_PLUGIN_ID, pickTodayTodos, type HomeTodosDTO } from "../shared/todos";
import type { Automation } from "../shared/automation";
import { DBX_CATALOG_URL, DBX_SOURCE, type MarketResult, type PluginRepo } from "../shared/plugins";
import { fetchDingtalkTodos, fetchFeishuTodos, sortTodos, type TodoSource } from "../../src/tools/workbench";
import { cloneRepo, detectBaseBranch, diffStat, inspectRepo, listBranches, repoStatus, syncBaseBranch } from "../../src/tools/git";
import { authEnvFor, probeHost } from "../../src/tools/git-hosts";
import type {
  AppState,
  ApprovalRequest,
  HostProbeDTO,
  IntegrationStatusDTO,
  IntegrationUpdateDTO,
  KeyProbeDTO,
  McpServerDTO,
  ProviderInfo,
  RuleFileDTO,
  SkillDTO,
  RepoInfo,
  RunOutcome,
  RunRequest,
  ToolInfo,
  TraceInfo,
  TraceLineDTO,
} from "../shared/api";

/** 主进程向渲染进程推送消息的出口（由 Electron 层实现，便于脱离 Electron 测试） */
export interface Host {
  send(channel: string, payload: unknown): void;
  /** 系统通知（没有就不弹） */
  notify?(title: string, body: string): void;
  /** 秘密落盘加密（系统 safeStorage）；没有就明文存在数据目录里 */
  secrets?: SecretBox;
}

export const DEFAULT_CONFIG_TEXT = `{
  "defaultProvider": "deepseek",
  "workspace": ".",
  "traceDir": ".traces",
  "limits": { "maxSteps": 20, "timeoutSec": 300, "contextTokens": 24000 },
  "guard": {
    "policy": { "read": "allow", "write": "ask", "exec": "ask", "network": "ask" }
  },
  "providers": {
    "deepseek": {
      "type": "openai-compat",
      "baseURL": "https://api.deepseek.com",
      "apiKey": "\${DEEPSEEK_API_KEY}",
      "model": "deepseek-chat"
    },
    "openai": {
      "type": "openai-compat",
      "baseURL": "https://api.openai.com/v1",
      "apiKey": "\${OPENAI_API_KEY}",
      "model": "gpt-4o-mini"
    },
    "claude": { "type": "anthropic", "apiKey": "\${ANTHROPIC_API_KEY}", "model": "claude-sonnet-4-5" },
    "codex": { "type": "cli", "preset": "codex", "timeoutSec": 900 },
    "cursor": { "type": "cursor-sdk", "apiKey": "\${CURSOR_API_KEY}", "model": "composer-2" }
  },
  "channels": {
    "server": { "host": "127.0.0.1", "port": 8787 },
    "toolPolicy": "readonly"
  }
}
`;

interface Pending {
  runKey: string;
  tool: string;
  resolve: (ok: boolean) => void;
}

/** 桌面端后端：配置、运行、审批、trace、飞书通道。不依赖 Electron，便于测试。 */
export class Backend {
  readonly configFile: string;
  private rt!: Runtime;
  /** MCP 连接在配置重载之间保持，只重连有变化的服务 */
  private mcp = new McpManager();
  private configError?: string;
  private runs = new Map<string, AbortController>();
  private pending = new Map<string, Pending>();
  private alwaysAllow = new Set<string>();
  private approvalSeq = 0;
  private lark?: LarkCliChannel;
  private channelLogs: string[] = [];

  constructor(readonly home: string, private host: Host) {
    this.configFile = path.join(home, "harness.config.json");
    if (!fs.existsSync(this.configFile)) fs.writeFileSync(this.configFile, DEFAULT_CONFIG_TEXT, "utf8");
    this.dropMockFromFile();
    this.reload();
  }

  /** 旧版本的配置文件里可能还留着内置的 mock 假模型：启动时把它从文件里清掉 */
  private dropMockFromFile(): void {
    try {
      const j = JSON.parse(fs.readFileSync(this.configFile, "utf8").replace(/^\uFEFF/, ""));
      if (dropMockProviders(j)) fs.writeFileSync(this.configFile, JSON.stringify(j, null, 2) + "\n", "utf8");
    } catch {
      // 配置文件本身有问题时交给 reload() 去报
    }
  }

  /** 启动后在后台把有 Key 的模型提供方的列表先取回来（顺带预热 @cursor/sdk），用户打开下拉时已经是现成的 */
  prefetchModels(): void {
    const names = Object.entries(this.config.providers)
      .filter(([, c]: [string, any]) => c.apiKey && ["cursor-sdk", "anthropic", "openai-compat"].includes(c.type))
      .map(([n]) => n)
      .sort((a, b) => (a === this.config.defaultProvider ? -1 : b === this.config.defaultProvider ? 1 : 0))
      .slice(0, 4);
    for (const n of names) void this.providerModels(n).catch(() => {});
  }

  /** 重新读取配置并重建 Runtime；失败时保留旧 Runtime */
  private reload(): void {
    try {
      const { config } = loadConfig(this.configFile);
      this.rt = new Runtime(config, { mcp: this.mcp, home: this.home });
      this.configError = undefined;
    } catch (e: any) {
      this.configError = e?.message ?? String(e);
      this.rt ??= new Runtime(parseConfig({}), { mcp: this.mcp, home: this.home });
    }
  }

  get config(): HarnessConfig {
    return this.rt.config;
  }

  private resolve(p: string): string {
    return path.resolve(this.home, p);
  }

  getState(): AppState {
    const providers: ProviderInfo[] = this.rt.registry.names().map(name => {
      let problem: string | undefined;
      let kind: ProviderInfo["kind"] = "model";
      try {
        kind = this.rt.registry.get(name).kind;
      } catch (e: any) {
        problem = e?.message ?? String(e);
      }
      return { name, desc: this.rt.registry.describe(name), kind, model: this.rt.registry.modelOf(name), problem };
    });
    return {
      home: this.home,
      configFile: this.configFile,
      configText: fs.readFileSync(this.configFile, "utf8"),
      configError: this.configError,
      defaultProvider: this.config.defaultProvider,
      workspace: this.resolve(this.config.workspace),
      traceDir: this.resolve(this.config.traceDir),
      providers,
      larkConfigured: !!this.config.channels.larkCli,
      channel: { running: !!this.lark, logs: this.channelLogs.slice(-200) },
    };
  }

  saveConfig(text: string): { ok: boolean; error?: string } {
    try {
      parseConfig(JSON.parse(text.replace(/^\uFEFF/, "")));
    } catch (e: any) {
      return { ok: false, error: e?.issues ? JSON.stringify(e.issues.slice(0, 3), null, 2) : (e?.message ?? String(e)) };
    }
    fs.writeFileSync(this.configFile, text, "utf8");
    const wasRunning = !!this.lark;
    this.channelStop();
    this.reload();
    if (wasRunning) this.log("配置已更新，通道已停止，请重新启动。");
    return { ok: true };
  }

  // ───────────── 代码仓库 ─────────────

  async listRepos(): Promise<RepoInfo[]> {
    const entries = Object.entries(this.config.repos);
    return Promise.all(
      entries.map(async ([name, r]) => ({
        name,
        path: this.resolve(r.path),
        url: r.url,
        platform: r.platform,
        base: await detectBaseBranch(this.resolve(r.path), r.branches?.base).catch(() => undefined),
        status: await repoStatus(this.resolve(r.path)),
      })),
    );
  }

  /** 关联仓库时：把它同步到基线分支的最新代码（fetch → 切基线分支 → 快进拉取；有未提交改动不切） */
  async repoSync(name: string) {
    const r = this.config.repos[name];
    if (!r) return { ok: false, switched: false, pulled: false, error: "没有登记过这个仓库" };
    return syncBaseBranch(this.resolve(r.path), r.branches?.base, undefined, r.url ? authEnvFor(r.url, this.config.gitHosts) : undefined);
  }

  /** 任务关联仓库（按配置里的名字）当前的改动行数合计 */
  async repoDiffStat(names: string[]): Promise<{ added: number; deleted: number; files: number }> {
    const sum = { added: 0, deleted: 0, files: 0 };
    for (const n of names) {
      const r = this.config.repos[n];
      if (!r) continue;
      const d = await diffStat(this.resolve(r.path));
      sum.added += d.added;
      sum.deleted += d.deleted;
      sum.files += d.files;
    }
    return sum;
  }

  /** 任务专属文件夹（放这个任务的产出 / 附件），不存在就建一个 */
  taskFolder(id: string): string {
    const safe = id.replace(/[^\w.-]/g, "_").slice(0, 80) || "task";
    const dir = path.join(this.home, "tasks", safe);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  listBranches(dir: string): Promise<string[]> {
    return listBranches(path.resolve(dir));
  }

  inspectRepo(dir: string) {
    return inspectRepo(path.resolve(dir));
  }

  cloneRepo(url: string, parentDir: string, name: string) {
    if (!/^[\w.-]+$/.test(name) || name === "." || name === "..") return Promise.resolve({ ok: false, error: "目录名只能包含字母、数字、下划线、点和短横线" });
    return cloneRepo(url, path.join(path.resolve(parentDir), name), undefined, authEnvFor(url, this.config.gitHosts));
  }

  /** 用令牌向托管平台查"我是谁"（令牌可以是尚未保存的） */
  probeGitHost(req: { platform: string; baseURL?: string; token?: string }): Promise<HostProbeDTO> {
    return probeHost(req);
  }

  // ───────────── 项目管理集成 ─────────────

  feishuProjectStatus() {
    const c = this.config.integrations.feishuProject;
    return feishuProjectStatus(c ?? { bin: "meegle" });
  }

  private cliSpec(kind: string): { bin: string; binArgs?: string[] } {
    if (kind === "lark") {
      const c = this.config.channels.larkCli;
      return { bin: c?.bin ?? "lark-cli", binArgs: c?.binArgs };
    }
    if (kind === "dws") return { bin: this.config.integrations.dingtalk?.bin ?? "dws" };
    const c = this.config.integrations.feishuProject;
    return { bin: c?.bin ?? "meegle", binArgs: c?.binArgs };
  }

  async integrationStatus(kind: string): Promise<IntegrationStatusDTO> {
    if (kind === "lark") return larkStatus(this.cliSpec(kind));
    if (kind === "dws") return dwsStatus(this.cliSpec(kind));
    if (kind === "meegle") return this.feishuProjectStatus();
    return { installed: false, authenticated: false, detail: `未知集成：${kind}` };
  }

  async integrationCheckUpdate(kind: string): Promise<IntegrationUpdateDTO> {
    if (kind === "lark") return larkCheckUpdate(this.cliSpec(kind));
    if (kind === "dws") return dwsCheckUpdate(this.cliSpec(kind));
    return { supported: false, ok: true, message: "meegle 没有提供更新检查，请到官方文档查看新版本" };
  }

  /** 工作台：只读拉取飞书项目 / 钉钉的待办；没启用的来源不调用 CLI */
  async workbenchTodos() {
    const fp = this.config.integrations.feishuProject;
    const dp = fp ? undefined : this.config.integrations.dingtalkProject; // 项目管理只接一个：同时配了就用飞书
    const off: TodoSource = { enabled: false, ok: true, items: [] };
    const [feishu, dingtalk] = await Promise.all([
      fp ? fetchFeishuTodos(fp) : off,
      dp ? fetchDingtalkTodos({ ...dp, bin: this.config.integrations.dingtalk?.bin ?? "dws" }) : off,
    ]);
    return { feishu, dingtalk, items: sortTodos([...feishu.items, ...dingtalk.items]) };
  }

  private market = new PluginMarket();

  /** 插件商店：自带插件 + 已启用的插件源 */
  async pluginFetchUrl(url: string): Promise<{ ok: boolean; entries?: import("../shared/plugins").PluginEntry[]; skipped?: string[]; error?: string }> {
    try {
      return { ok: true, ...(await this.market.fetchPackage(url)) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 插件仓库（官方 + 用户添加的第三方，存在数据目录里） */
  private _conns?: ConnectionStore;
  /** 连接（XXL-JOB / 数据库 / Redis / 服务器 / 内嵌终端），秘密加密存在数据目录里 */
  get connections(): ConnectionStore {
    return (this._conns ??= new ConnectionStore(this.home, this.host.secrets ?? plainBox));
  }

  private _db?: DbEngine;
  /** 数据库引擎（只读）：按「设置 → 连接」里的数据库连接查询 */
  get db(): DbEngine {
    return (this._db ??= new DbEngine({
      auditFile: path.join(this.home, "db-audit.jsonl"),
      connections: {
        list: () => this.connections.list(),
        get: id => {
          const conn = this.connections.get(id);
          return conn && { conn, secrets: this.connections.secretsOf(id) };
        },
      },
    }));
  }

  private static readonly HOSTS_GITLAB_NAME = "GitLab（来自代码托管设置）";

  /** 「设置 → 代码托管」里配过 GitLab 令牌吗？有的话可以一键建 GitLab 连接（令牌只在主进程里搬，不经过界面） */
  gitlabHostsInfo(): { hasToken: boolean; url: string; exists: boolean } {
    const url = (this.config.gitHosts?.gitlab?.baseURL || "https://gitlab.com").trim().replace(/\/+$/, "");
    return { hasToken: !!this.getSecret("GITLAB_TOKEN"), url, exists: this.connections.list().some(c => c.kind === "gitlab" && c.name === Backend.HOSTS_GITLAB_NAME) };
  }

  connectionFromHosts(): { ok: boolean; conn?: Connection; error?: string } {
    const info = this.gitlabHostsInfo();
    if (!info.hasToken) return { ok: false, error: "「设置 → 代码托管」里还没有填 GitLab 令牌" };
    const exist = this.connections.list().find(c => c.kind === "gitlab" && c.name === Backend.HOSTS_GITLAB_NAME);
    return this.connectionSave({
      id: exist?.id,
      kind: "gitlab",
      name: Backend.HOSTS_GITLAB_NAME,
      env: exist?.env ?? "生产",
      machine: exist?.machine ?? "",
      fields: { ...DEFAULTS.gitlab, ...(exist?.fields ?? {}), url: info.url, authMethod: "token" },
      secrets: { token: this.getSecret("GITLAB_TOKEN") },
    });
  }

  connectionList(): Connection[] {
    return this.connections.list();
  }

  connectionSave(input: ConnectionInput): { ok: boolean; conn?: Connection; error?: string } {
    try {
      const conn = this.connections.save(input);
      if (input.id) {
        this._pluginHost?.forgetConnection(input.id);
        void this._db?.closeConnection(input.id);
      }
      this.host.send("connections:changed", null);
      return { ok: true, conn };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  connectionRemove(id: string): { ok: boolean; error?: string } {
    const r = this.connections.remove(id);
    if (r.ok) {
      this._pluginHost?.forgetConnection(id);
      void this._db?.closeConnection(id);
      this.host.send("connections:changed", null);
      return { ok: true };
    }
    return { ok: false, error: r.usedBy ? `还有内嵌终端连接在用它：${r.usedBy.join("、")}，先改掉那边再删` : "这个连接已经不存在了" };
  }

  connectionToggle(id: string, enabled: boolean): { ok: boolean; error?: string } {
    try {
      this.connections.setEnabled(id, enabled);
      if (!enabled) {
        this._pluginHost?.forgetConnection(id);
        void this._db?.closeConnection(id);
      }
      this.host.send("connections:changed", null);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 测试连接：用界面上填的内容，秘密留空时用已保存的 */
  connectionTest(input: ConnectionInput): Promise<ConnTestResult> {
    const saved = input.id ? this.connections.secretsOf(input.id) : {};
    return testConnection(input, saved, {
      serverFields: id => this.connections.get(id)?.fields,
      dbLogin: (fields, secrets) => this.db.probe({ fields } as never, secrets),
    });
  }

  private _repos?: PluginRepos;
  get pluginRepos(): PluginRepos {
    return (this._repos ??= new PluginRepos(path.join(this.home, "plugin-repos.json"), {
      id: "dbx",
      name: DBX_SOURCE,
      url: process.env.HARNESS_DBX_CATALOG || DBX_CATALOG_URL,
      official: true,
      enabled: true,
    }));
  }

  pluginRepoList(): PluginRepo[] {
    return this.pluginRepos.list();
  }

  async pluginRepoAdd(input: { id: string; name?: string; url: string }): Promise<{ ok: boolean; error?: string }> {
    try {
      this.pluginRepos.add(input);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  pluginRepoRemove(id: string): { ok: boolean; error?: string } {
    try {
      return this.pluginRepos.remove(id) ? { ok: true } : { ok: false, error: "没有这个仓库" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  pluginRepoToggle(id: string, enabled: boolean): { ok: boolean; error?: string } {
    try {
      this.pluginRepos.setEnabled(id, enabled);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 装本地选的 / 拖进来的 .dbxp 包 */
  async pluginInstallPackage(bytes: Uint8Array): Promise<{ ok: boolean; id?: string; name?: string; version?: string; error?: string }> {
    try {
      await this._pluginHost?.stopAll(); // 覆盖安装时后台程序可能正占着文件
      return { ok: true, ...this.dbx.installPackage(Buffer.from(bytes)) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async pluginInstallUrl(url: string): Promise<{ ok: boolean; id?: string; name?: string; version?: string; error?: string }> {
    try {
      await this._pluginHost?.stopAll();
      return { ok: true, ...(await this.dbx.installUrl(url)) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  pluginDir(): string {
    return this.dbx.pluginDir;
  }

  private _dbx?: DbxBridge;
  private get dbx(): DbxBridge {
    return (this._dbx ??= new DbxBridge(fetch, { extraRepos: () => this.pluginRepos.extra(), localDir: process.env.HARNESS_PLUGINS_DIR || path.join(this.home, "plugins"), catalogUrl: process.env.HARNESS_DBX_CATALOG || undefined, dataDir: process.env.HARNESS_DBX_DIR || undefined, mcp: process.env.HARNESS_DBX_MCP ? { command: process.env.HARNESS_DBX_MCP, args: [] } : undefined }));
  }

  /** 插件商店：DBX 官方插件中心的插件，并带上本机 DBX 的情况（技能 / MCP / 规则 / 动作不是插件，在设置里管理） */
  async pluginMarket(refresh = false): Promise<MarketResult> {
    const r: MarketResult = { entries: [], errors: [], dbx: this.dbx.info() };
    const rep = await this.dbx.catalogReport(refresh);
    r.entries = rep.entries;
    r.errors.push(...rep.errors);
    return r;
  }

  private _pluginHost?: PluginHost;
  /** 插件运行时：界面文件服务 + 后台程序管理 */
  get pluginHost(): PluginHost {
    return (this._pluginHost ??= new PluginHost({
      localDir: process.env.HARNESS_PLUGINS_DIR || path.join(this.home, "plugins"),
      dataRoot: path.join(this.home, "plugin-data"),
      consentFile: path.join(this.home, "plugin-consent.json"),
      grantsFile: path.join(this.home, "plugin-db-grants.json"),
      db: this.db,
      // 仅自动化测试用：让后台程序可以是一段脚本（正式插件都是原生程序）
      launch: process.env.HARNESS_PLUGIN_SCRIPT_HOST ? exe => ({ command: process.execPath, args: [exe], env: { ELECTRON_RUN_AS_NODE: "1" } }) : undefined,
      onEvent: (id, method, params) => this.host.send("pluginhost:event", { id, method, params }),
      connections: {
        list: kind => this.connections.list().filter(c => c.kind === kind),
        get: id => {
          const conn = this.connections.get(id);
          return conn && { conn, secrets: this.connections.secretsOf(id) };
        },
      },
    }));
  }

  /** 连接类插件可选的连接 */
  pluginConnections(id: string): import("../shared/pluginhost").PluginConn[] {
    return this.pluginHost.connectionsFor(id);
  }

  pluginUiList(): UiPlugin[] {
    return this.pluginHost.list();
  }

  /** 首页「今日待办」：读「待办 Todo」插件的数据（用它自己的后台程序，和打开插件看到的是同一份） */
  async homeTodos(): Promise<HomeTodosDTO> {
    const p = this.pluginHost.list().find(x => x.id.toLowerCase() === TODO_PLUGIN_ID);
    if (!p) return { state: "none", items: [] };
    if (!p.trusted) return { state: "untrusted", items: [] };
    const r = await this.pluginHost.request(p.id, "backend.invoke", { method: "todos/load", params: {}, timeoutMs: 15_000 });
    if (!r.ok) return { state: "error", items: [], error: r.error };
    return { state: "ok", items: pickTodayTodos((r.result as { data?: unknown } | null)?.data) };
  }

  pluginTrust(id: string, grants?: string[]): boolean {
    return this.pluginHost.trust(id, Array.isArray(grants) ? grants.map(String) : undefined);
  }

  /** 数据库页（工作台）：界面调用都走这里，异常变成 {ok:false}，不让它穿过进程边界 */
  async dbCall<T>(fn: (db: DbEngine) => Promise<T>): Promise<import("../shared/db").DbResp<T>> {
    try {
      return { ok: true, data: await fn(this.db) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), code: (e as { code?: string })?.code };
    }
  }

  /** 数据库类插件：能选的数据库连接，和已授权的 */
  pluginDbAccess(id: string): import("../shared/pluginhost").PluginDbAccess {
    return this.pluginHost.dbAccess(id);
  }

  pluginSetGrants(id: string, ids: string[]): void {
    this.pluginHost.setGrants(id, Array.isArray(ids) ? ids.map(String) : []);
  }

  pluginRequest(id: string, method: string, params: unknown): Promise<PluginReply> {
    return this.pluginHost.request(id, method, params);
  }

  /** 直接把目录里的插件装到本软件的插件目录（下载 + 校验 + 解压），不需要 DBX */
  async pluginInstall(id: string): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      await this._pluginHost?.stop(id); // 更新时先停掉后台程序，不然文件被占用
      return { ok: true, version: await this.dbx.install(id) };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  async pluginUninstall(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      await this._pluginHost?.stop(id);
      return this.dbx.uninstall(id) ? { ok: true } : { ok: false, error: "本软件里没有装这个插件" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  feishuSpaces() {
    return feishuProjectSpaces(this.config.integrations.feishuProject ?? { bin: "meegle" });
  }

  async listTools(): Promise<ToolInfo[]> {
    await this.rt.prepare().catch(() => {});
    return this.rt.tools.map(t => ({ name: t.name, desc: t.description.split(/\r?\n/)[0].slice(0, 120), risk: t.risk }));
  }

  // ───────────── MCP / 技能 / 规则 ─────────────

  async mcpStatus(): Promise<McpServerDTO[]> {
    await this.mcp.ensure(50); // 只负责启动连接，不等连完；界面轮询状态
    return this.mcpDto();
  }

  async mcpReconnect(name: string): Promise<McpServerDTO[]> {
    void this.mcp.reconnect(name);
    await new Promise(r => setTimeout(r, 50));
    return this.mcpDto();
  }

  private mcpDto(): McpServerDTO[] {
    return this.mcp.status().map(s => ({
      name: s.name,
      state: s.state,
      error: s.error,
      transport: s.transport,
      target: s.target,
      tools: s.tools.map(t => ({ name: t.name, desc: t.description.split(/\r?\n/)[0].slice(0, 160), risk: t.risk, enabled: t.enabled })),
    }));
  }

  private get workspaceDir(): string {
    return this.resolve(this.config.workspace);
  }

  private get skillsDir(): string {
    return path.join(this.home, "skills");
  }

  listSkills(): SkillDTO[] {
    const home = path.resolve(this.skillsDir).toLowerCase();
    return this.rt.allSkills(this.workspaceDir).map(s => ({
      name: s.name,
      description: s.description,
      source: s.source,
      dir: s.dir,
      enabled: s.enabled,
      editable: s.source === "app" && path.resolve(s.dir).toLowerCase().startsWith(home),
    }));
  }

  readSkill(name: string): { ok: boolean; content?: string; error?: string } {
    const s = this.rt.allSkills(this.workspaceDir).find(x => x.name === name);
    if (!s) return { ok: false, error: "找不到该技能" };
    return { ok: true, content: fs.readFileSync(s.file, "utf8") };
  }

  saveSkill(req: { name: string; description: string; content: string }): { ok: boolean; error?: string } {
    const name = String(req.name ?? "").trim();
    if (!SKILL_NAME.test(name)) return { ok: false, error: "技能名只能包含字母、数字、短横线和下划线，且不超过 64 个字符" };
    const desc = String(req.description ?? "").replace(/\r?\n/g, " ").trim();
    const body = String(req.content ?? "").trim();
    if (!body) return { ok: false, error: "技能内容不能为空" };
    const dir = path.join(this.skillsDir, name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${JSON.stringify(desc)}\n---\n${body}\n`, "utf8");
    return { ok: true };
  }

  deleteSkill(name: string): { ok: boolean; error?: string } {
    const s = this.listSkills().find(x => x.name === name);
    if (!s?.editable) return { ok: false, error: "只能删除在这里新建的技能" };
    fs.rmSync(s.dir, { recursive: true, force: true });
    return { ok: true };
  }

  rulesPreview(): RuleFileDTO[] {
    if (!this.config.rules.useProjectFiles) return [];
    return loadProjectRules(this.workspaceDir).map(f => ({ file: f.file, title: f.title, kind: f.kind, description: f.description, chars: f.chars }));
  }

  private modelCache?: Record<string, { at: number; res: KeyProbeDTO }>;
  private modelInflight = new Map<string, Promise<KeyProbeDTO>>();
  private static MODEL_TTL = 10 * 60_000;

  private modelCacheFile(): string {
    return path.join(this.home, "models-cache.json");
  }

  private loadModelCache(): Record<string, { at: number; res: KeyProbeDTO }> {
    if (!this.modelCache) {
      try {
        this.modelCache = JSON.parse(fs.readFileSync(this.modelCacheFile(), "utf8"));
      } catch {
        this.modelCache = {};
      }
    }
    return this.modelCache!;
  }

  /**
   * 某个 provider 的可选模型：先看缓存（内存 + 磁盘，Key 变了自动失效），过期或 refresh 才联网；
   * 同一 provider 的并发请求合并成一次；只取模型，不查账号信息。
   */
  providerModels(name: string, opts: { refresh?: boolean; cacheOnly?: boolean } = {}): Promise<KeyProbeDTO> {
    const c: any = this.config.providers[name];
    if (!c) return Promise.resolve({ ok: false, error: `未知 provider：${name}` });
    const key = [name, c.type, c.baseURL ?? "", createHash("sha1").update(String(c.apiKey ?? "")).digest("hex").slice(0, 12)].join("|");
    const cache = this.loadModelCache();
    const hit = cache[key];
    if (opts.cacheOnly) return Promise.resolve(hit ? { ...hit.res, cached: true, at: hit.at } : { ok: false, cached: true });
    if (hit && !opts.refresh && Date.now() - hit.at < Backend.MODEL_TTL) return Promise.resolve({ ...hit.res, cached: true, at: hit.at });
    const running = this.modelInflight.get(key);
    if (running) return running;
    const p = probeKey({ type: c.type, baseURL: c.baseURL, apiKey: c.apiKey, skipUser: true })
      .then((r): KeyProbeDTO => {
        const at = Date.now();
        if (r.ok && r.models?.length) {
          cache[key] = { at, res: { ok: true, models: r.models, labels: r.labels } };
          try {
            fs.writeFileSync(this.modelCacheFile(), JSON.stringify(cache), "utf8");
          } catch {
            /* 缓存写不进去不影响使用 */
          }
          return { ...r, at };
        }
        // 联网失败但手上有旧列表：继续给旧的（标明是缓存），比报错有用
        return hit ? { ...hit.res, cached: true, at: hit.at } : r;
      })
      .finally(() => this.modelInflight.delete(key));
    this.modelInflight.set(key, p);
    return p;
  }

  // ───────────── API Key（.env）与模型列表 ─────────────

  private static ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

  getSecret(name: string): string {
    return Backend.ENV_NAME.test(name) ? (process.env[name] ?? "") : "";
  }

  setSecret(name: string, value: string): { ok: boolean; error?: string } {
    if (!Backend.ENV_NAME.test(name)) return { ok: false, error: `非法变量名：${name}` };
    if (/[\r\n"'\\]/.test(value)) return { ok: false, error: "Key 里不能包含换行、引号或反斜杠" };
    const file = path.join(this.home, ".env");
    const lines = fs.existsSync(file) ? fs.readFileSync(file, "utf8").split(/\r?\n/) : [];
    while (lines.length && lines[lines.length - 1].trim() === "") lines.pop();
    const line = `${name}=${/[\s#]/.test(value) ? `"${value}"` : value}`;
    const re = new RegExp(`^\\s*(export\\s+)?${name}\\s*=`);
    const i = lines.findIndex(l => re.test(l));
    if (i >= 0) lines[i] = line;
    else lines.push(line);
    fs.writeFileSync(file, lines.join("\n") + "\n", "utf8");
    process.env[name] = value;
    this.reload();
    return { ok: true };
  }

  listModels(req: { type?: string; baseURL?: string; apiKey?: string }): Promise<KeyProbeDTO> {
    return probeKey(req);
  }

  // ───────────── 运行 ─────────────

  async run(req: RunRequest): Promise<RunOutcome> {
    const ac = new AbortController();
    this.runs.set(req.runKey, ac);
    try {
      const r = await this.rt.runTask({
        input: req.input,
        provider: req.provider,
        history: req.history,
        workspace: req.workspace,
        model: req.model,
        disabledTools: req.disabledTools,
        mode: "local",
        signal: ac.signal,
        approve: ({ tool, args, reason }) => this.askApproval(req.runKey, tool, args, reason),
        emit: (e: HarnessEvent) => this.host.send("run:event", { runKey: req.runKey, event: e }),
      });
      return {
        reason: r.reason,
        text: r.text,
        error: r.error,
        steps: r.steps,
        tokens: r.tokens,
        messages: r.messages,
        traceFile: r.traceFile,
        runId: r.runId,
      };
    } catch (e: any) {
      // 例如 provider 缺 Key：作为一次失败的运行返回，而不是让 IPC 抛异常
      return { reason: "error", text: "", error: e?.message ?? String(e), steps: 0, tokens: 0, messages: req.history, traceFile: "", runId: "" };
    } finally {
      this.runs.delete(req.runKey);
      this.denyPending(req.runKey);
    }
  }

  // ───────────── 缺陷提醒 ─────────────

  /** 项目管理只接一个：同时配了就用飞书（和工作台一致） */
  private defectSource(): { kind: "feishu"; cfg: NonNullable<Backend["config"]["integrations"]["feishuProject"]> } | { kind: "dingtalk"; cfg: { bin: string } & NonNullable<Backend["config"]["integrations"]["dingtalkProject"]> } | undefined {
    const fp = this.config.integrations.feishuProject;
    if (fp) return { kind: "feishu", cfg: fp };
    const dp = this.config.integrations.dingtalkProject;
    if (dp) return { kind: "dingtalk", cfg: { ...dp, bin: this.config.integrations.dingtalk?.bin ?? "dws" } };
    return undefined;
  }

  private _defects?: DefectWatcher;
  get defects(): DefectWatcher {
    return (this._defects ??= new DefectWatcher(
      path.join(this.home, "defects.json"),
      async () => {
        const s = this.defectSource();
        if (!s) return { enabled: false, ok: true, items: [], at: Date.now() };
        return s.kind === "feishu" ? fetchFeishuDefects(s.cfg) : fetchDingtalkDefects(s.cfg);
      },
      r => this.host.send("defects:changed", r),
      items => {
        const src = this.defectSource()?.kind ?? "feishu";
        const first = items[0];
        this.host.notify?.(items.length === 1 ? `${ENTRY_NAME[src]}：有新的问题指派给你` : `${ENTRY_NAME[src]}：有 ${items.length} 个新的问题指派给你`, items.length === 1 ? first.title : `${first.title} 等`);
      },
    ));
  }

  /** 应用启动后开始定时拉取（默认 3 分钟一次） */
  startDefects(): void {
    this.defects.start(Number(process.env.HARNESS_DEFECT_POLL_MS) || 3 * 60_000, Number(process.env.HARNESS_DEFECT_FIRST_MS) || 2000);
  }

  async defectsGet(): Promise<DefectsResult> {
    return this.defects.get() ?? this.defects.refresh();
  }

  async defectTransitions(key: string): Promise<DefectTransitions> {
    const d = this.defects.find(key);
    const s = this.defectSource();
    if (!d || !s || d.source !== s.kind) return { ok: false, items: [], error: "这个问题已经不在列表里了，请刷新" };
    return s.kind === "feishu" ? feishuTransitions(s.cfg, d) : dingtalkTransitions();
  }

  async defectTransition(key: string, transitionId: string): Promise<DefectActResult> {
    const d = this.defects.find(key);
    const s = this.defectSource();
    if (!d || !s || d.source !== s.kind) return { ok: false, error: "这个问题已经不在列表里了，请刷新" };
    const r = s.kind === "feishu" ? await feishuTransition(s.cfg, d, transitionId) : await dingtalkTransition(s.cfg, d, transitionId);
    if (r.ok) void this.defects.refresh();
    return r;
  }

  // ───────────── 自动化任务 ─────────────

  private _auto?: AutomationEngine;
  get automation(): AutomationEngine {
    return (this._auto ??= new AutomationEngine(path.join(this.home, "automations.json"), (a, signal) => this.runAutomation(a, signal), () => this.host.send("automation:changed", null)));
  }

  /** 应用启动后开始按计划触发 */
  startAutomation(): void {
    this.automation.start(Number(process.env.HARNESS_AUTOMATION_TICK_MS) || 15_000);
  }

  /** 无人值守地跑一次：只读模式不给写入 / 执行类工具，需要确认的操作一律拒绝 */
  private async runAutomation(a: Automation, signal: AbortSignal): Promise<RunResult> {
    const key = `auto:${a.id}:${Date.now()}`;
    try {
      await this.rt.prepare().catch(() => {});
      const off = a.access === "ask" ? undefined : this.rt.tools.filter(t => t.risk === "write" || t.risk === "exec").map(t => t.name);
      const r = await this.rt.runTask({
        input: a.prompt,
        provider: a.provider || this.config.defaultProvider,
        history: [],
        workspace: a.workspace,
        model: a.model,
        disabledTools: off?.length ? off : undefined,
        mode: "local",
        signal,
        approve: a.access === "ask" ? ({ tool, args, reason }) => this.askApproval(key, tool, args, reason) : async () => false,
        emit: () => {},
      });
      if (r.reason === "final") return { status: "done", text: r.text || "（模型没有返回内容）", traceFile: r.traceFile };
      return { status: r.reason === "aborted" ? "aborted" : "error", text: r.text, error: r.error ?? r.reason, traceFile: r.traceFile };
    } catch (e: any) {
      return { status: "error", text: "", error: e?.message ?? String(e) };
    } finally {
      this.denyPending(key);
    }
  }

  abort(runKey: string): void {
    this.runs.get(runKey)?.abort();
    this.denyPending(runKey);
  }

  private askApproval(runKey: string, tool: Tool, args: unknown, reason: string): Promise<boolean> {
    if (this.alwaysAllow.has(tool.name)) return Promise.resolve(true);
    const id = `ap-${++this.approvalSeq}`;
    return new Promise<boolean>(resolve => {
      this.pending.set(id, { runKey, tool: tool.name, resolve });
      const req: ApprovalRequest = { id, runKey, tool: tool.name, risk: tool.risk, reason, args };
      this.host.send("approval:request", req);
    });
  }

  respondApproval(id: string, approved: boolean, remember: boolean): void {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    p.resolve(approved);
    // 记住的是工具名，只在本次应用运行期间有效；危险命令规则仍然优先拦截
    if (approved && remember) this.alwaysAllow.add(p.tool);
  }

  private denyPending(runKey: string) {
    for (const [id, p] of this.pending) {
      if (p.runKey === runKey) {
        this.pending.delete(id);
        p.resolve(false);
      }
    }
  }

  // ───────────── Trace ─────────────

  listTraces(): TraceInfo[] {
    const dir = this.resolve(this.config.traceDir);
    if (!fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter(f => f.endsWith(".jsonl"))
      .map(f => {
        const file = path.join(dir, f);
        const st = fs.statSync(file);
        let input = "";
        let provider = "";
        let reason = "";
        try {
          const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
          const e = JSON.parse(lines[0]).event;
          if (e?.type === "run_start") {
            input = e.input;
            provider = e.provider;
          }
          const last = JSON.parse(lines[lines.length - 1]).event;
          if (last?.type === "done") reason = last.reason;
        } catch {
          /* 忽略损坏的 trace */
        }
        return { file, name: f.replace(/\.jsonl$/, ""), mtime: st.mtimeMs, size: st.size, input, provider, reason };
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 300);
  }

  readTrace(file: string): TraceLineDTO[] {
    const dir = this.resolve(this.config.traceDir);
    const abs = path.resolve(file);
    // 只允许读 trace 目录内的 jsonl，防止渲染进程被利用来读任意文件
    if (path.dirname(abs).toLowerCase() !== dir.toLowerCase() || !abs.endsWith(".jsonl")) {
      throw new Error("非法的 trace 路径");
    }
    return readTrace(abs).map(l => ({ ts: l.ts, event: l.event }));
  }

  // ───────────── 飞书通道 ─────────────

  private log(line: string) {
    const s = `${new Date().toLocaleTimeString()} ${line}`;
    this.channelLogs.push(s);
    if (this.channelLogs.length > 500) this.channelLogs.splice(0, 100);
    this.host.send("channel:log", s);
  }

  channelStart(): { ok: boolean; error?: string } {
    if (this.lark) return { ok: true };
    const cfg = this.config.channels.larkCli;
    if (!cfg) return { ok: false, error: "配置里没有 channels.larkCli，请先在「设置」里添加" };
    const sessions = new SessionManager(this.rt, l => this.log(l));
    const ch = new LarkCliChannel(cfg, l => this.log(l));
    ch.start(m => void sessions.handle(m));
    this.lark = ch;
    this.log("飞书通道启动中…");
    return { ok: true };
  }

  channelStop(): void {
    if (!this.lark) return;
    this.lark.stop();
    this.lark = undefined;
    this.log("飞书通道已停止");
  }

  dispose(): void {
    for (const ac of this.runs.values()) ac.abort();
    this._auto?.stop();
    this._defects?.stop();
    void this._pluginHost?.stopAll();
    void this._db?.closeAll();
    for (const a of this._auto?.list() ?? []) this._auto?.abort(a.id);
    this.channelStop();
    void this.mcp.dispose();
  }
}

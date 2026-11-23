import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { LarkCliChannel } from "../../src/channels/lark-cli";
import { SessionManager } from "../../src/channels/session";
import { dropMockProviders, loadConfig, parseConfig, type HarnessConfig } from "../../src/config";
import { readTrace } from "../../src/core/trace";
import type { AskAnswer, AskQuestion, HarnessEvent, Tool } from "../../src/core/types";
import { McpManager } from "../../src/mcp/manager";
import { loadProjectRules } from "../../src/prompt/rules";
import { SKILL_NAME } from "../../src/prompt/skills";
import { Runtime } from "../../src/runtime";
import { probeKey } from "../../src/models/probe";
import { dwsCheckUpdate, dwsStatus, installCli, larkCheckUpdate, larkStatus, loginCli, type LoginHooks } from "../../src/tools/cli-status";
import { feishuProjectSpaces, feishuProjectStatus } from "../../src/tools/feishu-project";
import { PluginMarket } from "./plugins";
import { AutomationEngine, type RunResult } from "./automation";
import { DefectWatcher } from "./defects";
import { dingtalkTransition, dingtalkTransitions, feishuTransition, feishuTransitions, fetchDingtalkDefects, fetchFeishuDefects } from "./defects-source";
import { ENTRY_NAME, type DefectActResult, type DefectsResult, type DefectTransitions } from "../shared/defects";
import { DbxBridge } from "./dbx";
import { DshPlugins } from "./dsh-host";
import { netError } from "./neterr";
import { PluginHost } from "./pluginhost";
import { PluginAi, type AiHost } from "./plugin-ai";
import { ConnectionStore, plainBox, type SecretBox } from "./connections";
import { testConnection } from "./conn-test";
import { DbEngine } from "./db-engine";
import { DEFAULTS, type ConnTestResult, type Connection, type ConnectionInput } from "../shared/connections";
import { lostRepos, REPOS_BACKUP } from "./config-guard";
import { checkRepoUrl, PluginRepos, seedRepos } from "./pluginrepos";
import type { PluginReply, UiPlugin } from "../shared/pluginhost";
import { TODO_PLUGIN_ID, pickTodayTodos, type HomeTodosDTO } from "../shared/todos";
import type { Automation } from "../shared/automation";
import { applyInstall, applyUninstall, DBX_CATALOG_URL, installedOf, isForeignId, OFFICIAL_REPO_URL, parseMarketplace, partsText, type LocalPluginInfo, type MarketResult, type PluginEntry, type PluginRepo, type PlatformInfo, type ResourceItem, type ResourceScan } from "../shared/plugins";
import { BUNDLED } from "./plugin-catalog";
import { importGithubRepo, parseGithubUrl } from "./repo-import";
import { copySkillFiles, PLATFORM_IDS, PLATFORM_NAME, platformFound, scanLocalFolder, scanPlatform, type LocalScan, type PlatformId } from "./local-import";
import { createChat, fetchWorkItemChat, inspectChat, parseChatRef, type WorkChat } from "../../src/tools/work-chat";
import { fetchDingtalkTodos, fetchFeishuTodos, sortTodos, createFeishuSubtask, updateFeishuSubtask, type SubtaskCreated, type SubtaskResult, type SubtaskUpdate, type TodoSource } from "../../src/tools/workbench";
import { addChild, patchChild } from "../shared/todoPatch";
import { branchInfo, cloneRepo, detectBaseBranch, diffStat, inspectRepo, listBranches, repoStatus, switchBranch, syncBaseBranch } from "../../src/tools/git";
import { authEnvFor, hostEnabled, probeHost } from "../../src/tools/git-hosts";
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
  private asks = new Map<string, { runKey: string; questions: AskQuestion[]; resolve: (a: AskAnswer[] | null) => void }>();
  private askSeq = 0;
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
      this.rt = new Runtime(config, { mcp: this.mcp, home: this.home, extra: this.pluginAiExtra });
      this.configError = undefined;
    } catch (e: any) {
      this.configError = e?.message ?? String(e);
      this.rt ??= new Runtime(parseConfig({}), { mcp: this.mcp, home: this.home, extra: this.pluginAiExtra });
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

  /** 配置文件当前的原文（界面改配置前重新读一遍，避免用过期的副本把别处刚改的盖掉） */
  configText(): string {
    return fs.readFileSync(this.configFile, "utf8");
  }

  saveConfig(text: string): { ok: boolean; error?: string } {
    try {
      parseConfig(JSON.parse(text.replace(/^\uFEFF/, "")));
    } catch (e: any) {
      return { ok: false, error: e?.issues ? JSON.stringify(e.issues.slice(0, 3), null, 2) : (e?.message ?? String(e)) };
    }
    // 这次保存会让已登记的仓库变少：先把旧文件留一份（单个仓库被「移除」也会留，只留最近一次）
    try {
      const prev = fs.readFileSync(this.configFile, "utf8");
      if (lostRepos(prev, text).length) fs.writeFileSync(path.join(this.home, REPOS_BACKUP), prev, "utf8");
    } catch {
      // 读不到旧文件就不备份，不挡保存
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

  branchInfo(dir: string) {
    return branchInfo(path.resolve(dir));
  }

  switchBranch(dir: string, branch: string) {
    return switchBranch(path.resolve(dir), String(branch));
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

  /** 一键安装 / 升级官方 CLI（npm install -g）。登录仍需用户在终端完成 */
  integrationInstall(kind: string) {
    return installCli(kind, this.cliSpec(kind).bin);
  }

  /** 一键登录：走官方设备授权 / OAuth，链接由 hooks 交给界面打开；同一个 CLI 同时只允许一个登录流程 */
  private loggingIn = new Set<string>();
  async integrationLogin(kind: string, hooks: LoginHooks) {
    if (this.loggingIn.has(kind)) return { ok: false, message: "已经有一个登录流程在进行" };
    this.loggingIn.add(kind);
    try {
      return await loginCli(kind, this.cliSpec(kind), hooks);
    } finally {
      this.loggingIn.delete(kind);
    }
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
    const res = { feishu, dingtalk, items: sortTodos([...feishu.items, ...dingtalk.items]) };
    // 读成功的才落盘：下次打开工作台先显示这份，再在后台刷新（读一遍要十几秒）
    if (feishu.ok || dingtalk.ok) {
      try {
        fs.writeFileSync(path.join(this.home, "workbench-cache.json"), JSON.stringify({ at: Date.now(), ...res }), "utf8");
      } catch {
        /* 缓存写不了不影响使用 */
      }
    }
    return res;
  }

  /** 工作台：在飞书项目里完成 / 回滚子任务、改子任务排期（只有接了飞书项目才能用）；成功后把本地缓存也改成最新的 */
  async workbenchSubtaskUpdate(req: SubtaskUpdate): Promise<SubtaskResult> {
    const fp = this.config.integrations.feishuProject;
    if (!fp) return { ok: false, error: "还没有接入飞书项目" };
    const r = await updateFeishuSubtask(fp, req);
    if (r.child) {
      const cache = this.workbenchTodosCached();
      if (cache) {
        try {
          const items = patchChild(cache.feishu.items as never, req.wid, req.subId, r.child) as unknown as typeof cache.feishu.items;
          const merged = { ...cache, feishu: { ...cache.feishu, items }, items: patchChild(cache.items as never, req.wid, req.subId, r.child) as unknown as typeof cache.items };
          fs.writeFileSync(path.join(this.home, "workbench-cache.json"), JSON.stringify(merged), "utf8");
        } catch {
          /* 缓存没改成只影响下次先显示的内容，刷新后会更新 */
        }
      }
    }
    return r;
  }

  /** 工作台：在飞书项目的某个节点下新增子任务（负责人是当前登录账号）；成功后本地缓存也加上这一条 */
  async workbenchSubtaskCreate(req: { projectKey: string; wid: string; nodeKey: string; name: string }): Promise<SubtaskCreated> {
    const fp = this.config.integrations.feishuProject;
    if (!fp) return { ok: false, error: "还没有接入飞书项目" };
    const r = await createFeishuSubtask(fp, { projectKey: String(req?.projectKey ?? ""), wid: String(req?.wid ?? ""), nodeKey: String(req?.nodeKey ?? ""), name: String(req?.name ?? "") });
    if (r.ok && r.child) {
      const cache = this.workbenchTodosCached();
      if (cache) {
        try {
          const items = addChild(cache.feishu.items as never, req.wid, r.child as never) as unknown as typeof cache.feishu.items;
          const merged = { ...cache, feishu: { ...cache.feishu, items }, items: addChild(cache.items as never, req.wid, r.child as never) as unknown as typeof cache.items };
          fs.writeFileSync(path.join(this.home, "workbench-cache.json"), JSON.stringify(merged), "utf8");
        } catch {
          /* 缓存没改成只影响下次先显示的内容，刷新后会更新 */
        }
      }
    }
    return r;
  }

  /** 需求对应的飞书群（群 id 来自飞书项目的「拉群方式」字段，群名来自 lark-cli；群名读不到不影响） */
  async workItemChat(req: { projectKey?: string; wid: string; url?: string; chatId?: string }): Promise<WorkChat> {
    const lc = this.config.channels.larkCli;
    const lark = lc ? { bin: lc.bin, binArgs: lc.binArgs } : undefined;
    // 手动关联过群：直接查这个群，不再看飞书项目里的默认群
    if (typeof req?.chatId === "string" && req.chatId) {
      const id = parseChatRef(req.chatId);
      return id ? inspectChat(lark, id) : { ok: false, error: "群 ID 格式不对，应该是 oc_ 开头的一串字母数字（也可以直接贴群链接）" };
    }
    const fp = this.config.integrations.feishuProject;
    if (!fp) return { ok: false, error: "还没有接入飞书项目" };
    return fetchWorkItemChat(fp, lark, {
      projectKey: typeof req?.projectKey === "string" ? req.projectKey : undefined,
      wid: String(req?.wid ?? ""),
      url: typeof req?.url === "string" ? req.url : undefined,
    });
  }

  /** 新建一个飞书群（以 lark-cli 当前登录的用户身份）并返回群信息；群 ID 由调用方存到任务上 */
  async workItemChatCreate(req: { name: string; description?: string }): Promise<WorkChat> {
    const lc = this.config.channels.larkCli;
    return createChat(lc ? { bin: lc.bin, binArgs: lc.binArgs } : undefined, { name: String(req?.name ?? ""), description: typeof req?.description === "string" ? req.description : undefined });
  }

  /** 工作台待办：上一次读成功的结果（立即返回，没有就是 null）。只用来先显示，不代替 workbenchTodos */
  workbenchTodosCached(): (Awaited<ReturnType<Backend["workbenchTodos"]>> & { at: number }) | null {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(this.home, "workbench-cache.json"), "utf8"));
      return j && typeof j.at === "number" && j.feishu && j.dingtalk && Array.isArray(j.items) ? j : null;
    } catch {
      return null;
    }
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
    return { hasToken: !!this.getSecret("GITLAB_TOKEN") && hostEnabled(this.config.gitHosts, "gitlab"), url, exists: this.connections.list().some(c => c.kind === "gitlab" && c.name === Backend.HOSTS_GITLAB_NAME) };
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
    // 起步预置官方仓库和 DBX 仓库；之后和别的仓库一样随便停用、删除。
    // HARNESS_DBX_CATALOG / HARNESS_OFFICIAL_REPO（填 none 表示不预置）只在测试里用，让它们不联网
    const off = process.env.HARNESS_OFFICIAL_REPO;
    return (this._repos ??= new PluginRepos(path.join(this.home, "plugin-repos.json"), seedRepos(process.env.HARNESS_DBX_CATALOG || DBX_CATALOG_URL, off === "none" ? null : off || OFFICIAL_REPO_URL)));
  }

  pluginRepoList(): PluginRepo[] {
    return this.pluginRepos.list();
  }

  async pluginRepoAdd(input: { id?: string; name?: string; url: string }): Promise<{ ok: boolean; error?: string }> {
    try {
      this.pluginRepos.add(input);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 测试一个仓库地址：真的去读一次它的插件目录（不保存、不进缓存），成功给出插件数和几个名字，失败给原因 */
  async pluginRepoTest(input: { name?: string; url: string }): Promise<{ ok: boolean; count?: number; names?: string[]; error?: string }> {
    try {
      const url = checkRepoUrl(String(input.url ?? ""));
      const got = await this.dbx.testRepo({ id: "test", name: String(input.name ?? "").trim() || "测试", url, enabled: true });
      return { ok: true, count: got.entries.length, names: got.entries.slice(0, 5).map(e => e.name) };
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
    return (this._dbx ??= new DbxBridge(fetch, { repos: () => this.pluginRepos.extra(), localDir: process.env.HARNESS_PLUGINS_DIR || path.join(this.home, "plugins"), catalogUrl: process.env.HARNESS_DBX_CATALOG || undefined, dataDir: process.env.HARNESS_DBX_DIR || undefined, mcp: process.env.HARNESS_DBX_MCP ? { command: process.env.HARNESS_DBX_MCP, args: [] } : undefined }));
  }

  /** 插件商店：已启用的各个仓库里的插件（.dbxp），并带上本机 DBX 的情况。技能 / MCP / 规则 / 动作不是插件，在各自的设置页里管理 */
  async pluginMarket(refresh = false): Promise<MarketResult> {
    const r: MarketResult = { entries: [], errors: [], dbx: this.dbx.info() };
    const rep = await this.dbx.catalogReport(refresh);
    r.entries = rep.entries;
    r.errors.push(...rep.errors);
    // 别家的插件（DSH、Codex、Claude）也放进「已安装」这张表里，界面不用分开处理
    r.dbx!.local = { ...r.dbx!.local, ...this.dsh.localInfo(), ...this.bundleLocalInfo() };
    return r;
  }

  /** 已装的插件包（Codex / Claude）：从配置里的安装记录读 */
  private bundleLocalInfo(): Record<string, LocalPluginInfo> {
    const out: Record<string, LocalPluginInfo> = {};
    let cfg: Record<string, any>;
    try {
      cfg = this.readConfigObj();
    } catch {
      return out;
    }
    const all = installedOf(cfg);
    for (const [id, rec] of Object.entries(all)) {
      if (rec.kind !== "bundle") continue;
      const parts = { skills: 0, mcp: 0, actions: 0, rules: 0 };
      for (const m of rec.members ?? []) {
        const k = all[m]?.kind;
        if (k === "skill") parts.skills++;
        else if (k === "mcp") parts.mcp++;
        else if (k === "action") parts.actions++;
        else if (k === "rule") parts.rules++;
      }
      out[id] = { version: rec.version ?? "", name: rec.name, ecosystem: rec.ecosystem, summary: `已装进本软件：${partsText(parts)}（可到对应的设置页里单独开关或删除）`, ui: false, backend: false, permissions: [], kinds: ["bundle"], tools: 0 };
    }
    return out;
  }

  private _dsh?: DshPlugins;
  /** DSH 插件：安装和运行（装在 <数据目录>/dsh） */
  get dsh(): DshPlugins {
    return (this._dsh ??= new DshPlugins({ dir: process.env.HARNESS_DSH_DIR || path.join(this.home, "dsh"), consentFile: path.join(this.home, "dsh-consent.json") }));
  }

  /** 装一个 Codex / Claude 插件包：把里面的技能、MCP、动作、规则拆开写进本软件的配置 */
  private async installBundle(id: string): Promise<{ version?: string; note?: string }> {
    const entry = await this.dbx.findEntry(id);
    if (!entry || entry.install.kind !== "bundle") throw new Error("插件目录里没有这个插件");
    const got = await this.dbx.loadItems(id);
    if (!got?.items.length) throw new Error(`这个插件包里没有本软件能用的内容（技能、MCP、命令、规则）${got?.notes.length ? `：${got.notes.slice(0, 2).join("；")}` : ""}`);
    const items = got.items;
    const cfg = this.readConfigObj();
    const prev = installedOf(cfg)[id];
    const members: string[] = [];
    const notes: string[] = [...got.notes];
    const skills: Array<{ it: PluginEntry }> = [];
    for (const it of items) {
      const ins = it.install;
      if (ins.kind === "dbx" || ins.kind === "dsh" || ins.kind === "bundle") continue;
      if (ins.kind === "skill" && !installedOf(cfg)[it.key] && fs.existsSync(path.join(this.skillsDir, ins.name))) {
        notes.push(`技能「${ins.name}」本地已有同名的，没覆盖`);
        continue;
      }
      applyInstall(cfg, it);
      members.push(it.key);
      if (ins.kind === "skill") skills.push({ it });
    }
    if (!members.length) throw new Error(notes.join("；") || "没有可以装的内容");
    // 更新：新版本里没有了的旧内容一并清掉
    for (const old of prev?.members ?? []) {
      if (members.includes(old)) continue;
      const r = applyUninstall(cfg, old);
      if (r?.kind === "skill") this.removeSkillDir(r.ref);
    }
    cfg.plugins.installed[id] = { kind: "bundle", name: entry.name, version: entry.version, ref: id, at: Date.now(), members, ecosystem: entry.ecosystem };
    const saved = this.saveConfig(JSON.stringify(cfg, null, 2));
    if (!saved.ok) throw new Error(saved.error ?? "写入配置失败");
    for (const { it } of skills) {
      const ins = it.install as Extract<PluginEntry["install"], { kind: "skill" }>;
      const w = this.saveSkill({ name: ins.name, description: ins.description, content: ins.content });
      if (!w.ok) throw new Error(w.error);
      const failed = await this.downloadSkillFiles(path.join(this.skillsDir, ins.name), ins.files ?? []);
      if (failed.length) notes.push(`技能「${ins.name}」有 ${failed.length} 个附带文件没下载下来`);
    }
    return { version: entry.version, note: notes.length ? notes.join("；") : undefined };
  }

  private removeSkillDir(name: string): void {
    const root = path.resolve(this.skillsDir);
    const dir = path.resolve(root, name);
    if (dir.startsWith(root + path.sep)) fs.rmSync(dir, { recursive: true, force: true });
  }

  private uninstallBundle(id: string): boolean {
    const cfg = this.readConfigObj();
    const rec = installedOf(cfg)[id];
    if (!rec || rec.kind !== "bundle") return false;
    for (const m of rec.members ?? []) {
      const r = applyUninstall(cfg, m);
      if (r?.kind === "skill") this.removeSkillDir(r.ref);
    }
    delete cfg.plugins.installed[id];
    const saved = this.saveConfig(JSON.stringify(cfg, null, 2));
    if (!saved.ok) throw new Error(saved.error ?? "写入配置失败");
    return true;
  }

  // ───────── 技能 / MCP / 规则 / 动作的「推荐」和「从 GitHub 导入」（不是插件，各在自己的设置页里用） ─────────

  private resourceEntries = new Map<string, PluginEntry>();
  private resourceScans = new Map<string, { at: number; entries: PluginEntry[]; skipped: string[] }>();

  /** 这一项现在是不是还在配置里（用户在页面里删掉后，安装记录还在，所以要看实际有没有） */
  private resourcePresent(cfg: Record<string, any>, rec: { kind: string; ref: string }): boolean {
    if (rec.kind === "mcp") return !!cfg.mcpServers?.[rec.ref];
    if (rec.kind === "action") return (cfg.actions ?? []).some((a: any) => a.id === rec.ref);
    if (rec.kind === "rule") return (cfg.rules?.items ?? []).some((r: any) => r.id === rec.ref);
    return fs.existsSync(path.join(this.skillsDir, rec.ref));
  }

  private toResourceItems(entries: PluginEntry[]): ResourceItem[] {
    const cfg = this.readConfigObj();
    const out: ResourceItem[] = [];
    for (const e of entries) {
      if (e.kind === "dbx" || e.kind === "dsh" || e.kind === "bundle") continue;
      this.resourceEntries.set(e.key, e);
      const rec = installedOf(cfg)[e.key];
      out.push({
        key: e.key,
        kind: e.kind,
        name: e.name,
        description: e.description,
        author: e.author,
        tags: e.tags,
        source: e.source,
        homepage: e.homepage,
        note: e.install.kind === "mcp" ? e.install.note : undefined,
        added: !!rec && this.resourcePresent(cfg, rec),
      });
    }
    return out;
  }

  /** 软件自带的推荐（常用的 MCP、技能、动作、规则）：哪一页就给哪一类 */
  resourceRecommended(kind: string): ResourceItem[] {
    return this.toResourceItems(BUNDLED.filter(e => e.kind === kind));
  }

  /** 从 GitHub 仓库（链接或 owner/repo）或资源文件的直链里找技能 / MCP / 动作 / 规则；一次扫描的结果缓存 10 分钟 */
  async resourceScan(input: string): Promise<ResourceScan> {
    try {
      const raw = String(input ?? "").trim();
      if (!raw) return { ok: false, error: "请填 GitHub 仓库链接（或 owner/repo）" };
      const hit = this.resourceScans.get(raw);
      if (hit && Date.now() - hit.at < 10 * 60_000) return { ok: true, items: this.toResourceItems(hit.entries), skipped: hit.skipped };
      const gh = parseGithubUrl(raw);
      let got: { entries: PluginEntry[]; skipped: string[] };
      if (gh) {
        const name = `${gh.owner}/${gh.repo}${gh.dir ? `/${gh.dir}` : ""}`;
        got = await importGithubRepo(fetch, gh, name, () => {
          throw new Error("这是 DBX 插件目录，里面是插件不是技能 / MCP，请到「插件中心 → 设置 → 插件仓库」里添加");
        });
      } else {
        const url = checkRepoUrl(raw);
        const res = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: "application/json" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const text = await res.text();
        if (text.length > 2_000_000) throw new Error("文件太大（超过 2MB）");
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          throw new Error("这个地址返回的不是 JSON 文件。请填 GitHub 仓库链接，或资源文件本身的直链");
        }
        const host = new URL(url).host;
        const p = parseMarketplace(json, host);
        got = { entries: p.entries, skipped: p.skipped };
      }
      this.resourceScans.set(raw, { at: Date.now(), ...got });
      return { ok: true, items: this.toResourceItems(got.entries), skipped: got.skipped };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 本机来源的技能：条目 key → 技能所在的本机文件夹（添加时把附带文件拷过来） */
  private localSkillDirs = new Map<string, string>();

  private fromLocal(scan: LocalScan, source: string): ResourceScan {
    const p = parseMarketplace(scan.raw, source);
    for (const e of p.entries) {
      const dir = scan.skillDirs.get(e.id);
      if (dir) this.localSkillDirs.set(e.key, dir);
    }
    return { ok: true, items: this.toResourceItems(p.entries), skipped: [...scan.notes, ...p.skipped] };
  }

  /** 「加载」：用户选一个本机文件夹，在里面找技能 / MCP / 动作 / 规则 */
  async resourceScanLocal(dir: string): Promise<ResourceScan> {
    try {
      const d = String(dir ?? "").trim();
      if (!d) return { ok: false, error: "请选择一个文件夹" };
      return this.fromLocal(await scanLocalFolder(d), `本机:${d}`);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 「设置 → 模型」里添加过账号的平台（Cursor / Claude Code / Codex） */
  private configuredPlatforms(): Set<PlatformId> {
    const out = new Set<PlatformId>();
    for (const c of Object.values(this.config.providers) as any[]) {
      if (c?.type === "cursor-sdk") out.add("cursor");
      else if (c?.type === "cli") {
        const cmd = String(c.command ?? "").toLowerCase();
        if (c.preset === "codex" || /codex/.test(cmd)) out.add("codex");
        else if (c.preset === "claude-code" || /claude/.test(cmd)) out.add("claude");
        else if (c.preset === "cursor-cli" || /cursor/.test(cmd)) out.add("cursor");
      }
    }
    return out;
  }

  /** 「同步」能选的平台：哪些添加过账号、本机上有没有它的目录 */
  resourceSyncPlatforms(): PlatformInfo[] {
    const have = this.configuredPlatforms();
    return PLATFORM_IDS.map(id => ({ id, name: PLATFORM_NAME[id], configured: have.has(id), found: platformFound(id) }));
  }

  /** 「同步」：列出这个平台在本机已经有的技能 / MCP / 动作 / 规则，让用户挑着同步过来 */
  async resourceSyncScan(id: string): Promise<ResourceScan> {
    try {
      if (!(PLATFORM_IDS as string[]).includes(id)) return { ok: false, error: "不认识这个平台" };
      return this.fromLocal(await scanPlatform(id as PlatformId), `同步:${PLATFORM_NAME[id as PlatformId]}`);
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  private readConfigObj(): Record<string, any> {
    return JSON.parse(fs.readFileSync(this.configFile, "utf8").replace(/^\uFEFF/, "") || "{}");
  }

  /** 添加一项推荐 / 导入的技能、MCP、动作、规则：写进本软件的配置（技能同时写 SKILL.md） */
  async resourceAdd(key: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const entry = this.resourceEntries.get(key);
      if (!entry) return { ok: false, error: "找不到这一项了，请重新扫描一次" };
      if (entry.install.kind === "dbx" || entry.install.kind === "dsh" || entry.install.kind === "bundle") return { ok: false, error: "这是插件，请到插件中心安装" };
      const cfg = this.readConfigObj();
      const ins = entry.install;
      if (ins.kind === "skill" && !installedOf(cfg)[key] && fs.existsSync(path.join(this.skillsDir, ins.name))) {
        return { ok: false, error: `已经有一个叫「${ins.name}」的技能了，先把它删掉或改名，免得被覆盖` };
      }
      applyInstall(cfg, entry);
      const saved = this.saveConfig(JSON.stringify(cfg, null, 2));
      if (!saved.ok) return { ok: false, error: saved.error ?? "写入配置失败" };
      if (ins.kind === "skill") {
        const w = this.saveSkill({ name: ins.name, description: ins.description, content: ins.content });
        if (!w.ok) return { ok: false, error: w.error };
        const localDir = this.localSkillDirs.get(key);
        const skipped = localDir ? copySkillFiles(localDir, path.join(this.skillsDir, ins.name)) : await this.downloadSkillFiles(path.join(this.skillsDir, ins.name), ins.files ?? []);
        if (skipped.length) return { ok: true, error: `技能已添加，但有 ${skipped.length} 个附带文件没${localDir ? "拷" : "下载"}过来：${skipped.slice(0, 3).join("、")}` };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }

  /** 把技能文件夹里的附带文件（脚本、参考资料）下载到技能目录；返回没下下来的文件。每个最大 1MB，总共最多 8MB */
  private async downloadSkillFiles(dir: string, files: Array<{ path: string; url: string }>): Promise<string[]> {
    const failed: string[] = [];
    let total = 0;
    const root = path.resolve(dir);
    for (const f of files) {
      try {
        const target = path.resolve(root, f.path);
        if (!target.startsWith(root + path.sep)) throw new Error("路径不安全");
        let res = await fetch(f.url, { signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
        if (!res?.ok) {
          // raw.githubusercontent.com 连不上时换 jsDelivr 的镜像：raw.../owner/repo/ref/path → cdn.jsdelivr.net/gh/owner/repo@ref/path
          const m = /^https:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/.exec(f.url);
          res = m ? await fetch(`https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}@${m[3]}/${m[4]}`, { signal: AbortSignal.timeout(20_000) }) : res;
        }
        if (!res?.ok) throw new Error(`HTTP ${res?.status ?? "连不上"}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length > 1_000_000 || (total += buf.length) > 8_000_000) throw new Error("文件太大");
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buf);
      } catch {
        failed.push(f.path);
      }
    }
    return failed;
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

  private _pluginAi?: PluginAi;
  /** 让 AI 使用已装插件的工具（开关记在 plugin-ai.json） */
  get pluginAi(): PluginAi {
    return (this._pluginAi ??= new PluginAi(() => this.aiHost, path.join(this.home, "plugin-ai.json")));
  }

  /** AI 能用的插件来自两处：DBX 插件（PluginHost）和 DSH 插件（DshPlugins），按 id 前缀分流 */
  private aiHost: AiHost = {
    aiPlugins: () => [...this.pluginHost.aiPlugins(), ...this.dsh.aiPlugins()],
    aiTools: id => (id.startsWith("dsh:") ? this.dsh.aiTools(id) : this.pluginHost.aiTools(id)),
    aiCall: (id, tool, args, conn, timeoutMs) => (id.startsWith("dsh:") ? this.dsh.aiCall(id, tool, args, conn, timeoutMs) : this.pluginHost.aiCall(id, tool, args, conn, timeoutMs)),
  };

  /** 交给 Runtime 的：用到时才建插件运行时，没开 AI 使用时什么都不做 */
  private pluginAiExtra = {
    tools: () => this.pluginAi.tools(),
    prepare: () => this.pluginAi.prepare(),
  };

  pluginAiList(): Promise<import("../shared/pluginhost").PluginAiInfo[]> {
    return this.pluginAi.list();
  }

  pluginAiSet(id: string, on: boolean): void {
    this.pluginAi.setEnabled(String(id), !!on);
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
    if (isForeignId(id)) return this.dsh.trust(id);
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
  async pluginInstall(id: string): Promise<{ ok: boolean; version?: string; note?: string; error?: string }> {
    try {
      if (isForeignId(id)) {
        if (id.startsWith("dsh:")) {
          const e = await this.dbx.findEntry(id);
          if (!e) throw new Error("插件目录里没有这个插件");
          this.pluginAi.forget(id);
          const version = await this.dsh.install(e);
          return { ok: true, version, note: this.dsh.noteOf(id) };
        }
        return { ok: true, ...(await this.installBundle(id)) };
      }
      await this._pluginHost?.stop(id); // 更新时先停掉后台程序，不然文件被占用
      return { ok: true, version: await this.dbx.install(id) };
    } catch (e) {
      return { ok: false, error: netError(e) };
    }
  }

  async pluginUninstall(id: string): Promise<{ ok: boolean; error?: string }> {
    try {
      if (isForeignId(id)) {
        const done = id.startsWith("dsh:") ? await this.dsh.uninstall(id) : this.uninstallBundle(id);
        if (done) this.pluginAi.forget(id, true);
        return done ? { ok: true } : { ok: false, error: "本软件里没有装这个插件" };
      }
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
        ask: (questions, signal) => this.askUser(req.runKey, questions, signal),
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

  /** AI 向操作人提问：发给界面等回答；操作人跳过、运行被停止都返回 null */
  private askUser(runKey: string, questions: AskQuestion[], signal: AbortSignal): Promise<AskAnswer[] | null> {
    if (signal.aborted) return Promise.resolve(null);
    const id = `ask-${++this.askSeq}`;
    return new Promise(resolve => {
      const done = (a: AskAnswer[] | null) => {
        signal.removeEventListener("abort", onAbort);
        this.asks.delete(id);
        resolve(a);
      };
      const onAbort = () => done(null);
      signal.addEventListener("abort", onAbort, { once: true });
      this.asks.set(id, { runKey, questions, resolve: done });
      this.host.send("ask:request", { id, runKey, questions });
    });
  }

  /** 界面交回操作人的回答（null = 跳过）；只认问过的问题和选项里的内容，长度做限制 */
  respondAsk(id: string, answers: Array<{ id?: unknown; picked?: unknown; text?: unknown }> | null): void {
    const p = this.asks.get(id);
    if (!p) return;
    if (!Array.isArray(answers)) return p.resolve(null);
    p.resolve(
      p.questions.map(q => {
        const a = answers.find(x => x?.id === q.id);
        const picked = Array.isArray(a?.picked) ? a.picked.filter((x): x is string => typeof x === "string" && !!q.options?.includes(x)) : [];
        const text = typeof a?.text === "string" && q.allowText !== false ? a.text.trim().slice(0, 2000) : "";
        return { id: q.id, question: q.question, picked: q.multiple ? picked : picked.slice(0, 1), ...(text ? { text } : {}) };
      }),
    );
  }

  private denyPending(runKey: string) {
    for (const p of [...this.asks.values()]) if (p.runKey === runKey) p.resolve(null);
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
    void this._dsh?.stopAll();
    void this._db?.closeAll();
    for (const a of this._auto?.list() ?? []) this._auto?.abort(a.id);
    this.channelStop();
    void this.mcp.dispose();
  }
}

import type { AskAnswer, AskQuestion, HarnessEvent, Msg } from "../../src/core/types";

export type { AskAnswer, AskQuestion, HarnessEvent, Msg };

export interface ProviderInfo {
  name: string;
  desc: string;
  kind: "model" | "agent";
  /** 配置里的默认模型名（cli 没有） */
  model?: string;
  /** 创建失败的原因（如缺 Key），为空表示可用 */
  problem?: string;
}

export interface RepoStatusDTO {
  exists: boolean;
  branch?: string;
  changed: number;
  ahead: number;
  behind: number;
  last?: string;
  error?: string;
}

export interface ModelTestDTO {
  ok: boolean;
  error?: string;
  /** 实际使用的协议和地址（和填的不一样时，据此纠正配置） */
  type?: "openai-compat" | "anthropic";
  baseURL?: string;
  notes?: string[];
  ms?: number;
}

export interface KeyProbeDTO {
  ok: boolean;
  models?: string[];
  /** 模型 id → 展示名 */
  labels?: Record<string, string>;
  user?: { name?: string; email?: string; keyName?: string; createdAt?: string; note?: string };
  error?: string;
  /** 取自缓存（providerModels 才有）：true 表示这次没有联网 */
  cached?: boolean;
  /** 这份列表的获取时间（毫秒时间戳） */
  at?: number;
}

/** 首页：天气（按 IP 定位或指定城市） */
export interface WeatherDTO {
  ok: boolean;
  error?: string;
  /** true = 按本机 IP 定位；false = 用户指定的城市 */
  byIp: boolean;
  ip?: string;
  city?: string;
  region?: string;
  country?: string;
  current?: { temp: number; feels: number; humidity: number; wind: number; code: number; text: string; icon: string };
  daily?: Array<{ date: string; max: number; min: number; code: number; text: string; icon: string; pop?: number }>;
  /** 获取时间（毫秒时间戳） */
  at?: number;
  cached?: boolean;
  /** 联网失败，显示的是旧数据 */
  stale?: boolean;
}

/** 首页：每日一图一句 */
export interface DailyDTO {
  /** yyyy-mm-dd */
  date: string;
  /** data URL；断网且从没下载过时为空，界面用渐变色代替 */
  image?: string;
  title?: string;
  copyright?: string;
  quote: { text: string; author?: string };
}

/** 应用更新状态 */
/** 数据位置：当前目录 / 默认目录 / 界面存储（对话记录）目录 */
export interface DataDirDTO {
  current: string;
  defaultDir: string;
  isDefault: boolean;
  stateDir: string;
}

/** 开机自启动：supported=false 时 reason 说明为什么不能设置 */
export interface AutostartDTO {
  supported: boolean;
  enabled: boolean;
  reason?: string;
}

export interface UpdateStateDTO {
  state: "idle" | "checking" | "none" | "available" | "downloading" | "downloaded" | "error" | "unconfigured";
  /** 当前版本 */
  current: string;
  /** 最新版本（检查成功后才有） */
  latest?: string;
  /** Release 说明 */
  notes?: string;
  /** Release 页面 */
  url?: string;
  /** 下载进度 0-100 */
  percent?: number;
  error?: string;
  checkedAt?: number;
  /** 生效的仓库（owner/repo） */
  repo?: string;
  /** 能否应用内下载并重启安装；否则「更新」会打开下载页 */
  canAutoInstall: boolean;
}

export type IntegrationKind = "lark" | "meegle" | "dws";

export interface IntegrationStatusDTO {
  installed: boolean;
  authenticated: boolean;
  version?: string;
  user?: string;
  /** 飞书 open_id（lark） */
  openId?: string;
  host?: string;
  detail?: string;
}

export interface IntegrationUpdateDTO {
  supported: boolean;
  ok: boolean;
  current?: string;
  latest?: string;
  hasUpdate?: boolean;
  url?: string;
  message: string;
}

export interface HostProbeDTO {
  ok: boolean;
  user?: { name?: string; username?: string; email?: string; createdAt?: string; note?: string };
  error?: string;
}

export interface RepoSyncDTO {
  ok: boolean;
  branch?: string;
  base?: string;
  switched: boolean;
  pulled: boolean;
  /** 切分支前，因为有未提交改动而 stash 暂存的文件数 */
  stashed?: number;
  skipped?: string;
  error?: string;
}

export interface StartBranchDTO {
  name: string;
  ok: boolean;
  branch?: string;
  base?: string;
  created?: boolean;
  reused?: boolean;
  skipped?: string;
  error?: string;
}

export interface BranchInfoDTO {
  isRepo: boolean;
  current?: string;
  local: string[];
  remote: string[];
  dirty?: boolean;
}

export interface RepoInfo {
  name: string;
  path: string;
  url?: string;
  platform?: string;
  /** 基线分支（配置里填的，没填就是自动探测出来的默认分支）；找不到为空 */
  base?: string;
  status: RepoStatusDTO;
}

/** 工作台：待办（飞书项目 / 钉钉） */
export interface TodoItemDTO {
  id: string;
  title: string;
  source: "feishu" | "dingtalk";
  due?: number;
  start?: number;
  end?: number;
  node?: string;
  overdue?: boolean;
  sub?: string;
  url?: string;
  /** 进行中的需求（有我负责的进行中节点 / 子任务） */
  active?: boolean;
  /** 我在这个需求下负责的节点和子任务 */
  children?: TodoChildDTO[];
  /** 需求所在飞书项目空间的 key */
  projectKey?: string;
}
export interface TodoChildDTO {
  id: string;
  title: string;
  kind: "node" | "subtask";
  /** 子任务所在的节点 */
  parent?: string;
  start?: number;
  end?: number;
  done?: boolean;
  active?: boolean;
  /** 人天 */
  days?: number;
  /** 负责人 */
  owner?: string;
  /** 子任务所在节点的 key（改飞书子任务要用） */
  nodeKey?: string;
}
export interface WorkChatDTO {
  ok: boolean;
  /** 需求没有拉群 */
  none?: boolean;
  groupId?: string;
  name?: string;
  status?: string;
  /** 飞书项目里的「拉群方式」，如「自动拉群」「不拉群」 */
  how?: string;
  link?: string;
  /** 需求没配群时，按需求名搜到的可能的群 */
  candidates?: Array<{ id: string; name: string }>;
  error?: string;
}
export interface SubtaskUpdateReq {
  projectKey: string;
  /** 需求（工作项）id */
  wid: string;
  nodeKey: string;
  subId: string;
  /** true = 完成，false = 回滚成未完成 */
  done?: boolean;
  /** 排期起止（毫秒）和人天 */
  start?: number;
  end?: number;
  days?: number;
}
export interface SubtaskCreateReq {
  projectKey: string;
  wid: string;
  /** 加到哪个节点（节点 key） */
  nodeKey: string;
  name: string;
}
export interface TodoSourceDTO {
  enabled: boolean;
  ok: boolean;
  items: TodoItemDTO[];
  error?: string;
  /** 当前登录的账号 */
  user?: string;
}
export interface WorkbenchTodosDTO {
  feishu: TodoSourceDTO;
  dingtalk: TodoSourceDTO;
  /** 合并、排序后的待办 */
  items: TodoItemDTO[];
}

export interface RepoInspectDTO {
  ok: boolean;
  error?: string;
  root?: string;
  name?: string;
  url?: string;
  branch?: string;
  platform?: string;
}

export interface AppState {
  home: string;
  configFile: string;
  configText: string;
  configError?: string;
  defaultProvider: string;
  workspace: string;
  traceDir: string;
  providers: ProviderInfo[];
  larkConfigured: boolean;
  /** 已绑定 M-Harness 自己的飞书机器人（专属配置），而不是借用本机别的软件的 */
  larkBound: boolean;
  channel: ChannelStatus;
}

export interface ChannelStatus {
  running: boolean;
  logs: string[];
}

/** 机器人前置检查（不发消息） */
export interface FeishuBotTestResult {
  ok: boolean;
  steps: Array<{ name: string; ok: boolean; detail?: string }>;
  /** 一句话结论 */
  message: string;
  /** 最近一次收到你消息的时间（毫秒时间戳） */
  lastInboundAt?: number;
}

/** 一个已绑定需求群的任务：桌面端把任务和群的关系同步给主进程，飞书群里的提问才知道该按哪个需求答 */
export interface TaskGroupBindingDTO {
  groupId: string;
  taskId: string;
  title: string;
  /** 发给 AI 的任务说明（需求、链接、关联仓库、上下文） */
  briefing: string;
  /** 关联的仓库名，第一个作为工作区 */
  repos: string[];
  /** 群里 AI 的回复方式（global = 跟随全局） */
  reply?: "global" | "stream" | "whole";
  /** 任务最近更新时间（毫秒）：飞书里发 /任务 列表时按它从新到旧排 */
  updated?: number;
}

export interface FeishuSetupResult {
  ok: boolean;
  message: string;
  /** 你的飞书账号名 */
  user?: string;
  /** 欢迎语有没有成功发到飞书里 */
  welcomed?: boolean;
}

export interface RunRequest {
  runKey: string;
  /** 同步到飞书智能体：标题（对话 / 任务名）和你问的原话；不传就不同步 */
  mirror?: { title: string; question: string };
  input: string;
  provider: string;
  history: Msg[];
  /** 这条消息附带的图片（本机文件绝对路径，粘贴的图片先由 saveImage 存好） */
  images?: string[];
  workspace?: string;
  /** 只对本次覆盖该 provider 的默认模型 */
  model?: string;
  /** 本次不提供给模型的工具名 */
  disabledTools?: string[];
  /** 会话 id：外部 Agent（Cursor）据此续接上一轮的 Agent，记得读过的文件，不用每一步从头探索 */
  sessionKey?: string;
  /** 这一轮开全新上下文，不续接 */
  fresh?: boolean;
  /** 探索预算（只读步骤用）：外部 Agent 工具调用达到这个数就让它直接写结论 */
  toolBudget?: number;
  /** 这一轮是飞书需求群里问的（见 GroupInboundDTO.reqId）：过程和结果由主进程发回群里，写 / 执行的确认也在群里问 */
  groupReq?: string;
}

/** 飞书需求群里群主的一条消息：交给对应任务的对话处理（带任务完整上下文），结果由主进程回复到群里 */
/** Agent 的 advance_next 登记：想在本轮结束后自动进入下一步 */
export interface AdvanceRequestDTO {
  runKey: string;
  action: string;
  instruction: string;
  /** 用户原话（Agent 引用的授权那句） */
  userWords: string;
}

export interface GroupInboundDTO {
  reqId: string;
  taskId: string;
  text: string;
  /** 群里发来的图片（已下载到本机） */
  images?: string[];
}

export interface ToolInfo {
  name: string;
  /** 第一行说明 */
  desc: string;
  risk: "read" | "write" | "exec" | "network";
}

export interface McpToolDTO {
  /** 原始工具名 */
  name: string;
  desc: string;
  risk: "read" | "write" | "exec" | "network";
  enabled: boolean;
}

export interface McpServerDTO {
  name: string;
  state: "disabled" | "idle" | "connecting" | "ready" | "error";
  error?: string;
  transport: "stdio" | "http";
  /** 命令行或地址 */
  target: string;
  tools: McpToolDTO[];
}

export interface SkillDTO {
  name: string;
  description: string;
  /** project：工作区；app：本应用新建；custom：自定义目录；user：用户目录 */
  source: "project" | "app" | "custom" | "user";
  dir: string;
  enabled: boolean;
  /** 只有应用内新建的技能可以在界面里编辑 / 删除 */
  editable: boolean;
}

export interface RuleFileDTO {
  file: string;
  title: string;
  kind: "always" | "optional";
  description?: string;
  chars: number;
}

export interface RunOutcome {
  reason: "final" | "max_steps" | "aborted" | "error";
  text: string;
  error?: string;
  steps: number;
  tokens: number;
  messages: Msg[];
  traceFile: string;
  runId: string;
}

/** AI 向操作人提的问题（等界面回答） */
export interface AskRequest {
  id: string;
  runKey: string;
  questions: AskQuestion[];
}

export interface ApprovalRequest {
  id: string;
  runKey: string;
  tool: string;
  risk: string;
  reason: string;
  args: unknown;
}

export interface TraceInfo {
  file: string;
  name: string;
  mtime: number;
  size: number;
  input: string;
  provider: string;
  /** 结束原因：final / error / aborted / max_steps，未结束为空 */
  reason: string;
}

export interface TraceLineDTO {
  ts: number;
  event: HarnessEvent;
}

/** preload 暴露给渲染进程的 API（window.harness） */
export interface HarnessApi {
  getState(): Promise<AppState>;
  /** 配置文件当前的原文 */
  configText(): Promise<string>;
  saveConfig(text: string): Promise<{ ok: boolean; error?: string }>;
  pickWorkspace(): Promise<string | null>;
  pickFolder(title?: string): Promise<string | null>;
  /** 已登记仓库及其当前状态（分支、未提交改动、领先/落后） */
  listRepos(): Promise<RepoInfo[]>;
  /** 这些仓库（配置里的名字）相对 HEAD 的改动行数合计 */
  /** 自动化任务 */
  automationList(): Promise<import("./automation").Automation[]>;
  automationSave(input: Partial<import("./automation").Automation> & Pick<import("./automation").Automation, "name" | "prompt" | "schedule">): Promise<{ ok: boolean; id?: string; error?: string }>;
  automationRemove(id: string): Promise<boolean>;
  automationToggle(id: string, on: boolean): Promise<{ ok: boolean; error?: string }>;
  automationRun(id: string): Promise<{ ok: boolean; error?: string }>;
  automationAbort(id: string): Promise<void>;
  /** 正在运行（含排队）的任务 id */
  automationRunning(): Promise<string[]>;
  onAutomationChanged(cb: () => void): () => void;
  /** 「设置 → 连接」里新增 / 修改 / 删除 / 启停了连接 */
  onConnectionsChanged(cb: () => void): () => void;
  /** 指派给我的缺陷（飞书项目缺陷 / 钉钉待办），没接项目管理工具时 enabled=false */
  defectsGet(): Promise<import("./defects").DefectsResult>;
  defectsRefresh(): Promise<import("./defects").DefectsResult>;
  /** 打开列表后调用：当前这些都算看过了（去掉「新」标记） */
  defectsSeen(): Promise<void>;
  defectsTransitions(key: string): Promise<import("./defects").DefectTransitions>;
  defectsTransition(key: string, transitionId: string): Promise<import("./defects").DefectActResult>;
  onDefectsChanged(cb: (r: import("./defects").DefectsResult) => void): () => void;
  /** 点了系统通知：打开缺陷列表 */
  onDefectsOpen(cb: () => void): () => void;
  /** 关联仓库时同步到基线分支最新代码 */
  repoSync(name: string): Promise<RepoSyncDTO>;
  /** 「进行开发」开始前：给每个仓库基于基线分支新建 feature-需求名称-日期 分支并切过去 */
  repoStartBranch(names: string[], title: string): Promise<StartBranchDTO[]>;
  /** 任务关联仓库的改动：在功能分支上是相对基线分支（base），否则是未提交的改动 */
  repoDiffStat(names: string[]): Promise<{ added: number; deleted: number; files: number; base?: string }>;
  /** 任务的专属文件夹；open=true 时同时在资源管理器里打开，返回路径 */
  taskFolder(id: string, open?: boolean): Promise<string>;
  /** 插件商店数据；refresh=true 时忽略缓存重新拉远程插件源 */
  pluginMarket(refresh?: boolean): Promise<import("./plugins").MarketResult>;
  /** 从链接下载插件包并解析（不安装） */
  pluginFetchUrl(url: string): Promise<{ ok: boolean; entries?: import("./plugins").PluginEntry[]; skipped?: string[]; error?: string }>;
  /** 让 DBX 弹出某个插件的安装确认 */
  /** 把目录里的插件直接装到本软件（下载 + 校验 + 解压），不需要 DBX */
  pluginInstall(id: string): Promise<{ ok: boolean; version?: string; /** 装好了，但有要说明的（比如某个技能因为重名没覆盖） */ note?: string; error?: string }>;
  pluginUninstall(id: string): Promise<{ ok: boolean; error?: string }>;
  /** 仓库里的 MCP / 技能 / 动作 / 规则：装进本软件的配置（参数是商店条目的 key） */
  /** 技能 / MCP / 动作 / 规则：软件自带的推荐、从 GitHub 导入、添加（这些不是插件，在各自的设置页里用） */
  /** 推荐：去 GitHub 按星标排行取这一类最高的 6 个仓库（缓存 12 小时；refresh 强制重新拉） */
  resourceRecommended(kind: string, refresh?: boolean): Promise<import("./plugins").ResourceRec>;
  /** kind 传 "mcp" 时，没有 .mcp.json 的仓库会再看 README 里的配置片段 */
  resourceScan(url: string, kind?: string): Promise<import("./plugins").ResourceScan>;
  resourceAdd(key: string): Promise<{ ok: boolean; error?: string }>;
  /** 「加载」：在用户选的本机文件夹里找技能 / MCP / 动作 / 规则 */
  resourceScanLocal(dir: string): Promise<import("./plugins").ResourceScan>;
  /** 「同步」能选的平台（Cursor / Claude Code / Codex）：哪些添加过账号、本机有没有它的目录 */
  resourceSyncPlatforms(): Promise<import("./plugins").PlatformInfo[]>;
  /** 「同步」：列出这个平台在本机已经有的内容 */
  resourceSyncScan(id: string): Promise<import("./plugins").ResourceScan>;
  connectionList(): Promise<import("./connections").Connection[]>;
  connectionSave(input: import("./connections").ConnectionInput): Promise<{ ok: boolean; conn?: import("./connections").Connection; error?: string }>;
  /** 编辑框打开时回显已保存的密码 / 令牌（字段名 → 明文），只在用户主动打开编辑时取 */
  connectionSecrets(id: string): Promise<Record<string, string>>;
  connectionRemove(id: string): Promise<{ ok: boolean; error?: string }>;
  connectionToggle(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
  /** 测试连接（秘密留空时用已保存的），不会把秘密返回给界面 */
  connectionTest(input: import("./connections").ConnectionInput): Promise<import("./connections").ConnTestResult>;
  /** 「设置 → 代码托管」里有没有 GitLab 令牌，能不能一键建 GitLab 连接 */
  gitlabHostsInfo(): Promise<{ hasToken: boolean; url: string; exists: boolean }>;
  connectionFromHosts(): Promise<{ ok: boolean; conn?: import("./connections").Connection; error?: string }>;
  /** 装本地选的 / 拖进来的 .dbxp 包（只能校验包内文件） */
  pluginInstallPackage(bytes: Uint8Array): Promise<PluginInstallResult>;
  /** 从链接安装 .dbxp */
  pluginInstallUrl(url: string): Promise<PluginInstallResult>;
  pluginRepos(): Promise<import("./plugins").PluginRepo[]>;
  /** 测试仓库地址：读一次它的插件目录，不保存 */
  pluginRepoTest(r: { name?: string; url: string }): Promise<{ ok: boolean; count?: number; names?: string[]; error?: string }>;
  pluginRepoAdd(r: { id?: string; name?: string; url: string }): Promise<{ ok: boolean; error?: string }>;
  pluginRepoRemove(id: string): Promise<{ ok: boolean; error?: string }>;
  pluginRepoToggle(id: string, enabled: boolean): Promise<{ ok: boolean; error?: string }>;
  pluginOpenDir(): Promise<{ ok: boolean; error?: string }>;
  /** 数据库页：按「设置 → 连接」里的数据库连接浏览和修改（只有开发 / 测试环境的库能改） */
  dbDatabases(connectionId: string): Promise<import("./db").DbResp<string[]>>;
  dbSchemas(ref: import("./db").DbScopeRef): Promise<import("./db").DbResp<import("./db").DbSchemaInfo[]>>;
  dbExtensions(ref: import("./db").DbScopeRef): Promise<import("./db").DbResp<import("./db").DbExtension[]>>;
  dbEventTriggers(ref: import("./db").DbScopeRef): Promise<import("./db").DbResp<import("./db").DbEventTrigger[]>>;
  dbTables(ref: import("./db").DbScopeRef): Promise<import("./db").DbResp<import("./db").DbTableInfo[]>>;
  dbStructure(ref: import("./db").DbTableRef): Promise<import("./db").DbResp<import("./db").DbStructure>>;
  dbData(req: import("./db").DbDataReq): Promise<import("./db").DbResp<import("./db").DbQueryResult>>;
  dbCount(req: import("./db").DbDataReq): Promise<import("./db").DbResp<number>>;
  dbQuery(req: import("./db").DbQueryRequest): Promise<import("./db").DbResp<import("./db").DbQueryResult>>;
  dbApply(req: import("./db").DbApplyReq): Promise<import("./db").DbResp<import("./db").DbApplyResult>>;
  /** 带界面的已装插件（右侧栏） */
  pluginUiList(): Promise<import("./pluginhost").UiPlugin[]>;
  /** 连接类插件（如 XXL-JOB）可选的连接，来自「设置 → 连接」 */
  pluginConnections(id: string): Promise<import("./pluginhost").PluginConn[]>;
  /** 能给 AI 用的插件（清单里有 mcp 贡献）及其工具；已确认信任的才有工具列表 */
  pluginAiList(): Promise<import("./pluginhost").PluginAiInfo[]>;
  pluginAiSet(id: string, on: boolean): Promise<void>;
  /** 用户确认信任并允许运行带本机程序的插件 */
  pluginTrust(id: string, grants?: string[]): Promise<boolean>;
  pluginDbAccess(id: string): Promise<import("./pluginhost").PluginDbAccess>;
  pluginSetGrants(id: string, ids: string[]): Promise<void>;
  /** 插件界面发来的请求（backend.invoke 等），由主进程转给插件后台 */
  pluginRequest(id: string, method: string, params: unknown): Promise<import("./pluginhost").PluginReply>;
  onPluginEvent(cb: (e: { id: string; method: string; params: unknown }) => void): () => void;
  /** 插件后台发来的二进制数据（终端输出等；插件要有 host.binary 权限） */
  onPluginBinary(cb: (e: { id: string; channel: string; data: Uint8Array }) => void): () => void;
  /** 工作台：我的待办（飞书项目 + 钉钉），没启用的来源 enabled=false */
  workbenchTodos(): Promise<WorkbenchTodosDTO>;
  /** 上一次读成功的待办（立即返回、不联网），用来先显示；at 是读取时间 */
  workbenchTodosCached(): Promise<(WorkbenchTodosDTO & { at: number }) | null>;
  /** 在飞书项目里完成 / 回滚子任务，或改子任务的排期和人天；成功后返回从飞书重新读到的这个子任务 */
  /** 在飞书项目的某个节点下新增一个子任务（负责人是当前登录账号）；成功后返回从飞书读到的新子任务 */
  workbenchSubtaskCreate(req: SubtaskCreateReq): Promise<{ ok: boolean; error?: string; child?: TodoChildDTO }>;
  workbenchSubtaskUpdate(req: SubtaskUpdateReq): Promise<{ ok: boolean; error?: string; child?: { done?: boolean; start?: number; end?: number; days?: number } }>;
  /** 读需求（飞书项目工作项）对应的飞书群：群 id、群名、状态、打开链接；没拉群就 none */
  workItemChat(req: { projectKey?: string; wid: string; url?: string; title?: string; chatId?: string }): Promise<WorkChatDTO>;
  /** 新建一个飞书群（以 lark-cli 登录的用户身份）；返回新群的 id / 名称 / 打开链接 */
  workItemChatCreate(req: { name: string; description?: string }): Promise<WorkChatDTO>;
  inspectRepo(dir: string): Promise<RepoInspectDTO>;
  cloneRepo(url: string, parentDir: string, name: string): Promise<{ ok: boolean; path?: string; error?: string }>;
  openPath(p: string): Promise<void>;
  /** 读 / 写数据目录下 .env 中的变量（API Key 放这里，不进配置文件） */
  getSecret(name: string): Promise<string>;
  setSecret(name: string, value: string): Promise<{ ok: boolean; error?: string }>;
  /** 用（可能尚未保存的）Key 向服务商校验、取模型列表，并尽可能取回 Key 所属账号信息 */
  listModels(req: { type: string; baseURL?: string; apiKey?: string }): Promise<KeyProbeDTO>;
  /** 真发一次很小的对话请求，验证地址 / 协议 / Key / 模型名都对得上 */
  testModel(req: { type: string; baseURL?: string; apiKey?: string; model?: string }): Promise<ModelTestDTO>;
  /** 用（可能尚未保存的）令牌向代码托管平台查询所属账号 */
  /** 当前可提供给模型的全部工具（对话框里「工具」下拉用） */
  listTools(): Promise<ToolInfo[]>;
  /** 某个已配置 provider 可选的模型列表（用它已保存的 Key 实时获取） */
  providerModels(name: string, opts?: { refresh?: boolean; cacheOnly?: boolean }): Promise<KeyProbeDTO>;
  /** 选择一个文件，返回绝对路径 */
  pickFile(title?: string): Promise<string | null>;
  /** 拖入窗口的文件对应的本地绝对路径 */
  pathForFile(file: File): string;
  /** 把粘贴的图片存到数据目录下，返回文件路径；格式 / 大小不合要求返回错误原因 */
  saveImage(bytes: Uint8Array, mime: string): Promise<{ ok: true; path: string } | { ok: false; error: string }>;
  /** 读一张本地图片做缩略图（data URL）；不是图片 / 读不到返回 null */
  imageDataUrl(path: string): Promise<string | null>;
  /** 仓库的本地 + 远端分支名，用于分支下拉候选 */
  /** 聊天输入框的分支选择器：当前分支 + 本地 / 远端分支 */
  branchInfo(dir: string): Promise<BranchInfoDTO>;
  /** 切换分支（git switch，有冲突时原样返回 git 的拒绝原因） */
  switchBranch(dir: string, branch: string): Promise<{ ok: boolean; error?: string; current?: string }>;
  listBranches(dir: string): Promise<string[]>;
  probeGitHost(req: { platform: string; baseURL?: string; token?: string }): Promise<HostProbeDTO>;
  /** 检测飞书项目 CLI（meegle）是否可用、是否已登录 */
  feishuProjectStatus(): Promise<{ installed: boolean; authenticated: boolean; host?: string; version?: string; user?: string; detail?: string }>;
  /** 集成卡片：lark-cli / meegle / dws 的版本、登录账号 */
  integrationStatus(kind: IntegrationKind): Promise<IntegrationStatusDTO>;
  /** 检查更新（lark-cli、dws 支持；meegle 没有更新检查接口） */
  integrationCheckUpdate(kind: IntegrationKind): Promise<IntegrationUpdateDTO>;
  /** 一键安装 / 升级 CLI（npm install -g <包>@latest），耗时可能几十秒 */
  integrationInstall(kind: IntegrationKind): Promise<{ ok: boolean; output: string; error?: string }>;
  /** 一键登录：自动在浏览器打开授权页，等用户授权完成后返回（最长约 10 分钟） */
  syncTaskGroups(list: TaskGroupBindingDTO[]): Promise<void>;
  /** 回复主进程：这条群消息我接了（ok）并且前面有任务在跑所以要排队（queued）；没接（任务不在了等）就 ok=false，主进程自己处理 */
  groupAck(reqId: string, ok: boolean, queued?: boolean): Promise<boolean>;
  /** 接了的群消息后来没法处理了（任务被删了等）：让主进程在群里说一声 */
  groupDrop(reqId: string, why: string): Promise<void>;
  feishuBotCheck(): Promise<FeishuBotTestResult>;
  feishuBotHello(): Promise<{ ok: boolean; message: string }>;
  integrationLogin(kind: IntegrationKind): Promise<{ ok: boolean; message: string }>;
  /** 一键创建飞书智能体：建机器人（首次要在浏览器里确认）→ 登录 → 把你加进允许名单 → 启动通道 → 在飞书里发欢迎语。进度走 onIntegrationLoginProgress（kind=lark） */
  /** 登录过程中的进度：授权链接（可复制）、验证码、阶段提示 */
  onIntegrationLoginProgress(cb: (p: { kind: IntegrationKind; url?: string; userCode?: string; text?: string }) => void): () => void;
  /** 飞书项目里当前账号的空间列表（给「默认空间」下拉用） */
  feishuSpaces(): Promise<{ ok: boolean; spaces?: Array<{ name: string; key: string; simpleName?: string }>; error?: string }>;
  /** MCP 服务的连接状态与工具（会触发尚未连接的服务开始连接，界面轮询即可） */
  mcpStatus(): Promise<McpServerDTO[]>;
  mcpReconnect(name: string): Promise<McpServerDTO[]>;
  listSkills(): Promise<SkillDTO[]>;
  /** 技能的 SKILL.md 全文 */
  readSkill(name: string): Promise<{ ok: boolean; content?: string; error?: string }>;
  saveSkill(req: { name: string; description: string; content: string }): Promise<{ ok: boolean; error?: string }>;
  deleteSkill(name: string): Promise<{ ok: boolean; error?: string }>;
  /** 当前工作区里识别到的项目规则（AGENTS.md / .cursor/rules） */
  rulesPreview(): Promise<RuleFileDTO[]>;
  homeWeather(opts?: { refresh?: boolean; city?: string }): Promise<WeatherDTO>;
  homeDaily(): Promise<DailyDTO>;
  /** 首页「今日待办」：来自「待办 Todo」插件（没装 / 没信任时 state 不是 ok） */
  homeTodos(): Promise<import("./todos").HomeTodosDTO>;
  updateState(): Promise<UpdateStateDTO>;
  /** 立即检查更新（设置改了仓库后也调这个） */
  updateCheck(): Promise<UpdateStateDTO>;
  /** 开机自启动（系统登录项）：读 / 设 */
  /** 数据目录：读 / 改（改完软件会自己重启，下次启动先迁移旧数据） */
  dataDirGet(): Promise<DataDirDTO>;
  dataDirSet(dir: string): Promise<{ ok: boolean; error?: string }>;
  autostartGet(): Promise<AutostartDTO>;
  autostartSet(on: boolean): Promise<AutostartDTO>;
  /** 下载更新；不能应用内安装时打开 Release 页面 */
  updateDownload(): Promise<UpdateStateDTO>;
  /** 退出并安装已下载的更新 */
  updateInstall(): Promise<void>;
  onUpdate(cb: (s: UpdateStateDTO) => void): () => void;
  /** 界面缩放（1 = 100%） */
  setZoom(factor: number): Promise<void>;
  /** 同步窗口标题栏按钮（最小化/最大化/关闭）的配色 */
  setTheme(theme: "light" | "dark"): Promise<void>;
  run(req: RunRequest): Promise<RunOutcome>;
  abort(runKey: string): Promise<void>;
  respondApproval(id: string, approved: boolean, remember: boolean): Promise<void>;
  /** 回答 AI 的提问；answers 传 null = 跳过 */
  respondAsk(id: string, answers: Array<{ id: string; picked: string[]; text?: string }> | null): Promise<void>;

  listTraces(): Promise<TraceInfo[]>;
  readTrace(file: string): Promise<TraceLineDTO[]>;


  channelStart(): Promise<{ ok: boolean; error?: string }>;
  channelStop(): Promise<void>;

  onRunEvent(cb: (runKey: string, event: HarnessEvent) => void): () => void;
  onGroupInbound(cb: (m: GroupInboundDTO) => void): () => void;
  /** Agent 登记了「本轮结束后自动进入下一步」（advance_next）；是否放行由界面按用户原话核对 */
  onRunAdvance(cb: (m: AdvanceRequestDTO) => void): () => void;
  onApproval(cb: (req: ApprovalRequest) => void): () => void;
  onAsk(cb: (req: AskRequest) => void): () => void;
  onChannelLog(cb: (line: string) => void): () => void;
}

export interface PluginInstallResult {
  ok: boolean;
  id?: string;
  name?: string;
  version?: string;
  error?: string;
}

import path from "node:path";
import { ProviderRegistry, type HarnessConfig } from "./config";
import { ContextManager } from "./core/context";
import { Guardrails, approveAll, denyAll, type Approver } from "./core/guardrails";
import { run } from "./core/loop";
import { createJsonlTrace, fanout, newRunId } from "./core/trace";
import type { Asker, Emit, Msg, RunResult, Tool } from "./core/types";
import { askUserTool } from "./tools/ask-user";
import { builtinTools } from "./tools/builtin";
import { dingtalkProjectTools } from "./tools/dingtalk-project";
import { feishuProjectTools } from "./tools/feishu-project";
import { McpManager } from "./mcp/manager";
import { customOfficePrompt } from "./prompt/office";
import { buildRulesSection } from "./prompt/rules";
import { scanSkills, skillTool, skillsPrompt, type Skill } from "./prompt/skills";
import { gitTools } from "./tools/git";
import { authEnvFor } from "./tools/git-hosts";

/** 调用方额外提供的工具（桌面端的插件工具）：prepare 里异步准备好，tools 同步取 */
export interface ExtraTools {
  tools(): Tool[];
  prepare(): Promise<void>;
}

export interface TaskRequest {
  input: string;
  /** 附带的图片（本机文件绝对路径），发给支持图片的模型 / Agent */
  images?: string[];
  /** 指定 provider，缺省用配置里的 defaultProvider */
  provider?: string;
  history?: Msg[];
  /** local：本机 CLI/桌面，沿用 guard 配置；channel：办公通道，默认只读 */
  mode?: "local" | "channel";
  approve?: Approver;
  /** 能向操作人提问（只有桌面端的对话提供）；有它才给模型 ask_user 工具 */
  ask?: Asker;
  emit?: Emit;
  signal?: AbortSignal;
  /** 覆盖工作区（沙箱根） */
  workspace?: string;
  system?: string;
  /** 只对本次覆盖 provider 的默认模型 */
  model?: string;
  /** 本次不提供给模型的工具名 */
  disabledTools?: string[];
  /** 外部 Agent 的会话标识（任务 / 对话 id）：同一个值会续接同一个 Agent，不用每一步从头探索 */
  sessionKey?: string;
  /** 开全新上下文：不续接旧 Agent */
  freshSession?: boolean;
  /** 外部 Agent 的探索预算：工具调用达到这个数就让它直接收尾 */
  toolBudget?: number;
}

/** 装配好的运行时：配置 + provider 注册表 + 护栏 + trace，CLI / 通道 / 桌面端共用 */
export class Runtime {
  readonly registry: ProviderRegistry;
  readonly mcp: McpManager;
  private ownsMcp: boolean;
  private home?: string;
  private extra?: ExtraTools;

  /** opts.mcp：由调用方持有的 MCP 连接（桌面端在配置重载之间复用连接）；不传则自己创建、dispose 时关闭 */
  constructor(readonly config: HarnessConfig, opts: { mcp?: McpManager; home?: string; extra?: ExtraTools } = {}) {
    this.extra = opts.extra;
    this.registry = new ProviderRegistry(config);
    this.ownsMcp = !opts.mcp;
    this.mcp = opts.mcp ?? new McpManager();
    this.mcp.configure(config.mcpServers);
    this.home = opts.home;
  }

  /** 内置工具 + 已启用的外部系统工具 + 已连接的 MCP 工具 */
  get tools(): Tool[] {
    const fp = this.config.integrations.feishuProject;
    // 项目管理只接一个：同时配了就用飞书项目
    const dp = fp ? undefined : this.config.integrations.dingtalkProject;
    const repos = Object.fromEntries(Object.entries(this.config.repos).map(([k, r]) => [k, { ...r, path: path.resolve(r.path) }]));
    return [...builtinTools, ...gitTools(repos, u => authEnvFor(u, this.config.gitHosts)), ...(fp ? feishuProjectTools(fp) : []), ...(dp ? dingtalkProjectTools({ ...dp, bin: this.config.integrations.dingtalk?.bin ?? "dws" }) : []), ...this.mcp.tools(), ...(this.extra?.tools() ?? [])];
  }

  /** 工作区下所有技能（含已停用的，带 enabled 标记，供设置页展示） */
  allSkills(root = this.workspace): Array<Skill & { enabled: boolean }> {
    const off = new Set(this.config.skills.disabled);
    return scanSkills({ root, home: this.home, dirs: this.config.skills.dirs, userDirs: this.config.skills.scanUserDirs }).map(s => ({ ...s, enabled: !off.has(s.name) }));
  }

  /** 连接 MCP 服务（已连接的不会重复连） */
  async prepare(): Promise<void> {
    await this.mcp.ensure();
    await this.extra?.prepare().catch(() => {});
  }

  async dispose(): Promise<void> {
    if (this.ownsMcp) await this.mcp.dispose();
  }

  get workspace(): string {
    return path.resolve(this.config.workspace);
  }

  guardFor(mode: "local" | "channel"): Guardrails {
    const g = this.config.guard;
    const cfg = { ...g, policy: { ...g.policy } } as ConstructorParameters<typeof Guardrails>[0];
    if (mode === "channel" && this.config.channels.toolPolicy === "readonly") {
      cfg!.policy = { ...cfg!.policy, write: "deny", exec: "deny", network: "deny" };
    }
    return new Guardrails(cfg);
  }

  async runTask(req: TaskRequest): Promise<RunResult & { runId: string; traceFile: string; provider: string }> {
    const mode = req.mode ?? "local";
    const providerName = req.provider ?? this.config.defaultProvider;
    const provider = this.registry.get(providerName, req.model);
    const runId = newRunId();
    const trace = createJsonlTrace(path.resolve(this.config.traceDir), runId);
    const emit = fanout(trace.emit, req.emit);

    const approve =
      req.approve ?? (mode === "channel" && this.config.channels.autoApprove ? approveAll : denyAll);

    const root = req.workspace ? path.resolve(req.workspace) : this.workspace;
    await this.prepare();
    const skills = provider.kind === "model" ? this.allSkills(root).filter(s => s.enabled) : [];
    const baseTools = [...this.tools, ...(skills.length ? [skillTool(skills)] : []), ...(req.ask && provider.kind === "model" ? [askUserTool] : [])];
    const system = [req.system ?? this.config.system, buildRulesSection(this.config.rules, root), skillsPrompt(skills), customOfficePrompt(this.config.office)].filter(Boolean).join("\n\n");

    const result = await run({
      provider,
      tools: req.disabledTools?.length ? baseTools.filter(t => !req.disabledTools!.includes(t.name)) : baseTools,
      system,
      input: req.input,
      images: req.images,
      history: req.history,
      maxSteps: this.config.limits.maxSteps,
      timeoutMs: (provider.kind === "model" ? this.config.limits.timeoutSec : Math.max(this.config.limits.timeoutSec, this.config.limits.agentTimeoutSec)) * 1000,
      guard: this.guardFor(mode),
      approve,
      ask: req.ask,
      context: new ContextManager({ maxTokens: this.config.limits.contextTokens }, emit),
      emit,
      signal: req.signal,
      root,
      runId,
      sessionKey: req.sessionKey,
      freshSession: req.freshSession,
      toolBudget: req.toolBudget,
    });
    return { ...result, runId, traceFile: trace.file, provider: providerName };
  }
}

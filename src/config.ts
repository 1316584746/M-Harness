import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { anthropic } from "./models/anthropic";
import { cliAgent, CLI_PRESETS } from "./models/cli-agent";
import { cursorSdk } from "./models/cursor-sdk";
import { normalizeEndpoint } from "./models/endpoint";
import { openaiCompat } from "./models/openai-compat";
import type { Provider } from "./core/types";

const ProviderCfg = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("openai-compat"),
    baseURL: z.string(),
    apiKey: z.string().default(""),
    model: z.string(),
    temperature: z.number().optional(),
    extraBody: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal("anthropic"),
    apiKey: z.string().default(""),
    model: z.string(),
    baseURL: z.string().optional(),
    maxTokens: z.number().optional(),
  }),
  z.object({
    type: z.literal("cli"),
    preset: z.enum(["codex", "cursor-cli", "claude-code"]).optional(),
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    promptVia: z.enum(["arg", "stdin", "file"]).optional(),
    timeoutSec: z.number().optional(),
  }),
  z.object({
    type: z.literal("cursor-sdk"),
    apiKey: z.string().default(""),
    model: z.string().optional(),
  }),
]);

const FeishuCfg = z.object({
  appId: z.string(),
  appSecret: z.string(),
  verificationToken: z.string().default(""),
  encryptKey: z.string().default(""),
  /** 国际版 Lark 用 https://open.larksuite.com */
  apiBase: z.string().default("https://open.feishu.cn"),
  /** 群聊里是否只在被 @ 时响应 */
  groupRequireMention: z.boolean().default(true),
});

const DingtalkCfg = z.object({
  /** 企业内部应用的 AppSecret，用于校验回调签名 */
  appSecret: z.string(),
  /** 可选：只处理这些 staffId */
  allowUsers: z.array(z.string()).default([]),
});

const McpServerCfg = z.object({
  /** 本地命令（stdio）；与 url 二选一 */
  command: z.string().optional(),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().optional(),
  /** 远程地址（Streamable HTTP，失败时回退 SSE） */
  url: z.string().optional(),
  headers: z.record(z.string(), z.string()).optional(),
  enabled: z.boolean().default(true),
  /** 不提供给模型的工具（原始名，不含前缀） */
  disabledTools: z.array(z.string()).default([]),
  /** 调用权限：confirm = 按 write 类处理（默认询问）；auto = 按 read 类处理（直接执行）。MCP 标注为只读的工具始终按 read 处理 */
  permission: z.enum(["confirm", "auto"]).default("confirm"),
});

export type McpServerConfig = z.infer<typeof McpServerCfg>;

export const ConfigSchema = z.object({
  /** 默认使用的模型 / Agent（providers 里的名字）；留空表示还没配置 */
  defaultProvider: z.string().default(""),
  workspace: z.string().default("."),
  traceDir: z.string().default(".traces"),
  system: z
    .string()
    .default("你是一个可靠的助手，可以使用工具完成任务。回答使用中文，简洁准确；不确定时先说明，不要编造。"),
  /** 规则：自定义的长期指令，每次运行都拼进 system prompt；项目里的 AGENTS.md / .cursor/rules 也会自动读取 */
  rules: z
    .object({
      items: z
        .array(z.object({ id: z.string(), title: z.string().default(""), content: z.string(), enabled: z.boolean().default(true) }))
        .default([]),
      /** 读取工作区里的 AGENTS.md 与 .cursor/rules */
      useProjectFiles: z.boolean().default(true),
    })
    .default({ items: [], useProjectFiles: true }),
  /** 技能：SKILL.md 文件夹；dirs 为额外的扫描目录，disabled 为已停用的技能名 */
  skills: z
    .object({
      dirs: z.array(z.string()).default([]),
      disabled: z.array(z.string()).default([]),
      /** 同时扫描用户目录：~/.cursor/skills、~/.agents/skills */
      scanUserDirs: z.boolean().default(true),
    })
    .default({ dirs: [], disabled: [], scanUserDirs: true }),
  /** MCP 服务（格式与 Cursor 的 mcp.json 里的 mcpServers 一致） */
  mcpServers: z.record(z.string(), McpServerCfg).default({}),
  /** 插件中心：额外的插件源，以及已安装插件的记录（卸载时按记录清理） */
  plugins: z
    .object({
      marketplaces: z.array(z.object({ name: z.string().optional(), url: z.string(), enabled: z.boolean().default(true) })).default([]),
      installed: z
        .record(z.string(), z.object({
            kind: z.enum(["mcp", "skill", "action", "rule", "bundle"]),
            name: z.string(),
            version: z.string().optional(),
            ref: z.string(),
            at: z.number(),
            /** 插件包（Codex / Claude）：它装进配置的各项的 key，卸载时一起删 */
            members: z.array(z.string()).optional(),
            ecosystem: z.enum(["dbx", "dsh", "codex", "claude"]).optional(),
          }),
        )
        .default({}),
    })
    .default({ marketplaces: [], installed: {} }),
  /** 应用更新：从 GitHub Releases 检查新版本（repo 形如 owner/repo；留空用应用内置的默认仓库） */
  update: z
    .object({
      repo: z.string().default(""),
      autoCheck: z.boolean().default(true),
    })
    .default({ repo: "", autoCheck: true }),
  /** 动作：预设提示词模板（或绑定一个技能 + 产出要求），在对话输入框 / 推进任务里一键套用；模板里的 {{input}} 会被替换成你输入的内容 */
  actions: z
    .array(z.object({ id: z.string(), name: z.string(), prompt: z.string().default(""), description: z.string().optional(), hidden: z.boolean().optional(), skill: z.string().optional(), output: z.string().optional(), placeholder: z.string().optional() }))
    .default([]),
  /** 自带的推进步骤（方案设计 / 进行开发 / 代码CR / 联调 / 提测）的顺序和隐藏 */
  actionPrefs: z
    .object({
      order: z.array(z.string()).default([]),
      hidden: z.array(z.string()).default([]),
      /** 自带动作被用户改过的提示词（只存动作自己的那份）：动作 id → 内容 */
      overrides: z.record(z.string(), z.object({ body: z.string() })).default({}),
    })
    .default({ order: [], hidden: [], overrides: {} }),
  limits: z
    .object({
      maxSteps: z.number().default(20),
      timeoutSec: z.number().default(300),
      /** 外部 Agent（Cursor SDK 等）一次运行的上限：方案设计这类任务动辄上百步，300 秒不够 */
      agentTimeoutSec: z.number().default(1800),
      contextTokens: z.number().default(24000),
    })
    .default({ maxSteps: 20, timeoutSec: 300, agentTimeoutSec: 1800, contextTokens: 24000 }),
  guard: z
    .object({
      allowTools: z.array(z.string()).optional(),
      denyTools: z.array(z.string()).optional(),
      policy: z.record(z.string(), z.enum(["allow", "ask", "deny"])).optional(),
      denyCommands: z.array(z.string()).optional(),
      allowPrivateNetwork: z.boolean().optional(),
      allowHosts: z.array(z.string()).optional(),
    })
    .default({}),
  providers: z.record(z.string(), ProviderCfg).default({}),
  /** 已登记的代码仓库：模型可用 git_read / git_write 按名字操作，对话里也可以直接选作工作区 */
  repos: z
    .record(
      z.string(),
      z.object({
        path: z.string(),
        url: z.string().optional(),
        branch: z.string().optional(),
        platform: z.string().optional(),
        /** 分支约定：模型提交、提测、联调时按它选分支 */
        branches: z
          .object({
            /** 基线分支：feature 分支从这里拉；留空则自动探测默认分支 */
            base: z.string().optional(),
            /** 提测分支 */
            test: z.string().optional(),
            /** 联调分支 */
            integration: z.string().optional(),
          })
          .optional(),
        /** 只读仓库：git_write 不会去改它（只能读、看历史） */
        readOnly: z.boolean().optional(),
        /** 脚本仓：只放脚本 / 工具，不是业务代码仓库 */
        scriptRepo: z.boolean().optional(),
        /** feature 分支名模板（留空用默认约定），如 feature/{date}-{slug} */
        branchTemplate: z.string().optional(),
        /** 预览启动命令，如 npm run dev */
        previewCmd: z.string().optional(),
        /** 依赖初始化命令，如 yarn install --frozen-lockfile */
        installCmd: z.string().optional(),
      }),
    )
    .default({}),
  /** 代码托管平台的实例地址（自建 GitLab / GitHub Enterprise）；令牌放在 .env 的 GITHUB_TOKEN / GITLAB_TOKEN 等变量里；enabled 为 false 表示停用（不再给 git 注入这个平台的令牌） */
  gitHosts: z.record(z.string(), z.object({ baseURL: z.string().optional(), enabled: z.boolean().optional() })).default({}),
  /**
   * 办公集成：同一时间只启用一个平台（飞书 / 钉钉 / 自定义）。
   * stash 是切走的平台暂存的配置（切回来时恢复）；custom 是「自定义」平台——你们自己的办公系统，说明会加进模型的系统提示。
   */
  office: z
    .object({
      active: z.enum(["feishu", "dingtalk", "custom"]).optional(),
      custom: z.object({ name: z.string().default(""), instructions: z.string().default("") }).optional(),
      stash: z.record(z.string(), z.record(z.string(), z.any())).optional(),
    })
    .default({}),
  /** 项目管理等外部系统：以工具的形式提供给模型 */
  integrations: z
    .object({
      /** 飞书项目（Meegle）：封装 meegle CLI，身份用本机 meegle 登录态 */
      feishuProject: z
        .object({
          bin: z.string().default("meegle"),
          binArgs: z.array(z.string()).default([]),
          timeoutSec: z.number().default(60),
          /** 允许评论、创建/修改工作项、节点流转（需审批；办公通道里仍默认拒绝） */
          write: z.boolean().default(false),
          /** 默认空间：用户没指明空间时，模型默认查这个空间 */
          defaultSpace: z.object({ key: z.string(), name: z.string().optional() }).optional(),
        })
        .optional(),
      /** 钉钉 CLI（dws）：设置页用它检测版本 / 登录状态；不在 PATH 时写完整路径 */
      dingtalk: z.object({ bin: z.string().default("dws") }).optional(),
      /** 钉钉项目管理（待办任务 + AI 表格）：封装 dws CLI，可执行文件取自上面的 dingtalk.bin */
      dingtalkProject: z
        .object({
          binArgs: z.array(z.string()).default([]),
          timeoutSec: z.number().default(60),
          /** 允许创建 / 修改待办、评论、写 AI 表格记录（需审批；办公通道里仍默认拒绝） */
          write: z.boolean().default(false),
        })
        .optional(),
    })
    .default({}),
  channels: z
    .object({
      server: z.object({ port: z.number().default(8787), host: z.string().default("127.0.0.1") }).default({ port: 8787, host: "127.0.0.1" }),
      /**
       * 办公通道里的工具策略。默认只读：没人能在群里审批，写/执行/联网类工具一律拒绝。
       * 设为 "inherit" 则沿用 guard 配置（ask 仍会被拒绝，除非 autoApprove=true）。
       */
      toolPolicy: z.enum(["readonly", "inherit"]).default("readonly"),
      autoApprove: z.boolean().default(false),
      /** 飞书 CLI（lark-cli）长连接通道：无需公网地址，凭据由 lark-cli 登录态管理 */
      larkCli: z
        .object({
          /** lark-cli 可执行文件，不在 PATH 时写绝对路径 */
          bin: z.string().default("lark-cli"),
          /** 放在子命令之前的额外参数（如 --profile xxx 之类，或测试时用 node 启动脚本） */
          binArgs: z.array(z.string()).default([]),
          groupRequireMention: z.boolean().default(true),
          replyFormat: z.enum(["text", "markdown"]).default("markdown"),
          /** 只响应这些 open_id（强烈建议配置，否则任何人都能驱动它） */
          allowUsers: z.array(z.string()).default([]),
          allowChats: z.array(z.string()).default([]),
          /** 每次打开 M-Harness，由你自己的飞书机器人给你本人发一条「已上线」；不写就是开，写 false 关闭 */
          notifyOnline: z.boolean().optional(),
        })
        .optional(),
      feishu: FeishuCfg.optional(),
      dingtalk: DingtalkCfg.optional(),
    })
    .default({ server: { port: 8787, host: "127.0.0.1" }, toolPolicy: "readonly", autoApprove: false }),
});

export type HarnessConfig = z.infer<typeof ConfigSchema>;
export type ProviderConfig = z.infer<typeof ProviderCfg>;

/** 展开字符串里的 ${ENV_VAR} */
function expandEnv(v: unknown): unknown {
  if (typeof v === "string") return v.replace(/\$\{([A-Z0-9_]+)\}/gi, (_, k) => process.env[k] ?? "");
  if (Array.isArray(v)) return v.map(expandEnv);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, expandEnv(x)]));
  return v;
}

/**
 * 旧版本有个内置的 mock 假模型，现在已经移除：配置里残留的 mock 提供方直接丢掉，
 * 默认模型指向它的话改成剩下的第一个。返回有没有改动（调用方可以据此把文件也改干净）。
 */
export function dropMockProviders(c: any): boolean {
  if (!c || typeof c !== "object") return false;
  let changed = false;
  const ps = c.providers;
  if (ps && typeof ps === "object") {
    for (const [k, v] of Object.entries(ps)) {
      if ((v as any)?.type === "mock") {
        delete ps[k];
        changed = true;
      }
    }
  }
  if (c.defaultProvider === "mock" || (changed && typeof c.defaultProvider === "string" && !(c.defaultProvider in (ps ?? {})))) {
    c.defaultProvider = Object.keys(ps ?? {})[0] ?? "";
    changed = true;
  }
  return changed;
}

export function parseConfig(raw: unknown): HarnessConfig {
  const c: any = expandEnv(raw);
  dropMockProviders(c);
  return ConfigSchema.parse(c);
}

export function loadConfig(file?: string): { config: HarnessConfig; file?: string } {
  const envFile = path.resolve(".env");
  if (fs.existsSync(envFile)) {
    try {
      process.loadEnvFile(envFile);
    } catch {
      /* 旧版 Node 无此 API，忽略 */
    }
  }
  const p = path.resolve(file ?? "harness.config.json");
  if (!fs.existsSync(p)) {
    if (file) throw new Error(`找不到配置文件 ${p}`);
    return { config: parseConfig({}) };
  }
  const text = fs.readFileSync(p, "utf8").replace(/^\uFEFF/, "");
  return { config: parseConfig(JSON.parse(text)), file: p };
}

export class ProviderRegistry {
  private cache = new Map<string, Provider>();
  constructor(private cfg: HarnessConfig) {}

  names(): string[] {
    return Object.keys(this.cfg.providers);
  }

  describe(name: string): string {
    const c = this.cfg.providers[name];
    if (!c) return "未知";
    switch (c.type) {
      case "openai-compat":
        return `OpenAI 兼容 · ${c.model} @ ${c.baseURL}`;
      case "anthropic":
        return `Anthropic · ${c.model}`;
      case "cli":
        return `CLI Agent · ${c.preset ?? c.command}`;
      case "cursor-sdk":
        return `Cursor SDK · ${c.model ?? "composer-2"}`;
    }
  }

  has(name: string): boolean {
    return name in this.cfg.providers;
  }

  /** 取 provider；model 不为空时只对本次覆盖默认模型（不改配置） */
  get(name: string, model?: string): Provider {
    const k = model ? `${name}\0${model}` : name;
    const hit = this.cache.get(k);
    if (hit) return hit;
    const c = this.cfg.providers[name];
    if (!c) throw new Error(this.names().length === 0 ? "还没有配置模型：到「设置 → 模型」里添加一个并填好 Key" : `未知 provider：${name || "（未选择）"}，可用：${this.names().join(", ")}`);
    const withModel = model && (c.type === "openai-compat" || c.type === "anthropic" || c.type === "cursor-sdk") ? { ...c, model } : c;
    const p = buildProvider(name, withModel);
    this.cache.set(k, p);
    return p;
  }

  /** 配置里的默认模型名（没有「模型」概念的类型返回 undefined） */
  modelOf(name: string): string | undefined {
    const c = this.cfg.providers[name];
    if (!c) return undefined;
    if (c.type === "openai-compat" || c.type === "anthropic") return c.model;
    if (c.type === "cursor-sdk") return c.model ?? "composer-2";
    return undefined;
  }
}

function needKey(name: string, key: string) {
  if (!key) throw new Error(`provider ${name} 缺少 apiKey（检查环境变量或 .env）`);
}

export function buildProvider(name: string, c: ProviderConfig): Provider {
  // 类型和地址对不上时（比如选了 OpenAI 兼容却填了 …/anthropic）按地址判断真正的协议，不让用户因为这个报 404
  if (c.type === "openai-compat" || c.type === "anthropic") {
    const n = normalizeEndpoint(c.type, c.baseURL);
    if (n.type !== c.type || n.baseURL !== (c.baseURL ?? "")) {
      c = n.type === "anthropic"
        ? { type: "anthropic", apiKey: c.apiKey, model: c.model, ...(n.baseURL ? { baseURL: n.baseURL } : {}) }
        : { ...(c as Extract<ProviderConfig, { type: "openai-compat" }>), type: "openai-compat", baseURL: n.baseURL };
    }
  }
  switch (c.type) {
    case "openai-compat":
      needKey(name, c.apiKey);
      return { kind: "model", id: name, adapter: openaiCompat({ id: name, ...c }) };
    case "anthropic":
      needKey(name, c.apiKey);
      return { kind: "model", id: name, adapter: anthropic({ id: name, ...c }) };
    case "cli": {
      const preset = c.preset ? CLI_PRESETS[c.preset] : undefined;
      const command = c.command ?? preset?.command;
      if (!command) throw new Error(`provider ${name}：cli 类型需要 preset 或 command`);
      return {
        kind: "agent",
        id: name,
        backend: cliAgent({
          id: name,
          command,
          args: c.args ?? preset?.args ?? [],
          promptVia: c.promptVia ?? preset?.promptVia ?? "stdin",
          timeoutMs: c.timeoutSec ? c.timeoutSec * 1000 : undefined,
        }),
      };
    }
    case "cursor-sdk":
      needKey(name, c.apiKey);
      return { kind: "agent", id: name, backend: cursorSdk({ id: name, apiKey: c.apiKey, model: c.model }) };
  }
}

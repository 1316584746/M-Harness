import type { PluginEntry } from "../shared/plugins";

/** 软件自带的推荐（技能 / MCP / 动作 / 规则）的来源名。它们不是插件，在各自的设置页里展示 */
export const BUNDLED_SOURCE = "软件推荐";

type Def = Omit<PluginEntry, "key" | "source" | "author" | "license" | "updated" | "version"> & Partial<Pick<PluginEntry, "version" | "updated" | "license" | "author">>;

const mk = (d: Def): PluginEntry => ({ author: "M-Harness", license: "MIT", version: "1.0.0", updated: "2026-11-17", ...d, key: `${BUNDLED_SOURCE}:${d.id}`, source: BUNDLED_SOURCE });

/** 自带的插件：常用的 MCP 服务，以及几个开箱即用的技能 / 动作 / 规则 */
export const BUNDLED: PluginEntry[] = [
  // ───── MCP
  mk({
    id: "mcp-fetch",
    name: "网页抓取",
    kind: "mcp",
    author: "Anthropic",
    license: "MIT",
    version: "reference",
    updated: "2026-11-01",
    description: "抓取网页并转成 Markdown，让 Agent 能读取链接内容。需要先安装 uv（uvx 命令）。",
    tags: ["web", "fetch", "markdown"],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/fetch",
    install: { kind: "mcp", server: { command: "uvx", args: ["mcp-server-fetch"] }, note: "需要本机有 uv（https://docs.astral.sh/uv/）" },
  }),
  mk({
    id: "mcp-memory",
    name: "知识图谱记忆",
    kind: "mcp",
    author: "Anthropic",
    license: "MIT",
    version: "reference",
    updated: "2026-11-01",
    description: "基于知识图谱的长期记忆：Agent 可以记住实体、关系和事实，跨对话使用。",
    tags: ["memory", "knowledge-graph"],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/memory",
    install: { kind: "mcp", server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] } },
  }),
  mk({
    id: "mcp-sequential-thinking",
    name: "分步思考",
    kind: "mcp",
    author: "Anthropic",
    license: "MIT",
    version: "reference",
    updated: "2026-11-01",
    description: "让模型把复杂问题拆成可修正的思考步骤，适合排查问题和做方案设计。",
    tags: ["reasoning", "planning"],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking",
    install: { kind: "mcp", server: { command: "npx", args: ["-y", "@modelcontextprotocol/server-sequential-thinking"] } },
  }),
  mk({
    id: "mcp-time",
    name: "时间与时区",
    kind: "mcp",
    author: "Anthropic",
    license: "MIT",
    version: "reference",
    updated: "2026-11-01",
    description: "查询当前时间、做时区换算。需要先安装 uv（uvx 命令）。",
    tags: ["time", "timezone"],
    homepage: "https://github.com/modelcontextprotocol/servers/tree/main/src/time",
    install: { kind: "mcp", server: { command: "uvx", args: ["mcp-server-time"] }, note: "需要本机有 uv" },
  }),
  mk({
    id: "mcp-playwright",
    name: "浏览器自动化（Playwright）",
    kind: "mcp",
    author: "Microsoft",
    license: "Apache-2.0",
    version: "latest",
    updated: "2026-11-10",
    description: "用 Playwright 控制浏览器：打开页面、点击、填表、截图，适合做网页测试和数据采集。",
    tags: ["browser", "testing", "automation"],
    homepage: "https://github.com/microsoft/playwright-mcp",
    install: { kind: "mcp", server: { command: "npx", args: ["-y", "@playwright/mcp@latest"] } },
  }),
  mk({
    id: "mcp-context7",
    name: "Context7 文档查询",
    kind: "mcp",
    author: "Upstash",
    license: "MIT",
    version: "latest",
    updated: "2026-11-05",
    description: "按库名和版本查询最新的官方文档与代码示例，减少模型凭记忆写出过时的 API。",
    tags: ["docs", "library", "coding"],
    homepage: "https://github.com/upstash/context7",
    install: { kind: "mcp", server: { command: "npx", args: ["-y", "@upstash/context7-mcp"] } },
  }),
  mk({
    id: "mcp-chrome-devtools",
    name: "Chrome DevTools",
    kind: "mcp",
    author: "Google Chrome",
    license: "Apache-2.0",
    version: "latest",
    updated: "2026-11-08",
    description: "让 Agent 连接 Chrome 调试页面：看控制台、网络请求、性能，并操作页面。需要 Chrome。",
    tags: ["browser", "debug", "performance"],
    homepage: "https://github.com/ChromeDevTools/chrome-devtools-mcp",
    install: { kind: "mcp", server: { command: "npx", args: ["-y", "chrome-devtools-mcp@latest"] } },
  }),

  // ───── 技能
  mk({
    id: "skill-code-review",
    name: "代码评审",
    kind: "skill",
    description: "审查代码改动：先看 diff，再按严重程度列出问题，并给出可直接采纳的修改建议。",
    tags: ["review", "git", "quality"],
    install: {
      kind: "skill",
      name: "code-review",
      description: "审查当前代码改动（git diff）并给出按严重程度排序的问题清单",
      content: `# 代码评审

1. 用 git_read 查看当前工作区的改动（状态与 diff）；用户指明了范围（某个提交 / 分支）就按指明的来。
2. 逐个文件阅读改动，必要时用 read_file 看上下文，不要只凭 diff 下结论。
3. 按下面的顺序检查：正确性与边界条件 → 错误处理 → 安全（输入校验、密钥、注入）→ 并发与性能 → 可读性与命名 → 测试覆盖。
4. 输出：
   - 先给一句总体结论（可合入 / 需修改）。
   - 问题按「严重 / 一般 / 建议」分组，每条写明 文件:行 、问题、修改建议。
   - 没有发现问题的方面不用凑数。
5. 只评审，不要擅自修改文件，除非用户明确要求。`,
    },
  }),
  mk({
    id: "skill-commit-message",
    name: "规范提交信息",
    kind: "skill",
    description: "读取暂存区或工作区的改动，生成符合 Conventional Commits 的中文提交信息。",
    tags: ["git", "commit"],
    install: {
      kind: "skill",
      name: "commit-message",
      description: "根据当前改动生成规范的提交信息（Conventional Commits）",
      content: `# 生成提交信息

1. 用 git_read 查看改动（优先暂存区，没有暂存就看工作区）。
2. 判断类型：feat / fix / refactor / docs / test / chore / perf。
3. 输出格式：
   \`\`\`
   <type>(<scope>): <不超过 50 字的概要>

   - 改了什么、为什么改（每条一行）
   \`\`\`
4. 一次提交只讲一件事；改动混杂时，建议拆成多次提交并分别给出信息。
5. 只给出提交信息，不要自己执行 git commit，除非用户要求。`,
    },
  }),
  mk({
    id: "skill-bug-triage",
    name: "缺陷分析",
    kind: "skill",
    description: "拿到一个缺陷描述后，先复现思路、定位可能原因、再给出修复方案和验证步骤。",
    tags: ["bug", "debug"],
    install: {
      kind: "skill",
      name: "bug-triage",
      description: "分析缺陷：梳理现象、定位可能原因、给出修复方案和验证步骤",
      content: `# 缺陷分析

1. 复述现象：期望行为、实际行为、触发条件、影响范围；信息不够就先问最关键的 1-2 个问题。
2. 在代码里定位：用 list_dir / read_file 找到相关模块，沿着调用链往下读，记录证据（文件:行）。
3. 列出最多 3 个可能原因，按可能性排序，并说明怎么验证每一个。
4. 给出修复方案：最小改动、影响面、是否需要数据修复或兼容处理。
5. 给出验证步骤和建议补充的测试用例。
6. 不确定的结论要明确标注「推测」，不要编造。`,
    },
  }),
  mk({
    id: "skill-weekly-report",
    name: "周报整理",
    kind: "skill",
    description: "把零散的工作记录整理成结构清晰的周报：本周完成、进行中、风险、下周计划。",
    tags: ["report", "writing"],
    install: {
      kind: "skill",
      name: "weekly-report",
      description: "把零散的工作记录整理成结构清晰的周报",
      content: `# 周报整理

输入可以是零散的记录、提交列表、待办列表。输出固定结构：

## 本周完成
- 按项目 / 主题归类，每条一句话，写结果而不是过程。

## 进行中
- 当前进度和预计完成时间。

## 风险与问题
- 需要协助的事项、阻塞原因。

## 下周计划
- 按优先级排序。

要求：中文、简洁、不堆形容词；没有的栏目写「无」；不要编造输入里没有的事项。`,
    },
  }),

  // ───── 动作
  mk({
    id: "action-translate",
    name: "中英互译",
    kind: "action",
    description: "输入 / 选择后填入翻译模板：中文翻成英文，英文翻成中文，保留格式和术语。",
    tags: ["translate", "writing"],
    install: { kind: "action", prompt: "请把下面的内容翻译成另一种语言（中文译英文，其他语言译中文），保留原有的格式、代码和专有名词：\n\n{{input}}" },
  }),
  mk({
    id: "action-explain-code",
    name: "解释代码",
    kind: "action",
    description: "让 Agent 读懂一段代码或一个文件，讲清楚它做什么、关键流程和潜在问题。",
    tags: ["coding", "learning"],
    install: { kind: "action", prompt: "请阅读并解释下面的代码或文件：它的作用、关键流程、依赖的外部约定，以及你看到的潜在问题。\n\n{{input}}" },
  }),
  mk({
    id: "action-write-tests",
    name: "补充单元测试",
    kind: "action",
    description: "为指定的函数或文件补充单元测试，覆盖正常、边界和异常情况。",
    tags: ["testing", "coding"],
    install: { kind: "action", prompt: "请为下面的函数 / 文件补充单元测试：先阅读现有测试风格，再覆盖正常、边界和异常三类情况，写完后运行测试确认通过。\n\n{{input}}" },
  }),

  // ───── 规则
  mk({
    id: "rule-read-before-write",
    name: "先读后改",
    kind: "rule",
    description: "修改任何文件前必须先阅读相关代码，改动保持最小，改完说明影响范围。",
    tags: ["safety", "coding"],
    install: { kind: "rule", content: "修改文件前必须先用 read_file 阅读相关代码和调用方；改动保持最小，不顺手重构无关代码；改完用一两句话说明改了什么、影响哪里、如何验证。" },
  }),
  mk({
    id: "rule-concise-chinese",
    name: "简洁中文回复",
    kind: "rule",
    description: "统一用简洁的中文回答：先给结论，再给依据；不确定就明说。",
    tags: ["style"],
    install: { kind: "rule", content: "始终用中文回答，先给结论再给依据，语言简洁，不堆套话；不确定的内容明确说明「不确定」，不要编造事实、文件路径或命令输出。" },
  }),
];

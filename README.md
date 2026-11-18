# M-Harness

多模型、可接入办公 OA 的 Agent Harness。引擎负责 **运行 → 约束 → 观测 → 评测**，模型和办公软件都是可插拔的。

```
src/
├─ core/        loop（Agent 循环）· guardrails（护栏）· context（上下文）· trace（JSONL 回放）· types
├─ models/      openai-compat · anthropic · cli-agent · cursor-sdk
├─ tools/       read_file / write_file / list_dir / run_command / http_request + 路径沙箱
├─ channels/    feishu · dingtalk · session（指令/切换模型）· server（HTTP 回调）
├─ eval/        YAML 用例 + 断言 + 跨模型对比报告
├─ cli/         harness run | chat | eval | replay | serve | models | init
├─ config.ts    配置加载、${ENV} 展开、provider 注册表
└─ runtime.ts   把以上装配起来，CLI / 通道 / 将来的桌面端共用
```

## 桌面端

```powershell
npm run desktop          # 开发模式（热更新），数据放项目根：harness.config.json / .traces / evals
npm run desktop:build    # 构建到 out/
npm run desktop:smoke    # 启动真实 Electron，驱动界面跑一遍核心流程（需先 build）
npm run desktop:pack     # 打包成免安装目录 release/win-unpacked/M-Harness.exe
npm run desktop:dist     # 生成安装包（Windows: NSIS，macOS: dmg）
```

> 若终端里 `NODE_ENV=production`，先执行 `$env:NODE_ENV='development'`，否则 devDependencies 不会安装。国内网络下载 Electron 慢时设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。

| 页面 | 作用 |
|---|---|
| 对话 | 选模型 / Agent 对话；右侧实时时间线（每步的完整 prompt、工具参数与结果）；写文件 / 执行命令 / 联网弹窗审批，可"本次打开期间始终允许"；可随时停止；可切换工作区 |
| 回放 | 浏览历史 trace，按时间逐步查看，不调用模型 |
| 评测 | 选用例文件 + 多个模型，批量跑并对比通过率 / 步数 / token |
| 通道 | 启停飞书（lark-cli）通道，查看实时日志 |
| 设置 | 查看模型可用状态（缺 Key 会标出），在线编辑并校验配置文件 |

打包后的数据目录是系统用户数据目录（Windows：`%APPDATA%\m-harness`），首次启动自动生成默认配置；API Key 放在该目录的 `.env`。

## 两类模型后端

| 类型 | 谁驱动循环 | 配置 `type` | 覆盖 |
|---|---|---|---|
| 裸模型 | harness 自己（有护栏、审批、上下文压缩、逐步 trace） | `openai-compat` / `anthropic` | OpenAI、Codex 系列模型、DeepSeek、通义、Kimi、智谱、Ollama、各类中转、Claude |
| 外部 Agent | 外部 Agent 自己（harness 只做委托、超时、中断、进度观测） | `cli` / `cursor-sdk` | Codex CLI、Claude Code、Cursor Agent CLI、`@cursor/sdk` |

> 外部 Agent 用自己的文件/终端工具，不受 harness 路径沙箱约束；harness 只能限制它的工作目录、时长和触发入口。

## 快速开始

```powershell
npm install            # 若 NODE_ENV=production，请先 $env:NODE_ENV='development'
npm run harness -- init                      # 生成 harness.config.json
npm test
```

切到真实模型：把 Key 写入 `.env`（见 `.env.example`），然后

```powershell
npm run harness -- models
npm run harness -- run "读取 package.json 并总结" --provider deepseek
npm run harness -- chat --provider claude        # 会话中 /model <名称> 随时切换
```

## 护栏

- 工具按风险分级：`read` 放行，`write` / `exec` / `network` 默认**需审批**（CLI 里 y/N 确认，`--yes` 全部放行）。
- 危险命令（`rm -rf`、`rd /s`、`Remove-Item -Recurse`、`curl | sh`、`git push --force`……）**无论审批与否一律拦截**，可在 `guard.denyCommands` 追加正则。
- 文件工具限制在 `workspace` 之内（realpath 解析，防 `..` 与符号链接逃逸）。
- `http_request` 禁止内网 / 本机地址（防 SSRF），支持域名白名单。
- **办公通道默认只读**（`channels.toolPolicy: "readonly"`）：群里没人能审批，写 / 执行 / 联网一律拒绝。

## 评测

```powershell
npm run harness -- eval evals/basic.yaml --provider deepseek
npm run harness -- eval evals/ --provider deepseek,claude --judge claude   # 多模型对比
```

断言：`tool_called` `tool_not_called` `no_tool_blocked` `max_steps` `max_tokens` `done_reason` `final_contains` `final_not_contains` `final_regex` `llm_judge`。

## 接入办公软件

回调服务：`npm run harness -- serve`（配置见 `harness.config.office.example.json`）。聊天里可用指令：`/models` `/model <名称>` `/reset` `/stop` `/help`。每个会话（群 / 单聊）独立上下文、独立模型、消息串行处理。

### 飞书（推荐：用 lark-cli，免公网、免配密钥）

本机已装并登录官方 `lark-cli`（`lark-cli auth status` 里 bot 为 ready）即可，配置：

```json
"channels": { "larkCli": {
  "bin": "C:\\path\\to\\lark-cli.exe",
  "allowUsers": ["ou_你的open_id"]
} }
```

然后 `npm run harness -- serve`，看到 `长连接已就绪` 后，在飞书里私聊该应用机器人，或在群里 @ 它。

- 收消息：`lark-cli event consume im.message.receive_v1 --as bot`（长连接，NDJSON）；发回复：`lark-cli im +messages-reply --as bot --markdown -`（正文走 stdin）。
- 前提（在开放平台，一次性）：应用已开启机器人能力；事件订阅里添加 `im.message.receive_v1`；有 `im:message.p2p_msg:readonly`（群里 @ 还需 `im:message.group_at_msg:readonly`）和发消息权限；版本已发布。
- **务必配置 `allowUsers`**，否则任何能给机器人发消息的人都能驱动它。查自己的 open_id：`lark-cli auth status`。
- 同一应用同时只能有一个 `event consume` 在跑；报 "another bus" 时执行 `lark-cli event stop --all`。
- 退出请用 Ctrl+C（会让 consume 优雅清理服务端订阅，不要 `kill -9`）。

### 飞书（HTTP 回调，需公网地址）
1. 开放平台创建**企业自建应用**，开启「机器人」能力。
2. 权限：`im:message`、`im:message:send_as_bot`（接收群 @ 消息还需 `im:message.group_at_msg`）。
3. 事件与回调 → 事件配置 → 订阅方式选「将事件发送至开发者服务器」，请求地址 `https://<公网域名>/feishu/events`，添加事件 `im.message.receive_v1`。
4. 把 App ID / App Secret / Verification Token / Encrypt Key 填入 `.env`。
5. 发布应用版本；群里 @ 机器人，或单聊即可。

### 钉钉
1. 开放平台创建**企业内部应用**，添加「机器人」能力，消息接收模式选 **HTTP 模式**。
2. 消息接收地址 `https://<公网域名>/dingtalk/callback`。
3. 把 AppSecret 填入 `.env`（用于校验回调签名，签名无效或时间戳偏差 > 1 小时的请求一律拒绝）。
4. 回复通过消息自带的 `sessionWebhook` 发送，有效期内可用。

## 本地调试

| 想验证 | 做法 |
|---|---|
| 引擎逻辑 | `npm test`（本机起假的 OpenAI 兼容服务，无需 Key） |
| 全链路 | 配好一个模型的 Key 后 `harness run "..." --provider <名字>` |
| 通道 + 会话（无公网） | `npm run harness -- serve`，然后 `curl.exe -X POST http://127.0.0.1:8787/dev/chat -d "{\"text\":\"/models\"}"` |
| 真实飞书/钉钉回调 | `serve` + 内网穿透（`cloudflared tunnel --url http://localhost:8787` 或 ngrok），把公网地址填到开放平台 |
| 某次运行出了什么问题 | `harness replay .traces/<runId>.jsonl`（`--type tool_call`、`--json`） |
| 断点调试 | VS Code 选 `.vscode/launch.json` 里的配置，F5 |

`/dev/chat` 仅在服务监听回环地址（`127.0.0.1`）时启用；对公网暴露时（`0.0.0.0`）自动关闭。

## 已知限制 / 后续

- 飞书已支持 lark-cli 长连接（免公网）；钉钉目前只有 **HTTP 回调** 模式（需公网地址），本机未发现钉钉 CLI，装好后可仿照 `channels/lark-cli.ts` 接入。
- 外部 Agent（Codex / Cursor 等）暂无跨消息的会话记忆，只会把最近 6 条历史拼进提示词。
- Cursor CLI / Codex CLI 的命令行参数是按公开用法写的预设，版本变化后可在 `providers.*.args` 覆盖。
- 桌面端（Electron）尚未开始：`Runtime` 已和 UI 解耦，接 IPC 即可。

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { parseArgs } from "node:util";
import { startServer } from "../channels/server";
import { loadConfig } from "../config";
import { approveAll, type Approver } from "../core/guardrails";
import { formatEvent, readTrace } from "../core/trace";
import type { Msg } from "../core/types";
import { formatSummary, loadEvalCases, runEval, type JudgeFn } from "../eval/eval";
import { Runtime } from "../runtime";

const USAGE = `harness — 多模型 Agent Harness

用法：
  harness run "<任务>"        运行一次任务      [--provider x] [--workspace dir] [--yes] [--quiet]
  harness chat               交互式会话        [--provider x] [--workspace dir] [--yes]
  harness eval <文件|目录>    批量评测          [--provider a,b] [--judge p]
  harness replay <trace文件>  回放 trace        [--type tool_call] [--json]
  harness serve              启动飞书/钉钉回调服务
  harness models             列出已配置的 provider
  harness init               生成 harness.config.json 示例

通用参数： --config <file>  配置文件，默认 ./harness.config.json
`;

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (!cmd || cmd === "-h" || cmd === "--help" || cmd === "help") return void console.log(USAGE);

  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      config: { type: "string" },
      provider: { type: "string", short: "p" },
      workspace: { type: "string", short: "w" },
      yes: { type: "boolean", short: "y" },
      quiet: { type: "boolean", short: "q" },
      judge: { type: "string" },
      type: { type: "string" },
      json: { type: "boolean" },
    },
  });

  if (cmd === "init") return init();
  if (cmd === "replay") return replay(positionals[0], values.type, values.json);

  const { config, file } = loadConfig(values.config);
  const rt = new Runtime(config);
  if (!file && cmd !== "models") console.error("（未找到 harness.config.json。执行 harness init 生成示例配置，再把模型的 Key 填进去）");

  try {
  switch (cmd) {
    case "models":
      for (const n of rt.registry.names()) {
        console.log(`${n === config.defaultProvider ? "*" : " "} ${n.padEnd(14)} ${rt.registry.describe(n)}`);
      }
      return;
    case "run": {
      const input = positionals.join(" ").trim();
      if (!input) throw new Error('缺少任务内容，例如：harness run "列出当前目录文件"');
      const rl = values.yes ? undefined : readline.createInterface({ input: process.stdin, output: process.stderr });
      try {
        const r = await rt.runTask({
          input,
          provider: values.provider,
          workspace: values.workspace,
          approve: values.yes ? approveAll : makeApprover(rl!),
          emit: values.quiet ? undefined : e => console.error(formatEvent(e)),
        });
        console.log(r.text || (r.error ? `（${r.error}）` : ""));
        console.error(`\ntrace: ${r.traceFile}`);
        process.exitCode = r.reason === "final" ? 0 : 1;
      } finally {
        rl?.close();
      }
      return;
    }
    case "chat":
      return chat(rt, values);
    case "eval": {
      if (!positionals[0]) throw new Error("缺少评测文件或目录，例如：harness eval evals/");
      const suites = loadEvalCases(positionals[0]);
      const providers = (values.provider ?? config.defaultProvider).split(",").map(s => s.trim());
      const judge = values.judge ? makeJudge(rt, values.judge) : undefined;
      const reports = await runEval(rt, suites, providers, judge, r => {
        console.log(`${r.pass ? "✅" : "❌"} [${r.provider}] ${r.name}  步数=${r.steps} token=${r.tokens} ${r.ms}ms`);
        for (const f of r.failures) console.log(`     ↳ ${f.assertion}: ${f.detail}`);
      });
      console.log("\n" + formatSummary(reports));
      process.exitCode = reports.every(r => r.pass) ? 0 : 1;
      return;
    }
    case "serve":
      startServer(rt);
      return;
    default:
      console.error(`未知命令：${cmd}\n`);
      console.log(USAGE);
      process.exitCode = 2;
  }
  } finally {
    // MCP 的本地子进程要显式关闭，否则命令不会退出（serve 常驻，不在此关闭）
    if (cmd !== "serve") await rt.dispose();
  }
}

function makeApprover(rl: readline.Interface): Approver {
  return ({ tool, args, reason }) =>
    new Promise(resolve => {
      console.error(`\n⚠ ${reason}：${tool.name}\n${JSON.stringify(args, null, 2)}`);
      rl.question("允许执行？[y/N] ", a => resolve(/^y(es)?$/i.test(a.trim())));
    });
}

async function chat(rt: Runtime, values: { provider?: string; workspace?: string; yes?: boolean }) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string) => new Promise<string>(r => rl.question(q, r));
  let provider = values.provider ?? rt.config.defaultProvider;
  let history: Msg[] = [];
  console.log(`会话开始，当前 provider=${provider}。指令：/model <名称>  /models  /reset  /exit`);
  for (;;) {
    const line = (await ask("\n你> ")).trim();
    if (!line) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/reset") {
      history = [];
      console.log("已清空上下文");
      continue;
    }
    if (line === "/models") {
      for (const n of rt.registry.names()) console.log(`${n === provider ? "*" : " "} ${n} — ${rt.registry.describe(n)}`);
      continue;
    }
    if (line.startsWith("/model ")) {
      const n = line.slice(7).trim();
      if (rt.registry.has(n)) provider = n;
      console.log(rt.registry.has(n) ? `已切换到 ${n}` : `未知 provider：${n}`);
      continue;
    }
    try {
      const r = await rt.runTask({
        input: line,
        provider,
        history,
        workspace: values.workspace,
        approve: values.yes ? approveAll : makeApprover(rl),
        emit: e => console.log(formatEvent(e)),
      });
      history = r.messages;
      console.log(`\n${provider}> ${r.text || r.error || ""}`);
    } catch (e: any) {
      console.log(`出错：${e?.message ?? e}`);
    }
  }
  rl.close();
}

function makeJudge(rt: Runtime, providerName: string): JudgeFn {
  const p = rt.registry.get(providerName);
  if (p.kind !== "model") throw new Error("裁判必须是模型类 provider（openai-compat / anthropic）");
  return async (criteria, input, output) => {
    const r = await p.adapter.chat(
      [
        { role: "system", content: "你是严格的评测裁判。只回答 PASS 或 FAIL，不要解释。" },
        { role: "user", content: `评判标准：${criteria}\n\n任务输入：${input}\n\n待评内容：${output}` },
      ],
      [],
      new AbortController().signal,
    );
    return /\bPASS\b/i.test(r.message.content);
  };
}

function replay(file: string | undefined, type?: string, json?: boolean) {
  if (!file) throw new Error("缺少 trace 文件路径");
  const lines = readTrace(file);
  const t0 = lines[0]?.ts ?? 0;
  for (const l of lines) {
    if (type && l.event.type !== type) continue;
    if (json) console.log(JSON.stringify(l.event, null, 2));
    else console.log(`+${String(l.ts - t0).padStart(6)}ms ${formatEvent(l.event)}`);
  }
}

function init() {
  const dest = path.resolve("harness.config.json");
  if (fs.existsSync(dest)) throw new Error(`${dest} 已存在，未覆盖`);
  const src = path.resolve("harness.config.example.json");
  if (!fs.existsSync(src)) throw new Error("找不到 harness.config.example.json");
  fs.copyFileSync(src, dest);
  console.log(`已生成 ${dest}，请按需填写（密钥建议放 .env，用 \${ENV_NAME} 引用）`);
}

main().catch(e => {
  console.error(`✖ ${e?.message ?? e}`);
  process.exit(1);
});

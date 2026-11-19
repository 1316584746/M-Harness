import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { AgentBackend } from "../core/types";

export interface CliAgentOptions {
  id: string;
  command: string;
  /** 参数模板；arg 模式下用 {prompt} 占位 */
  args: string[];
  /** 提示词传递方式：arg=命令行参数 / stdin=标准输入 / file=写临时文件并让 agent 去读 */
  promptVia: "arg" | "stdin" | "file";
  env?: Record<string, string>;
  /** 单次运行超时（毫秒），默认 10 分钟 */
  timeoutMs?: number;
}

/** 常见 CLI Agent 的预设，可在配置里用同名 preset 引用并覆盖 */
export const CLI_PRESETS: Record<string, Omit<CliAgentOptions, "id">> = {
  // OpenAI Codex CLI：`codex exec` 非交互模式，提示词走 stdin
  codex: { command: "codex", args: ["exec", "--skip-git-repo-check", "-"], promptVia: "stdin" },
  // Cursor Agent CLI：`cursor-agent -p "<prompt>"` 无头模式
  "cursor-cli": { command: "cursor-agent", args: ["-p", "{prompt}"], promptVia: "arg" },
  // Claude Code：`claude -p` 非交互，提示词走 stdin
  "claude-code": { command: "claude", args: ["-p"], promptVia: "stdin" },
};

/** 把任意 CLI Agent 包装成 AgentBackend：harness 只负责启动、观测、超时、中断 */
export function cliAgent(o: CliAgentOptions): AgentBackend {
  return {
    id: o.id,
    run({ prompt, cwd, signal, onProgress }) {
      const isWin = process.platform === "win32";
      // Windows 下 .cmd 垫片必须经 shell 启动；此时命令行参数里放用户内容有注入风险，降级为 file 模式
      const via = o.promptVia === "arg" && isWin ? "file" : o.promptVia;

      let args = [...o.args];
      if (via === "file") {
        const dir = path.join(cwd, ".harness", "prompts");
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.md`);
        fs.writeFileSync(file, prompt, "utf8");
        const instruction = `请完整阅读并执行文件 ${file} 中的任务说明，完成后直接输出最终结果。`;
        args = args.map(a => a.replace("{prompt}", instruction));
      } else if (via === "arg") {
        args = args.map(a => a.replace("{prompt}", prompt));
      }

      return new Promise((resolve, reject) => {
        const child = isWin
          ? spawn([o.command, ...args].map(quoteWin).join(" "), { cwd, shell: true, windowsHide: true, env: { ...process.env, ...o.env } })
          : spawn(o.command, args, { cwd, env: { ...process.env, ...o.env } });

        let out = "";
        let errBuf = "";
        let pending = "";
        child.stdout.on("data", (b: Buffer) => {
          const s = b.toString("utf8");
          out += s;
          pending += s;
          const lines = pending.split("\n");
          pending = lines.pop() ?? "";
          for (const l of lines) if (l.trim()) onProgress?.(l, "text");
        });
        child.stderr.on("data", (b: Buffer) => {
          const s = b.toString("utf8");
          errBuf += s;
          for (const l of s.split("\n")) if (l.trim()) onProgress?.(l.trim(), "status");
        });
        onProgress?.(`已启动 ${o.command}，等待输出…`, "status");

        const kill = () => {
          if (isWin && child.pid) spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
          else child.kill("SIGKILL");
        };
        const timer = setTimeout(kill, o.timeoutMs ?? 600_000);
        const onAbort = () => kill();
        signal.addEventListener("abort", onAbort, { once: true });

        child.on("error", e => {
          clearTimeout(timer);
          reject(new Error(`无法启动 ${o.command}：${e.message}（是否已安装并在 PATH 中？）`));
        });
        child.on("close", code => {
          clearTimeout(timer);
          signal.removeEventListener("abort", onAbort);
          if (signal.aborted) return reject(new Error("已中断"));
          if (code !== 0) return reject(new Error(`${o.command} 退出码 ${code}：${(errBuf || out).slice(-500)}`));
          resolve({ text: out.trim() });
        });

        if (via === "stdin") child.stdin.end(prompt, "utf8");
        else child.stdin.end();
      });
    },
  };
}

function quoteWin(a: string): string {
  if (a !== "" && !/[\s"&|<>^%()]/.test(a)) return a;
  return `"${a.replace(/"/g, '\\"')}"`;
}

import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { z } from "zod";
import type { Tool } from "../core/types";
import { resolveInside } from "./sandbox";

const MAX_OUT = 200_000;

function decode(buf: Buffer): string {
  const utf8 = buf.toString("utf8");
  if (process.platform === "win32" && utf8.includes("\uFFFD")) {
    try {
      return new TextDecoder("gbk").decode(buf); // Windows 中文控制台常见 GBK
    } catch {
      /* ignore */
    }
  }
  return utf8;
}

export const readFile: Tool = {
  name: "read_file",
  description: "读取沙箱目录内的文本文件。可用 offset/limit 按行分段读取。",
  risk: "read",
  schema: z.object({
    path: z.string().describe("文件路径，相对沙箱根目录"),
    offset: z.number().int().min(1).optional().describe("起始行号（从 1 开始）"),
    limit: z.number().int().min(1).max(2000).optional().describe("读取行数"),
  }),
  async run({ path: p, offset, limit }, ctx) {
    const file = resolveInside(ctx.root, p);
    const text = await fs.readFile(file, "utf8");
    if (!offset && !limit) return text;
    const lines = text.split(/\r?\n/);
    const start = (offset ?? 1) - 1;
    return lines
      .slice(start, start + (limit ?? 200))
      .map((l, i) => `${start + i + 1}|${l}`)
      .join("\n");
  },
};

export const writeFile: Tool = {
  name: "write_file",
  description: "写入（覆盖）沙箱目录内的文件，不存在则创建，自动创建父目录。",
  risk: "write",
  schema: z.object({
    path: z.string().describe("文件路径，相对沙箱根目录"),
    content: z.string().describe("完整文件内容"),
  }),
  async run({ path: p, content }, ctx) {
    const file = resolveInside(ctx.root, p);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content, "utf8");
    return `已写入 ${path.relative(ctx.root, file) || p}（${content.length} 字符）`;
  },
};

export const listDir: Tool = {
  name: "list_dir",
  description: "列出沙箱目录内某个目录的文件与子目录。",
  risk: "read",
  schema: z.object({ path: z.string().default(".").describe("目录路径，默认沙箱根目录") }),
  async run({ path: p }, ctx) {
    const dir = resolveInside(ctx.root, p);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    return (
      entries
        .filter(e => e.name !== "node_modules" && e.name !== ".git")
        .map(e => (e.isDirectory() ? e.name + "/" : e.name))
        .sort()
        .join("\n") || "（空目录）"
    );
  },
};

export const runCommand: Tool = {
  name: "run_command",
  description: "在沙箱目录内执行一条 shell 命令（Windows 为 cmd，其他为 sh），默认 60 秒超时。",
  risk: "exec",
  schema: z.object({
    command: z.string().describe("要执行的命令"),
    cwd: z.string().optional().describe("工作目录，相对沙箱根目录"),
    timeoutSec: z.number().int().min(1).max(600).optional(),
  }),
  run({ command, cwd, timeoutSec }, ctx) {
    const workdir = resolveInside(ctx.root, cwd ?? ".");
    return new Promise<string>(resolve => {
      const child = spawn(command, { cwd: workdir, shell: true, windowsHide: true });
      const chunks: Buffer[] = [];
      let size = 0;
      const onData = (b: Buffer) => {
        if (size < MAX_OUT) {
          chunks.push(b);
          size += b.length;
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);

      let timedOut = false;
      const kill = () => {
        if (process.platform === "win32" && child.pid) {
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
        } else {
          child.kill("SIGKILL");
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, (timeoutSec ?? 60) * 1000);
      const onAbort = () => kill();
      ctx.signal.addEventListener("abort", onAbort, { once: true });

      child.on("close", code => {
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", onAbort);
        const out = decode(Buffer.concat(chunks));
        resolve(`${timedOut ? "[超时已终止] " : ""}exit=${code}\n${out}`);
      });
      child.on("error", e => {
        clearTimeout(timer);
        resolve(`启动失败：${e.message}`);
      });
    });
  },
};

export const httpRequest: Tool = {
  name: "http_request",
  description: "发送 HTTP(S) 请求并返回状态码与响应文本（不自动跟随重定向）。",
  risk: "network",
  schema: z.object({
    url: z.string().url(),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).default("GET"),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
  }),
  async run({ url, method, headers, body }, ctx) {
    const res = await fetch(url, {
      method,
      headers,
      body,
      redirect: "manual",
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(30_000)]),
    });
    const text = await res.text();
    const loc = res.headers.get("location");
    return `HTTP ${res.status}${loc ? ` → Location: ${loc}` : ""}\n${text.slice(0, MAX_OUT)}`;
  },
};

export const builtinTools: Tool[] = [readFile, writeFile, listDir, runCommand, httpRequest];

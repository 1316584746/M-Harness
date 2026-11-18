import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Tool } from "../core/types";

/**
 * Git 工具：让模型读代码仓库的状态/历史/差异（只读），以及在确认后提交、切分支、推送（写类）。
 * - 不经过 shell，参数逐个传给 git，避免命令注入；
 * - 读类禁掉能写文件 / 起外部程序 / 读沙箱外文件的选项（--output、--ext-diff、--no-index 等）；
 * - 写类拒绝强推、删除远端分支等不可逆操作；
 * - 工作目录默认是当前工作区，也可以指定配置里登记过的仓库名。
 */

export interface RepoConfig {
  path: string;
  url?: string;
  branch?: string;
  platform?: string;
  branches?: { base?: string; test?: string; integration?: string };
}

export const GIT_READ = ["status", "log", "diff", "show", "branch", "blame", "ls-files", "rev-parse", "grep", "remote", "tag", "shortlog", "describe", "rev-list", "diff-tree", "show-ref", "cat-file", "merge-base", "name-rev"];
export const GIT_WRITE = ["add", "commit", "switch", "checkout", "branch", "fetch", "pull", "push", "merge", "stash", "tag", "restore", "cherry-pick"];

/** 读类里一律禁止的选项：会写文件、启动外部程序、或越出仓库读文件 */
const READ_BAD = /^(-O|--output|--open-files-in-pager|--ext-diff|--textconv|--no-index|--exec|--git-dir|--work-tree|--exec-path|--upload-pack|--receive-pack|--contents)(=.*)?$|^-O./;
/** branch / tag 里会改动仓库的选项（只读模式下禁止） */
const REF_MUTATE = /^(-d|-D|-m|-M|-c|-C|-f|-u|-a|--delete|--move|--copy|--force|--set-upstream-to(=.*)?|--unset-upstream|--edit-description|--track|--no-track|--create-reflog)$/;

/** 写类里不可逆 / 危险的选项与形式 */
const WRITE_BAD = /^(--force|-f|--force-with-lease(=.*)?|--force-if-includes|--delete|-d|-D|--mirror|--prune|--no-verify-signatures|--exec|--upload-pack|--receive-pack|--git-dir|--work-tree|--exec-path)(=.*)?$/;

const MAX_OUT = 200_000;

function decode(buf: Buffer): string {
  const utf8 = buf.toString("utf8");
  if (process.platform === "win32" && utf8.includes("\uFFFD")) {
    try {
      return new TextDecoder("gbk").decode(buf);
    } catch {
      /* ignore */
    }
  }
  return utf8;
}

export function runGit(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
  timeoutSec = 60,
  extraEnv?: Record<string, string>,
): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise(resolve => {
    const child = spawn("git", ["-c", "core.quotepath=false", "-c", "core.pager=cat", ...args], {
      cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat", GIT_OPTIONAL_LOCKS: "0", GIT_EDITOR: "true", ...extraEnv },
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    child.stdout.on("data", (b: Buffer) => {
      if (size < MAX_OUT) {
        out.push(b);
        size += b.length;
      }
    });
    child.stderr.on("data", (b: Buffer) => err.length < 200 && err.push(b));
    const timer = setTimeout(() => child.kill(), timeoutSec * 1000);
    const onAbort = () => child.kill();
    signal?.addEventListener("abort", onAbort, { once: true });
    child.on("error", e => {
      clearTimeout(timer);
      resolve({ code: -1, out: "", err: `无法启动 git：${e.message}（请确认已安装 Git 并在 PATH 里）` });
    });
    child.on("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve({ code, out: decode(Buffer.concat(out)), err: decode(Buffer.concat(err)) });
    });
  });
}

/** 校验并拼出 git 参数；不合法时抛错（错误信息会返回给模型） */
export function buildGitArgs(kind: "read" | "write", command: string, args: string[] = []): string[] {
  const cmd = command.trim();
  const list = kind === "read" ? GIT_READ : GIT_WRITE;
  if (!list.includes(cmd)) throw new Error(`不支持的 git 子命令：${cmd}。可用：${list.join("、")}`);
  for (const a of args) {
    if (/[\r\n\0]/.test(a)) throw new Error("参数里不能包含换行");
    if (kind === "read" && READ_BAD.test(a)) throw new Error(`只读模式不允许选项 ${a}`);
    if (kind === "read" && cmd === "grep" && (a === "-f" || a === "--file" || a.startsWith("--file="))) throw new Error("只读模式的 grep 不允许从文件读取模式");
    if (kind === "read" && (cmd === "branch" || cmd === "tag") && REF_MUTATE.test(a) && !(cmd === "branch" && a === "-a")) throw new Error(`只读模式不允许选项 ${a}`);
    if (kind === "write" && WRITE_BAD.test(a)) throw new Error(`不允许选项 ${a}（强推、删除分支等不可逆操作请自己在终端执行）`);
    if (kind === "write" && cmd === "push" && a.startsWith(":")) throw new Error("不允许用 :ref 形式删除远端分支");
    if (kind === "write" && cmd === "push" && a.startsWith("+")) throw new Error("不允许用 +ref 形式强推");
  }
  if (kind === "read") {
    // 读类的 branch / tag / remote 只允许列出，不允许带名字去创建或修改
    const positional = args.filter(a => !a.startsWith("-"));
    if (cmd === "branch" && positional.length && !args.some(a => a === "--contains" || a === "--merged" || a === "--no-merged" || a === "--list" || a === "-l" || a === "--points-at")) {
      throw new Error("只读模式的 branch 只能列出分支；创建分支请用 git_write");
    }
    if (cmd === "tag" && positional.length && !args.some(a => a === "--list" || a === "-l" || a === "--contains" || a === "--points-at")) {
      throw new Error("只读模式的 tag 只能列出标签；创建标签请用 git_write");
    }
    if (cmd === "remote" && args.some(a => ["add", "remove", "rm", "rename", "set-url", "prune", "update", "set-head", "set-branches"].includes(a))) {
      throw new Error("只读模式的 remote 只能查看");
    }
    if (cmd === "ls-files" || cmd === "grep" || cmd === "diff" || cmd === "log" || cmd === "show" || cmd === "blame") {
      // 路径参数不得越出仓库
      for (const a of positional) if (/(^|[\\/])\.\.([\\/]|$)/.test(a) || path.isAbsolute(a)) throw new Error(`路径必须在仓库内：${a}`);
    }
  }
  return [cmd, ...args];
}

export function resolveRepoDir(root: string, repos: Record<string, RepoConfig>, repo?: string): string {
  if (!repo) return root;
  const r = repos[repo];
  if (!r) throw new Error(`未知仓库：${repo}。已登记：${Object.keys(repos).join("、") || "（无）"}`);
  if (!fs.existsSync(r.path)) throw new Error(`仓库目录不存在：${r.path}`);
  return path.resolve(r.path);
}

const ArgsField = z.array(z.string()).default([]).describe('git 参数数组，如 ["--oneline","-n","20"]');
const RepoField = z.string().optional().describe("已登记的仓库名；不填则使用当前工作区所在仓库");

function fmt(r: { code: number | null; out: string; err: string }): string {
  if (r.code === 0) return (r.out + (r.err ? `\n[stderr]\n${r.err}` : "")).trim() || "（无输出）";
  return `git 退出码 ${r.code}\n${(r.err || r.out).trim()}`;
}

/** authEnv：按远端地址给出认证用的环境变量（令牌来自设置里的托管平台账号） */
export function gitTools(repos: Record<string, RepoConfig> = {}, authEnv?: (remoteUrl: string) => Record<string, string>): Tool[] {
  const names = Object.keys(repos);
  const hint = names.length ? `已登记仓库：${names.join("、")}。` : "";
  return [
    {
      name: "git_repos",
      description: "列出已登记的代码仓库（名称、本地路径、远端地址、平台，以及约定的基线 / 提测 / 联调分支 branches.base / test / integration）。创建 feature 分支、提测、联调时按这些分支操作。",
      risk: "read",
      schema: z.object({}),
      async run() {
        return names.length ? JSON.stringify(Object.entries(repos).map(([name, r]) => ({ name, ...r })), null, 2) : "还没有登记任何仓库（在 设置 → 代码仓库 里添加）。";
      },
    },
    {
      name: "git_read",
      description: `只读 git 操作：${GIT_READ.join("、")}。用来看状态、提交历史、差异、谁改了哪行。${hint}`,
      risk: "read",
      schema: z.object({ command: z.string().describe('子命令，如 "log"'), args: ArgsField, repo: RepoField }),
      async run({ command, args, repo }, ctx) {
        const argv = buildGitArgs("read", command, args);
        const cwd = resolveRepoDir(ctx.root, repos, repo);
        return fmt(await runGit(argv, cwd, ctx.signal));
      },
    },
    {
      name: "git_write",
      description: `会改动仓库的 git 操作（调用前需要用户确认）：${GIT_WRITE.join("、")}。不允许强推、删除远端分支。提交前先用 git_read status/diff 确认改动。${hint}`,
      risk: "write",
      schema: z.object({ command: z.string().describe('子命令，如 "commit"'), args: ArgsField, repo: RepoField }),
      async run({ command, args, repo }, ctx) {
        const argv = buildGitArgs("write", command, args);
        const cwd = resolveRepoDir(ctx.root, repos, repo);
        let env: Record<string, string> | undefined;
        if (authEnv && ["fetch", "pull", "push"].includes(argv[0])) {
          const origin = (await runGit(["remote", "get-url", "origin"], cwd, ctx.signal, 15)).out.trim();
          env = authEnv(origin);
        }
        return fmt(await runGit(argv, cwd, ctx.signal, 300, env));
      },
    },
  ];
}

// ───────────── 供桌面端设置页使用 ─────────────

export interface RepoInspect {
  ok: boolean;
  error?: string;
  root?: string;
  name?: string;
  url?: string;
  branch?: string;
  platform?: string;
}

export function detectPlatform(url?: string): string {
  if (!url) return "local";
  if (/github\.com/i.test(url)) return "github";
  if (/gitlab/i.test(url)) return "gitlab";
  if (/gitee\.com/i.test(url)) return "gitee";
  if (/codeup\.aliyun|aliyuncs|yunxiao/i.test(url)) return "codeup";
  return "other";
}

export async function inspectRepo(dir: string): Promise<RepoInspect> {
  if (!fs.existsSync(dir)) return { ok: false, error: "目录不存在" };
  const top = await runGit(["rev-parse", "--show-toplevel"], dir, undefined, 15);
  if (top.code !== 0) return { ok: false, error: "这个目录不是 Git 仓库" };
  const root = path.resolve(top.out.trim());
  const url = (await runGit(["remote", "get-url", "origin"], root, undefined, 15)).out.trim() || undefined;
  const branch = (await runGit(["branch", "--show-current"], root, undefined, 15)).out.trim() || undefined;
  return { ok: true, root, name: path.basename(root), url, branch, platform: detectPlatform(url) };
}

/** 本地 + 远端分支名（去掉 origin/ 前缀、去重、排序），给设置页的分支下拉用 */
export async function listBranches(dir: string): Promise<string[]> {
  if (!fs.existsSync(dir)) return [];
  const r = await runGit(["branch", "-a", "--format=%(refname:short)"], dir, undefined, 20);
  if (r.code !== 0) return [];
  const names = r.out
    .split(/\r?\n/)
    .map(s => s.trim())
    .filter(s => s && !/(^|\/)HEAD$/.test(s) && !s.startsWith("(") && s !== "origin")
    .map(s => s.replace(/^origin\//, ""));
  return [...new Set(names)].sort();
}

export interface RepoStatus {
  exists: boolean;
  branch?: string;
  changed: number;
  ahead: number;
  behind: number;
  last?: string;
  error?: string;
}

export async function repoStatus(dir: string): Promise<RepoStatus> {
  if (!fs.existsSync(dir)) return { exists: false, changed: 0, ahead: 0, behind: 0, error: "目录不存在" };
  const st = await runGit(["status", "--porcelain=v1", "-b"], dir, undefined, 20);
  if (st.code !== 0) return { exists: true, changed: 0, ahead: 0, behind: 0, error: st.err.trim() || "不是 Git 仓库" };
  const lines = st.out.split(/\r?\n/).filter(Boolean);
  const head = lines[0] ?? "";
  const branch = /^## (?:No commits yet on |Initial commit on )?([^\s.]+(?:\/[^\s.]+)*)/.exec(head)?.[1];
  const ahead = Number(/ahead (\d+)/.exec(head)?.[1] ?? 0);
  const behind = Number(/behind (\d+)/.exec(head)?.[1] ?? 0);
  const last = (await runGit(["log", "-1", "--pretty=%h %s · %cr"], dir, undefined, 15)).out.trim() || undefined;
  return { exists: true, branch, changed: lines.length - 1, ahead, behind, last };
}

/** 工作区相对 HEAD 的改动行数（已暂存 + 未暂存；二进制文件只算文件数） */
export async function diffStat(dir: string): Promise<{ added: number; deleted: number; files: number }> {
  const r = await runGit(["diff", "HEAD", "--numstat"], dir, undefined, 30);
  if (r.code !== 0) return { added: 0, deleted: 0, files: 0 };
  let added = 0;
  let deleted = 0;
  let files = 0;
  for (const line of r.out.split(/\r?\n/)) {
    const m = /^(\d+|-)\t(\d+|-)\t/.exec(line);
    if (!m) continue;
    files++;
    added += m[1] === "-" ? 0 : Number(m[1]);
    deleted += m[2] === "-" ? 0 : Number(m[2]);
  }
  return { added, deleted, files };
}

/** 克隆仓库；只允许常见的远程地址形式，拒绝 ext:: 等会执行命令的传输方式 */
export async function cloneRepo(
  url: string,
  targetDir: string,
  signal?: AbortSignal,
  env?: Record<string, string>,
): Promise<{ ok: boolean; path?: string; error?: string }> {
  const u = url.trim();
  if (!/^(https?:\/\/|ssh:\/\/|git@[\w.-]+:)/i.test(u)) return { ok: false, error: "地址需要以 https://、ssh:// 或 git@ 开头" };
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length) return { ok: false, error: "目标目录已存在且不为空" };
  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  const r = await runGit(["clone", "--", u, targetDir], path.dirname(targetDir), signal, 900, env);
  return r.code === 0 ? { ok: true, path: path.resolve(targetDir) } : { ok: false, error: (r.err || r.out).trim().split("\n").slice(-3).join("\n") };
}

export interface SyncResult {
  ok: boolean;
  /** 同步后所在的分支 */
  branch?: string;
  /** 用的基线分支 */
  base?: string;
  switched: boolean;
  pulled: boolean;
  /** 没做的事和原因（比如有未提交改动，不敢切分支） */
  skipped?: string;
  error?: string;
}

/** 基线分支：配置的优先，其次远端默认分支（origin/HEAD），再试 main / master / develop */
export async function detectBaseBranch(dir: string, configured?: string): Promise<string | undefined> {
  if (configured?.trim()) return configured.trim();
  const head = await runGit(["symbolic-ref", "--short", "refs/remotes/origin/HEAD"], dir, undefined, 15);
  const fromHead = head.code === 0 ? head.out.trim().replace(/^origin\//, "") : "";
  if (fromHead) return fromHead;
  const have = new Set(await listBranches(dir));
  return ["main", "master", "develop"].find(b => have.has(b));
}

/**
 * 把仓库同步到基线分支的最新代码：fetch → 切到基线分支 → 快进拉取。
 * 不会丢东西：工作区有未提交的改动时不切分支；拉取只做快进（--ff-only），有分叉就报错不合并。
 * 联网失败（没网 / 没权限）时，仍然会切到本地已有的基线分支，并在 skipped 里说明没拉到最新。
 */
export async function syncBaseBranch(dir: string, configured?: string, signal?: AbortSignal, env?: Record<string, string>): Promise<SyncResult> {
  const out: SyncResult = { ok: false, switched: false, pulled: false };
  const st = await repoStatus(dir);
  if (!st.exists) return { ...out, error: "目录不存在" };
  if (st.error) return { ...out, error: st.error };
  const base = await detectBaseBranch(dir, configured);
  if (!base) return { ...out, branch: st.branch, error: "没有找到基线分支（可以在设置里给这个仓库填基线分支）" };
  out.base = base;
  out.branch = st.branch;

  const notes: string[] = [];
  const hasRemote = (await runGit(["remote"], dir, undefined, 15)).out.trim().length > 0;
  let fetched = false;
  if (hasRemote) {
    const f = await runGit(["fetch", "--prune", "origin"], dir, signal, 120, env);
    fetched = f.code === 0;
    if (!fetched) notes.push(`没能拉取远端（${(f.err || f.out).trim().split("\n").slice(-1)[0] || "网络或权限问题"}）`);
  } else notes.push("这个仓库没有远端，只用本地分支");

  if (st.branch !== base) {
    if (st.changed > 0) {
      notes.push(`当前分支 ${st.branch ?? "（游离）"} 有 ${st.changed} 个文件未提交，没有切换到 ${base}`);
      return { ...out, ok: true, skipped: notes.join("；") };
    }
    const sw = await runGit(["switch", base], dir, signal, 60);
    if (sw.code !== 0) return { ...out, error: `切换到 ${base} 失败：${(sw.err || sw.out).trim().split("\n").slice(-1)[0]}` };
    out.switched = true;
    out.branch = base;
  }

  if (fetched) {
    const up = await runGit(["rev-parse", "--abbrev-ref", `${base}@{upstream}`], dir, undefined, 15);
    if (up.code === 0) {
      const p = await runGit(["pull", "--ff-only"], dir, signal, 120, env);
      if (p.code !== 0) return { ...out, error: `拉取最新代码失败：${(p.err || p.out).trim().split("\n").slice(-1)[0]}` };
      out.pulled = true;
    } else notes.push(`${base} 没有对应的远端分支，没有拉取`);
  }
  return { ...out, ok: true, skipped: notes.length ? notes.join("；") : undefined };
}

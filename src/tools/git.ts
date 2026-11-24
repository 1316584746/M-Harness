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
  readOnly?: boolean;
  scriptRepo?: boolean;
  branchTemplate?: string;
  previewCmd?: string;
  installCmd?: string;
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

/** 这个目录属于哪个登记过的仓库（按路径，忽略大小写和末尾分隔符） */
export function repoByDir(repos: Record<string, RepoConfig>, dir: string): [string, RepoConfig] | undefined {
  const norm = (p: string) => path.resolve(p).replace(/[\\/]+$/, "").toLowerCase();
  const d = norm(dir);
  return Object.entries(repos).find(([, r]) => norm(r.path) === d);
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
      description: "列出已登记的代码仓库（名称、本地路径、远端地址、平台，以及约定的基线 / 提测 / 联调分支 branches.base / test / integration）。创建 feature 分支、提测、联调时按这些分支操作。另有：readOnly=只读仓库（不能改）、scriptRepo=脚本仓（不是业务代码仓）、installCmd=依赖初始化命令。",
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
        const ro = repoByDir(repos, cwd);
        if (ro?.[1].readOnly) throw new Error(`仓库「${ro[0]}」被设为只读，不能用 git_write 改动它（要改请先在 设置 → 代码仓库 里关掉它的「只读」）`);
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

export interface BranchInfo {
  /** 这个目录在 Git 仓库里吗 */
  isRepo: boolean;
  /** 当前分支；游离 HEAD 时为空 */
  current?: string;
  /** 本地分支 */
  local: string[];
  /** 只在远端有的分支（切换时会自动建同名本地分支并跟踪它） */
  remote: string[];
  /** 有没有未提交的改动 */
  dirty?: boolean;
}

// 允许中文等字母（需求名称常是中文），仍然不允许空格和 git 不接受的符号
const BRANCH_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}_./@+-]*$/u;
export const validBranchName = (n: string) => BRANCH_NAME.test(n) && !n.includes("..") && !n.endsWith("/") && !n.endsWith(".lock");

/** 聊天输入框里的分支选择器用：当前分支 + 本地 / 远端分支 */
export async function branchInfo(dir: string): Promise<BranchInfo> {
  if (!fs.existsSync(dir)) return { isRepo: false, local: [], remote: [] };
  const top = await runGit(["rev-parse", "--is-inside-work-tree"], dir, undefined, 15);
  if (top.code !== 0 || top.out.trim() !== "true") return { isRepo: false, local: [], remote: [] };
  const names = (out: string) => out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const [cur, loc, rem, st] = await Promise.all([
    runGit(["branch", "--show-current"], dir, undefined, 15),
    runGit(["branch", "--format=%(refname:short)"], dir, undefined, 20),
    runGit(["branch", "-r", "--format=%(refname:short)"], dir, undefined, 20),
    runGit(["status", "--porcelain=v1"], dir, undefined, 20),
  ]);
  const local = names(loc.out).filter(s => !s.startsWith("("));
  const have = new Set(local);
  const remote = [...new Set(names(rem.out).filter(s => !/(^|\/)HEAD$/.test(s) && s.startsWith("origin/")).map(s => s.slice("origin/".length)))].filter(s => s && !have.has(s)).sort();
  return { isRepo: true, current: cur.out.trim() || undefined, local: local.sort(), remote, dirty: st.code === 0 ? names(st.out).length > 0 : undefined };
}

/** 切换分支：git switch（和命令行一样，改动和目标分支冲突时 git 会拒绝，原样把原因带回来；不强制、不丢改动） */
export async function switchBranch(dir: string, branch: string): Promise<{ ok: boolean; error?: string; current?: string }> {
  if (!validBranchName(branch)) return { ok: false, error: `分支名不合法：${branch}` };
  const r = await runGit(["switch", branch], dir, undefined, 60);
  if (r.code !== 0) return { ok: false, error: (r.err || r.out).trim() || `git 退出码 ${r.code}` };
  const cur = (await runGit(["branch", "--show-current"], dir, undefined, 15)).out.trim();
  return { ok: true, current: cur || undefined };
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

/**
 * 这个仓库「这次需求」的改动行数：一律相对基线分支（不管开发分支提没提交）。
 * - 基线分支：仓库设置里配的 → 远端默认分支 → main / master / develop / dev（本地或 origin 上有的）→ 当前分支的上游
 * - 起点 = 当前代码和基线分支的分叉点（优先 origin/<基线>，没有再用本地）：已提交 + 未提交 + 没 git add 的新文件都算，
 *   所以提交了、甚至直接在基线分支上提交了但还没推送，都不会变成 0
 * - 实在找不到任何基线才退回只看工作区相对 HEAD 的未提交改动
 * 新建但还没 git add 的文件也算（只算文本文件的行数，二进制只算个数）；二进制文件的改动只算文件数。
 */
export async function diffStat(dir: string, configuredBase?: string): Promise<{ added: number; deleted: number; files: number; base?: string }> {
  let from = "HEAD";
  let base: string | undefined;
  const names: string[] = [];
  const cfg = configuredBase?.trim();
  if (cfg) names.push(cfg);
  const detected = await detectBaseBranch(dir, configuredBase).catch(() => undefined);
  if (detected) names.push(detected);
  names.push("main", "master", "develop", "dev");
  for (const name of [...new Set(names)]) {
    if (!validBranchName(name)) continue;
    for (const ref of [`origin/${name}`, name]) {
      const mb = await runGit(["merge-base", "HEAD", ref], dir, undefined, 15);
      if (mb.code === 0 && mb.out.trim()) {
        from = mb.out.trim();
        base = name;
        break;
      }
    }
    if (base) break;
  }
  if (!base) {
    const mb = await runGit(["merge-base", "HEAD", "@{upstream}"], dir, undefined, 15);
    if (mb.code === 0 && mb.out.trim()) from = mb.out.trim();
  }
  const r = await runGit(["diff", from, "--numstat"], dir, undefined, 30);
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
  const un = await runGit(["ls-files", "--others", "--exclude-standard"], dir, undefined, 30);
  for (const f of un.out.split(/\r?\n/).filter(Boolean).slice(0, 200)) {
    files++;
    try {
      const p = path.join(dir, f);
      if (fs.statSync(p).size > 1_000_000) continue;
      const buf = fs.readFileSync(p);
      if (buf.includes(0)) continue; // 二进制
      const s = buf.toString("utf8");
      added += s ? s.split("\n").length - (s.endsWith("\n") ? 1 : 0) : 0;
    } catch {
      /* 读不到就只算个数 */
    }
  }
  return { added, deleted, files, ...(base ? { base } : {}) };
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
  /** 切分支前因为有未提交改动而 stash 暂存了多少个文件 */
  stashed?: number;
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
 * 不会丢东西：工作区有未提交的改动时先 stash 暂存（含新文件）再切，切不过去就放回原处；拉取只做快进（--ff-only），有分叉就报错不合并。
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
    // 有未提交的改动：先 stash 暂存起来（含新文件），再切基线分支。改动不会丢，随时能在原分支上 git stash pop 恢复
    let stashed = false;
    const from = st.branch ?? "（游离）";
    if (st.changed > 0) {
      const sh = await runGit(["stash", "push", "--include-untracked", "-m", `M-Harness 关联仓库前自动暂存（${from}）`], dir, signal, 60);
      stashed = sh.code === 0 && !/No local changes/i.test(sh.out + sh.err);
      if (!stashed) {
        notes.push(`当前分支 ${from} 有 ${st.changed} 个文件未提交，暂存失败（${(sh.err || sh.out).trim().split("\n").slice(-1)[0] || "未知原因"}），没有切换到 ${base}`);
        return { ...out, ok: true, skipped: notes.join("；") };
      }
      out.stashed = st.changed;
      notes.push(`${from} 上有 ${st.changed} 个文件未提交，已用 git stash 暂存；要继续改，回到 ${from} 后执行 git stash pop`);
    }
    const sw = await runGit(["switch", base], dir, signal, 60);
    if (sw.code !== 0) {
      // 切不过去：把刚暂存的改动放回原处，别让用户的东西悬在 stash 里
      if (stashed) await runGit(["stash", "pop"], dir, undefined, 60);
      return { ...out, stashed: undefined, error: `切换到 ${base} 失败：${(sw.err || sw.out).trim().split("\n").slice(-1)[0]}` };
    }
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

// ───────────── 进行开发：基于基线分支新建开发分支 ─────────────

/** 需求名称 → 能放进分支名的一段：空白和 git 不接受 / 难看的符号换成 -，不超过 max 个字 */
export function branchSlug(title: string, max = 40): string {
  const s = title
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\s~^:?*[\]\\@{}<>|"'`!#$%&()=;,/+【】（）：，、；！？“”‘’《》「」]+/g, "-")
    .replace(/\.{2,}/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return Array.from(s).slice(0, max).join("").replace(/[-.]+$/, "");
}

/** 开发分支名：feature-需求名称-日期（如 feature-导出报表-20261123） */
export function featureBranchName(title: string, now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `feature-${branchSlug(title) || "dev"}-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
}

export interface StartBranchResult {
  ok: boolean;
  /** 现在所在的分支 */
  branch?: string;
  /** 基线分支 */
  base?: string;
  /** 这次新建的 */
  created?: boolean;
  /** 已经在这个需求的开发分支上 / 同名分支已存在，直接用 */
  reused?: boolean;
  /** 提醒（没拉到最新、带着未提交改动等） */
  skipped?: string;
  error?: string;
}

/**
 * 「进行开发」开始前：基于基线分支（取远端最新的 origin/<基线>）新建开发分支并切过去。
 * - 已经在这个需求的开发分支上（feature-需求名称-*）就不再新建；同名分支已存在就直接切过去；
 * - 工作区有未提交的改动会原样带到新分支（git 觉得会冲突就拒绝，原因带回来），不会丢；
 * - 联网失败时用本地已有的基线分支，并在 skipped 里说明。
 */
export async function startFeatureBranch(
  dir: string,
  configuredBase: string | undefined,
  title: string,
  opts: { signal?: AbortSignal; env?: Record<string, string>; now?: Date } = {},
): Promise<StartBranchResult> {
  const st = await repoStatus(dir);
  if (!st.exists) return { ok: false, error: "目录不存在" };
  if (st.error) return { ok: false, error: st.error };
  const name = featureBranchName(title, opts.now);
  const prefix = `feature-${branchSlug(title) || "dev"}-`;
  const base = await detectBaseBranch(dir, configuredBase);
  if (st.branch?.startsWith(prefix)) return { ok: true, branch: st.branch, base, reused: true };
  if (!base) return { ok: false, branch: st.branch, error: "没有找到基线分支（可以在设置里给这个仓库填基线分支）" };

  const notes: string[] = [];
  const hasRemote = (await runGit(["remote"], dir, undefined, 15)).out.trim().length > 0;
  let fetched = false;
  if (hasRemote) {
    const f = await runGit(["fetch", "--prune", "origin"], dir, opts.signal, 120, opts.env);
    fetched = f.code === 0;
    if (!fetched) notes.push(`没能拉取远端（${(f.err || f.out).trim().split("\n").slice(-1)[0] || "网络或权限问题"}），用的是本地已有的 ${base}`);
  }
  const exists = async (ref: string) => (await runGit(["rev-parse", "--verify", "--quiet", ref], dir, undefined, 15)).code === 0;
  const start = (await exists(`refs/remotes/origin/${base}`)) ? `origin/${base}` : (await exists(`refs/heads/${base}`)) ? base : undefined;
  if (!start) return { ok: false, base, branch: st.branch, error: `找不到基线分支 ${base}（本地和远端都没有）` };

  if (st.changed > 0) notes.push(`有 ${st.changed} 个文件未提交，已原样带到新分支`);

  // 同名分支已经有了（同一天重复点）：直接切过去
  if (await exists(`refs/heads/${name}`)) {
    const sw = await runGit(["switch", name], dir, opts.signal, 60);
    if (sw.code !== 0) return { ok: false, base, branch: st.branch, error: `切换到已有的 ${name} 失败：${(sw.err || sw.out).trim().split("\n").slice(-1)[0]}` };
    return { ok: true, branch: name, base, reused: true, skipped: notes.length ? notes.join("；") : undefined };
  }
  const sw = await runGit(["switch", "-c", name, "--no-track", start], dir, opts.signal, 60);
  if (sw.code !== 0) return { ok: false, base, branch: st.branch, error: `基于 ${start} 新建 ${name} 失败：${(sw.err || sw.out).trim().split("\n").slice(-1)[0]}` };
  return { ok: true, branch: name, base, created: true, skipped: notes.length ? notes.join("；") : undefined };
}
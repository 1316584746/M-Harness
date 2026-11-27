import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runGit } from "./git";

/** 一次运行里改动的一个文件（界面上「已编辑 N 个文件」卡片的一行） */
export interface FileChange {
  path: string;
  /** A 新增 / M 修改 / D 删除 */
  status: "A" | "M" | "D";
  added: number;
  removed: number;
  binary?: boolean;
}

/** 某一刻整个工作区（含未跟踪文件、不含 .gitignore 忽略的）的内容快照：就是一个 git tree */
export interface WorkSnap {
  root: string;
  tree: string;
}

const MAX_FILES = 40;
const MAX_PATCH = 60_000;
const SNAP_TIMEOUT = 30;

/**
 * 给工作区拍快照：用一份临时的 index 把工作区所有文件（含新建的、未跟踪的）写成 git tree，
 * 不碰仓库真正的 index / 暂存区 / 分支。不是 git 仓库、或任何一步失败返回 undefined（那一轮就不显示改动卡片）。
 */
export async function snapshotWorkTree(cwd: string, signal?: AbortSignal): Promise<WorkSnap | undefined> {
  const top = await runGit(["rev-parse", "--show-toplevel"], cwd, signal, SNAP_TIMEOUT);
  if (top.code !== 0) return undefined;
  const root = path.resolve(top.out.trim());
  const idx = await runGit(["rev-parse", "--git-path", "index"], root, signal, SNAP_TIMEOUT);
  const real = idx.code === 0 ? path.resolve(root, idx.out.trim()) : "";
  const tmp = path.join(os.tmpdir(), `mh-idx-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  try {
    // 复制真实 index 当起点：已有文件的 stat 缓存命中，add -A 只需要看改过的
    if (real && fs.existsSync(real)) fs.copyFileSync(real, tmp);
    const env = { GIT_INDEX_FILE: tmp };
    const add = await runGit(["add", "-A"], root, signal, SNAP_TIMEOUT, env);
    if (add.code !== 0) return undefined;
    const wt = await runGit(["write-tree"], root, signal, SNAP_TIMEOUT, env);
    const tree = wt.out.trim();
    return wt.code === 0 && /^[0-9a-f]{40,64}$/.test(tree) ? { root, tree } : undefined;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

/** 解析 `git diff --numstat -z`：「增\t删\t路径\0」；二进制文件是「-\t-」 */
export function parseNumstat(out: string): Array<{ path: string; added: number; removed: number; binary: boolean }> {
  const res: Array<{ path: string; added: number; removed: number; binary: boolean }> = [];
  for (const rec of out.split("\0")) {
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(rec);
    if (!m) continue;
    const binary = m[1] === "-";
    res.push({ path: m[3]!, added: binary ? 0 : Number(m[1]), removed: binary ? 0 : Number(m[2]), binary });
  }
  return res;
}

/** 解析 `git diff --name-status -z`：「状态\0路径\0」 */
export function parseNameStatus(out: string): Map<string, "A" | "M" | "D"> {
  const map = new Map<string, "A" | "M" | "D">();
  const parts = out.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const s = parts[i]!.trim()[0];
    map.set(parts[i + 1]!, s === "A" ? "A" : s === "D" ? "D" : "M");
  }
  return map;
}

/** 去掉 diff 开头的 diff --git / index / --- / +++ 头，只留从第一个 @@ 开始的内容；过长截断 */
export function trimPatch(raw: string): string {
  const i = raw.search(/^@@/m);
  const body = i >= 0 ? raw.slice(i) : "";
  return body.length > MAX_PATCH ? body.slice(0, MAX_PATCH) + "\n…（改动太长，已截断）\n" : body;
}

/** 两个快照之间改了哪些文件、各自增删多少行、以及每个文件的 diff 正文 */
export async function diffSnapshots(a: WorkSnap, b: WorkSnap, signal?: AbortSignal): Promise<{ files: FileChange[]; patches: Record<string, string> }> {
  if (a.root !== b.root || a.tree === b.tree) return { files: [], patches: {} };
  const [num, ns] = await Promise.all([runGit(["diff", "--numstat", "-z", "--no-renames", a.tree, b.tree], b.root, signal, SNAP_TIMEOUT), runGit(["diff", "--name-status", "-z", "--no-renames", a.tree, b.tree], b.root, signal, SNAP_TIMEOUT)]);
  if (num.code !== 0) return { files: [], patches: {} };
  const status = ns.code === 0 ? parseNameStatus(ns.out) : new Map<string, "A" | "M" | "D">();
  const files: FileChange[] = parseNumstat(num.out).map(f => ({ path: f.path, status: status.get(f.path) ?? "M", added: f.added, removed: f.removed, ...(f.binary ? { binary: true } : {}) }));
  const patches: Record<string, string> = {};
  for (const f of files.slice(0, MAX_FILES)) {
    if (f.binary) continue;
    const r = await runGit(["diff", "--no-renames", "-U3", a.tree, b.tree, "--", f.path], b.root, signal, SNAP_TIMEOUT);
    if (r.code === 0) patches[f.path] = trimPatch(r.out);
  }
  return { files, patches };
}

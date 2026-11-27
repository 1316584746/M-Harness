import fs from "node:fs";
import path from "node:path";

/**
 * 「只看某几次运行」的插件后台：
 * 「上下文洞察」这类读 trace 的插件分不清是哪段对话的运行（它只会按时间和提供者把续接的运行合并），
 * 所以要百分百只看当前对话，就给它一个只有这段对话的运行文件的临时「家目录」：
 *   <root>/<key>/harness.config.json   只留 providers / limits（去掉密钥）
 *   <root>/<key>/.traces/<运行 id>.jsonl   只有这段对话的运行（从真正的 trace 目录复制）
 *   <root>/<key>/plugin-data/<插件 id>/   插件自己的设置（和正常打开的插件互不影响）
 * 插件后台用 HARNESS_HOME 指向它，看到的就只有这些。
 */

export interface PluginScope {
  /** 对话标识（临时目录名） */
  key: string;
  /** 这段对话的运行 id（= trace 文件名，不含 .jsonl） */
  runs: string[];
}

export const KEY_RE = /^[A-Za-z0-9._-]{1,80}$/;
const RUN_RE = /^[A-Za-z0-9._-]{1,120}$/;
export const MAX_RUNS = 300;

/** 校验界面传来的范围：不合法返回 undefined */
export function cleanScope(raw: unknown): PluginScope | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as { key?: unknown; runs?: unknown };
  if (typeof s.key !== "string" || !KEY_RE.test(s.key) || s.key.includes("..")) return undefined;
  if (!Array.isArray(s.runs)) return undefined;
  const runs = [...new Set(s.runs.filter((r): r is string => typeof r === "string" && RUN_RE.test(r) && !r.includes("..")))].slice(0, MAX_RUNS);
  return { key: s.key, runs };
}

// 注意不能带上 contextTokens / maxTokens 这类普通数字字段（插件要用 limits.contextTokens 算占比）
const SECRET_KEY = /(api_?key|secret|authorization|password|passwd|cookie|bearer|access_?token|auth_?token|refresh_?token)|^(key|token|auth)$/i;

/** 复制配置：只留插件算价格 / 上下文上限要用的 providers 和 limits，凡是像密钥的字段一律去掉 */
export function sanitizeConfig(cfg: unknown): Record<string, unknown> {
  const strip = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(strip);
    if (v && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) if (!SECRET_KEY.test(k)) o[k] = strip(x);
      return o;
    }
    return v;
  };
  const c = (cfg && typeof cfg === "object" ? cfg : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { traceDir: ".traces" };
  if (c.providers !== undefined) out.providers = strip(c.providers);
  if (c.limits !== undefined) out.limits = strip(c.limits);
  return out;
}

/** 把这段对话的运行文件同步进临时家目录（多了的删掉、变了的重新复制），返回家目录路径 */
export function prepareScopeHome(root: string, scope: PluginScope, srcTraceDir: string, cfg: unknown, pluginId: string): string {
  const home = path.join(root, scope.key);
  const traces = path.join(home, ".traces");
  fs.mkdirSync(traces, { recursive: true });
  fs.mkdirSync(path.join(home, "plugin-data", pluginId), { recursive: true });
  fs.writeFileSync(path.join(home, "harness.config.json"), JSON.stringify(sanitizeConfig(cfg)));
  const want = new Set<string>();
  for (const run of scope.runs) {
    const src = path.join(srcTraceDir, `${run}.jsonl`);
    const dst = path.join(traces, `${run}.jsonl`);
    try {
      const st = fs.statSync(src);
      if (!st.isFile()) continue;
      want.add(`${run}.jsonl`);
      let same = false;
      try {
        const d = fs.statSync(dst);
        same = d.size === st.size && d.mtimeMs >= st.mtimeMs;
      } catch {
        /* 还没复制过 */
      }
      if (!same) {
        fs.copyFileSync(src, dst);
        fs.utimesSync(dst, st.atime, st.mtime); // 保留修改时间，插件按它判断活跃度
      }
    } catch {
      /* 这次运行的文件不在了：跳过 */
    }
  }
  for (const f of fs.readdirSync(traces)) if (f.endsWith(".jsonl") && !want.has(f)) fs.rmSync(path.join(traces, f), { force: true });
  return home;
}

/** 清掉上次没来得及删的临时目录（<base>/<插件 id>/<范围>-<随机>，修改时间早于 maxAgeMs 的） */
export function sweepScopeRoot(base: string, maxAgeMs: number, now = Date.now()): void {
  let plugins: string[] = [];
  try {
    plugins = fs.readdirSync(base);
  } catch {
    return;
  }
  for (const p of plugins) {
    const dir = path.join(base, p);
    let subs: string[] = [];
    try {
      subs = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const s of subs) {
      const d = path.join(dir, s);
      try {
        if (now - fs.statSync(d).mtimeMs > maxAgeMs) fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* 删不掉就留着，下次再说 */
      }
    }
  }
}

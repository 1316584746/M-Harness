import fs from "node:fs";
import path from "node:path";

/** 每次运行改动的 diff 正文存在数据目录的 run-changes 下（一次运行一个文件）；界面只存摘要，鼠标放上去才来取正文 */
const KEEP_MS = 30 * 24 * 3600_000;
const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

export function saveRunChanges(dir: string, runId: string, patches: Record<string, string>): void {
  if (!runId || !Object.keys(patches).length) return;
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${safe(runId)}.json`), JSON.stringify(patches));
  // 顺手清掉 30 天前的
  const now = Date.now();
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    try {
      if (now - fs.statSync(p).mtimeMs > KEEP_MS) fs.rmSync(p, { force: true });
    } catch {
      /* 别的进程刚删了 */
    }
  }
}

/** 取某次运行里某个文件的 diff 正文；没有（过期 / 太长没存）返回空串 */
export function readRunPatch(dir: string, runId: string, file: string): string {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, `${safe(runId)}.json`), "utf8")) as Record<string, unknown>;
    const v = j[file];
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

import fs from "node:fs";
import path from "node:path";
import { defectKey, type Defect, type DefectsResult } from "../shared/defects";

interface Persist {
  /** 已经通知过的（避免重复弹通知） */
  known: string[];
  /** 已经在列表里看到过的 */
  seen: string[];
  /** 第一次拿到数据时只建基线，不把已有的当「新来的」 */
  init: boolean;
}

/**
 * 定时拉「指派给我的缺陷」：缓存最近一次结果、发现新缺陷时通知、记住哪些我已经看过。
 * 没有接项目管理工具时 fetcher 返回 enabled:false，什么都不做。
 */
export class DefectWatcher {
  private st: Persist = { known: [], seen: [], init: false };
  private last?: DefectsResult;
  private timer?: ReturnType<typeof setInterval>;
  private inflight?: Promise<DefectsResult>;

  constructor(
    private file: string,
    private fetcher: () => Promise<DefectsResult>,
    private changed: (r: DefectsResult) => void = () => {},
    private onNew: (items: Defect[]) => void = () => {},
  ) {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8").replace(/^\uFEFF/, ""));
      if (j && Array.isArray(j.known) && Array.isArray(j.seen)) this.st = { known: j.known.map(String), seen: j.seen.map(String), init: j.init === true };
    } catch {
      /* 第一次运行 */
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.st), "utf8");
      fs.renameSync(tmp, this.file);
    } catch {
      /* 写不了盘不影响使用 */
    }
  }

  /** 带上「新」标记的最近结果 */
  get(): DefectsResult | undefined {
    if (!this.last) return undefined;
    const seen = new Set(this.st.seen);
    return { ...this.last, items: this.last.items.map(d => ({ ...d, isNew: !seen.has(defectKey(d)) || undefined })) };
  }

  find(key: string): Defect | undefined {
    return this.last?.items.find(d => defectKey(d) === key);
  }

  refresh(): Promise<DefectsResult> {
    return (this.inflight ??= this.doRefresh().finally(() => (this.inflight = undefined)));
  }

  private async doRefresh(): Promise<DefectsResult> {
    let r: DefectsResult;
    try {
      r = await this.fetcher();
    } catch (e) {
      r = { enabled: true, ok: false, items: [], error: e instanceof Error ? e.message : String(e), at: Date.now() };
    }
    if (r.enabled && !r.ok && this.last?.ok && this.last.source === r.source) r = { ...r, items: this.last.items }; // 取数失败时保留上次的列表
    if (r.enabled && r.ok) {
      const keys = r.items.map(defectKey);
      const known = new Set(this.st.known);
      const fresh = r.items.filter(d => !known.has(defectKey(d)));
      if (!this.st.init) {
        this.st.seen = keys; // 第一次：已有的不算新
        this.st.init = true;
      } else if (fresh.length) {
        try {
          this.onNew(fresh);
        } catch {
          /* 通知失败不影响列表 */
        }
      }
      // 只在完整取到时清理，部分空间失败时别把没取到的当成消失了
      this.st.known = r.warnings?.length ? [...new Set([...this.st.known, ...keys])] : keys;
      if (!r.warnings?.length) this.st.seen = this.st.seen.filter(k => keys.includes(k));
      this.save();
    }
    this.last = r;
    const out = this.get()!;
    this.changed(out);
    return out;
  }

  /** 我打开了列表：当前这些都算看过了 */
  markSeen(): DefectsResult | undefined {
    if (!this.last) return undefined;
    this.st.seen = [...new Set([...this.st.seen, ...this.last.items.map(defectKey)])];
    this.save();
    const out = this.get()!;
    this.changed(out);
    return out;
  }

  start(everyMs: number, firstDelayMs = 2000): void {
    this.stop();
    setTimeout(() => void this.refresh(), firstDelayMs).unref?.();
    this.timer = setInterval(() => void this.refresh(), everyMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}

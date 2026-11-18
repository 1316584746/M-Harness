import fs from "node:fs";
import path from "node:path";
import { nextRun, validateAutomation, type AutoRun, type Automation } from "../shared/automation";

/** 一次运行的结果：由外面（backend）真正去调 Agent */
export interface RunResult {
  status: "done" | "error" | "aborted";
  text: string;
  error?: string;
  traceFile?: string;
}
export type Runner = (a: Automation, signal: AbortSignal) => Promise<RunResult>;

const MAX_RUNS = 30;
const MAX_TEXT = 20_000;
let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(++seq).toString(36)}`;

export type SaveInput = Partial<Automation> & Pick<Automation, "name" | "prompt" | "schedule">;

/**
 * 自动化任务引擎：存盘、到点触发、串行执行、记录每次运行的结果。
 * 应用没开的时候不会运行，也不会补跑（重新打开后只算下一次）。
 */
export class AutomationEngine {
  private items: Automation[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private chain: Promise<void> = Promise.resolve();
  private active = new Map<string, AbortController>();
  private queued = new Set<string>();

  constructor(
    private file: string,
    private runner: Runner,
    private notify: () => void = () => {},
    private now: () => number = Date.now,
  ) {
    this.load();
  }

  // ───── 存取 ─────

  private load(): void {
    try {
      const arr = JSON.parse(fs.readFileSync(this.file, "utf8").replace(/^\uFEFF/, ""));
      this.items = Array.isArray(arr) ? arr.filter(x => x && typeof x.id === "string" && x.schedule) : [];
    } catch {
      this.items = [];
    }
    const t = this.now();
    for (const a of this.items) {
      a.runs ??= [];
      // 上次退出时还在跑的，算中断
      for (const r of a.runs) if (r.status === "running") Object.assign(r, { status: "aborted", finished: t, text: r.text || "（应用关闭，运行已中断）" });
      // 关着应用时错过的不补跑，只算下一次
      if (a.enabled && !a.ended && (a.nextRun === undefined || a.nextRun <= t)) this.arm(a, t);
    }
    this.save();
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2), "utf8");
      fs.renameSync(tmp, this.file);
    } catch {
      // 写不了盘（权限 / 满了）也不能让定时器崩
    }
  }

  /** 算下一次运行；没有下一次或过了结束时间就标记已结束 */
  private arm(a: Automation, after: number): void {
    const n = nextRun(a.schedule, after);
    if (n === undefined || (a.endAt !== undefined && n > a.endAt)) {
      a.ended = true;
      a.nextRun = undefined;
    } else a.nextRun = n;
  }

  list(): Automation[] {
    return this.items.map(a => ({ ...a, runs: a.runs.map(r => ({ ...r })) })).sort((x, y) => y.updated - x.updated);
  }

  get(id: string): Automation | undefined {
    return this.items.find(a => a.id === id);
  }

  /** 新建或修改（带 id 就是修改）。修改后重新算下一次运行，已结束的会重新开启 */
  saveItem(input: SaveInput): { ok: boolean; id?: string; error?: string } {
    const err = validateAutomation(input);
    if (err) return { ok: false, error: err };
    const t = this.now();
    const old = input.id ? this.get(input.id) : undefined;
    if (input.id && !old) return { ok: false, error: "这个任务已经不存在了" };
    const a: Automation = {
      id: old?.id ?? uid("au"),
      name: input.name.trim().slice(0, 80),
      prompt: input.prompt.trim(),
      provider: input.provider || undefined,
      model: input.model || undefined,
      workspace: input.workspace?.trim() || undefined,
      access: input.access === "ask" ? "ask" : "read",
      schedule: input.schedule,
      enabled: input.enabled ?? old?.enabled ?? true,
      endAt: input.endAt,
      created: old?.created ?? t,
      updated: t,
      runs: old?.runs ?? [],
    };
    if (a.enabled) this.arm(a, t);
    else a.nextRun = undefined;
    if (old) this.items[this.items.indexOf(old)] = a;
    else this.items.push(a);
    this.save();
    this.notify();
    return { ok: true, id: a.id };
  }

  setEnabled(id: string, on: boolean): { ok: boolean; error?: string } {
    const a = this.get(id);
    if (!a) return { ok: false, error: "这个任务已经不存在了" };
    a.enabled = on;
    if (on) {
      a.ended = false;
      this.arm(a, this.now());
      if (a.ended) return this.finish(a, "这个任务已经没有下一次运行时间了（一次性任务已过期或超过结束时间），请先修改运行计划");
    } else a.nextRun = undefined;
    a.updated = this.now();
    this.save();
    this.notify();
    return { ok: true };
  }

  private finish(a: Automation, error: string): { ok: boolean; error: string } {
    a.enabled = false;
    a.ended = false;
    a.nextRun = undefined;
    this.save();
    this.notify();
    return { ok: false, error };
  }

  remove(id: string): boolean {
    this.active.get(id)?.abort();
    const n = this.items.length;
    this.items = this.items.filter(a => a.id !== id);
    if (this.items.length === n) return false;
    this.save();
    this.notify();
    return true;
  }

  // ───── 运行 ─────

  start(tickMs = 15_000): void {
    this.stop();
    this.timer = setInterval(() => this.tick(), tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** 到点的任务排进队列（一个一个跑，不并发） */
  tick(): void {
    const t = this.now();
    for (const a of this.items) {
      if (!a.enabled || a.ended) continue;
      if (a.endAt !== undefined && t > a.endAt) {
        a.ended = true;
        a.nextRun = undefined;
        this.save();
        this.notify();
        continue;
      }
      if (a.nextRun !== undefined && a.nextRun <= t) {
        // 先把下一次算好，慢任务不会重复触发
        if (a.schedule.kind === "once") a.nextRun = undefined; // 一次性的：跑完再标记已结束
        else this.arm(a, Math.max(t, a.nextRun));
        this.save();
        void this.enqueue(a.id, false);
      }
    }
  }

  /** 立即运行一次（不影响原来的计划） */
  runNow(id: string): { ok: boolean; error?: string } {
    if (!this.get(id)) return { ok: false, error: "这个任务已经不存在了" };
    if (this.active.has(id) || this.queued.has(id)) return { ok: false, error: "这个任务正在运行" };
    void this.enqueue(id, true);
    return { ok: true };
  }

  abort(id: string): void {
    this.active.get(id)?.abort();
  }

  isRunning(id: string): boolean {
    return this.active.has(id) || this.queued.has(id);
  }

  /** 等当前排队的都跑完（测试用） */
  idle(): Promise<void> {
    return this.chain;
  }

  private enqueue(id: string, manual: boolean): Promise<void> {
    if (this.queued.has(id) || this.active.has(id)) return this.chain;
    this.queued.add(id);
    this.notify();
    this.chain = this.chain.then(() => this.execute(id, manual)).catch(() => {});
    return this.chain;
  }

  private async execute(id: string, manual: boolean): Promise<void> {
    this.queued.delete(id);
    const a = this.get(id);
    if (!a) return this.notify();
    const run: AutoRun = { id: uid("ar"), at: this.now(), status: "running", text: "", manual: manual || undefined };
    a.runs.unshift(run);
    a.runs.length = Math.min(a.runs.length, MAX_RUNS);
    const ac = new AbortController();
    this.active.set(id, ac);
    this.save();
    this.notify();
    let r: RunResult;
    try {
      r = await this.runner({ ...a, runs: [] }, ac.signal);
    } catch (e) {
      r = { status: "error", text: "", error: e instanceof Error ? e.message : String(e) };
    }
    this.active.delete(id);
    run.finished = this.now();
    run.status = r.status;
    run.text = (r.status === "done" ? r.text : r.error || r.text || "运行失败").slice(0, MAX_TEXT);
    run.error = r.error;
    run.traceFile = r.traceFile;
    // 一次性任务跑完就结束（手动「立即运行」不算）
    if (!manual && a.schedule.kind === "once" && this.get(id)) {
      a.ended = true;
      a.nextRun = undefined;
    }
    this.save();
    this.notify();
  }
}

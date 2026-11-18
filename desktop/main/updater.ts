import type { UpdateStateDTO } from "../shared/api";

/**
 * 应用更新：用 GitHub Releases 判断有没有新版本，有就提示用户。
 * - 检查：GET /repos/{owner}/{repo}/releases/latest，对比 tag 与当前版本（各平台通用）。
 * - 下载安装：Windows 安装版用 electron-updater（读 Release 里的 latest.yml，校验后静默安装并重启）；
 *   其它情况（开发模式、macOS 未签名、没有 latest.yml）退化为打开 Release 页面让用户手动下载。
 * 不依赖 Electron，所有外部能力从构造参数注入，便于测试。
 */

/** 发布到 GitHub 之后把 "owner/repo" 填在这里，用户就不用在设置里配置了；设置里填写的优先 */
export const DEFAULT_UPDATE_REPO = "";

export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  setFeedURL(o: { provider: "github"; owner: string; repo: string }): void;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(silent?: boolean, forceRunAfter?: boolean): void;
  on(event: string, cb: (...a: any[]) => void): unknown;
  removeAllListeners?(event?: string): unknown;
}

export interface UpdaterDeps {
  version: string;
  /** 当前生效的仓库设置（owner/repo 或 GitHub 地址），每次检查时读取 */
  repo(): string;
  send(state: UpdateStateDTO): void;
  openExternal(url: string): void;
  /** 能否应用内下载并安装（打包后的 Windows 安装版） */
  canAutoInstall: boolean;
  /** 懒加载 electron-updater；测试里换成假的 */
  loadAutoUpdater?: () => Promise<AutoUpdaterLike>;
  /** 测试用：替换 GitHub API 地址 */
  apiBase?: string;
}

/** 接受 owner/repo、https://github.com/owner/repo(.git)、git@github.com:owner/repo.git */
export function parseRepo(input: string): { owner: string; repo: string } | null {
  const s = input.trim().replace(/\.git$/i, "").replace(/\/+$/, "");
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(s);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** a > b 返回正数。支持 v1.2.3、1.2、预发布后缀（1.2.3-beta 低于 1.2.3） */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const [core, pre] = v.trim().replace(/^v/i, "").split("+")[0].split(/-(.*)/s);
    return { nums: core.split(".").map(x => parseInt(x, 10) || 0), pre: pre ?? "" };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < Math.max(x.nums.length, y.nums.length); i++) {
    const d = (x.nums[i] ?? 0) - (y.nums[i] ?? 0);
    if (d) return d;
  }
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre < y.pre ? -1 : 1;
}

export class Updater {
  private st: UpdateStateDTO;
  private au?: AutoUpdaterLike;
  private timer?: NodeJS.Timeout;
  private checking?: Promise<UpdateStateDTO>;

  constructor(private d: UpdaterDeps) {
    this.st = { state: "idle", current: d.version, canAutoInstall: d.canAutoInstall };
  }

  get state(): UpdateStateDTO {
    return { ...this.st, repo: this.repoText() || undefined };
  }

  private repoText(): string {
    const r = parseRepo(this.d.repo() || DEFAULT_UPDATE_REPO);
    return r ? `${r.owner}/${r.repo}` : "";
  }

  private set(p: Partial<UpdateStateDTO>): UpdateStateDTO {
    this.st = { ...this.st, ...p };
    this.d.send(this.state);
    return this.state;
  }

  /** 启动后延迟检查一次，之后每隔 intervalMs 再查（enabled() 为 false 时跳过） */
  start(enabled: () => boolean, delayMs = 8000, intervalMs = 6 * 3600_000): void {
    const tick = () => void (enabled() && this.check({ silent: true }));
    setTimeout(tick, delayMs).unref?.();
    this.timer = setInterval(tick, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** silent：自动检查——没配仓库、没网、被限流都不打扰用户，保持原状态 */
  check(opts: { silent?: boolean } = {}): Promise<UpdateStateDTO> {
    if (this.st.state === "downloading" || this.st.state === "downloaded") return Promise.resolve(this.state);
    this.checking ??= this.doCheck(!!opts.silent).finally(() => (this.checking = undefined));
    return this.checking;
  }

  private async doCheck(silent: boolean): Promise<UpdateStateDTO> {
    const repo = parseRepo(this.d.repo() || DEFAULT_UPDATE_REPO);
    if (!repo) return silent ? this.state : this.set({ state: "unconfigured", error: undefined });
    const prev = this.st.state;
    if (!silent) this.set({ state: "checking", error: undefined });
    try {
      const base = (this.d.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 15_000);
      let res: Response;
      try {
        res = await fetch(`${base}/repos/${repo.owner}/${repo.repo}/releases/latest`, {
          headers: { accept: "application/vnd.github+json", "user-agent": "M-Harness-Updater", "x-github-api-version": "2022-11-28" },
          signal: ctl.signal,
        });
      } finally {
        clearTimeout(t);
      }
      if (res.status === 404) throw new Error("仓库不存在，或还没有发布过 Release");
      if (res.status === 403 || res.status === 429) throw new Error("GitHub 接口访问过于频繁，请稍后再试");
      if (!res.ok) throw new Error(`GitHub 返回 HTTP ${res.status}`);
      const j: any = await res.json();
      const tag = String(j.tag_name ?? "");
      if (!tag) throw new Error("Release 没有版本号（tag）");
      const latest = tag.replace(/^v/i, "");
      const common = { checkedAt: Date.now(), error: undefined, percent: undefined };
      if (compareVersions(latest, this.d.version) > 0) {
        return this.set({ ...common, state: "available", latest, notes: String(j.body ?? "").slice(0, 6000), url: String(j.html_url ?? `https://github.com/${repo.owner}/${repo.repo}/releases`) });
      }
      return this.set({ ...common, state: "none", latest, notes: undefined, url: undefined });
    } catch (e: any) {
      const msg = e?.name === "AbortError" ? "连接 GitHub 超时" : (e?.cause?.code ? `网络错误（${e.cause.code}）` : (e?.message ?? String(e)));
      if (silent) {
        this.st = { ...this.st, state: prev };
        return this.state;
      }
      return this.set({ state: "error", error: msg });
    }
  }

  /** 应用内下载；做不到（或失败）就打开 Release 页面 */
  async download(): Promise<UpdateStateDTO> {
    const url = this.st.url;
    if (this.st.state !== "available" && this.st.state !== "error") return this.state;
    const repo = parseRepo(this.d.repo() || DEFAULT_UPDATE_REPO);
    if (!this.d.canAutoInstall || !repo || !this.d.loadAutoUpdater) {
      if (url) this.d.openExternal(url);
      return this.state;
    }
    try {
      this.set({ state: "downloading", percent: 0, error: undefined });
      const au = (this.au ??= await this.d.loadAutoUpdater());
      au.autoDownload = false;
      au.autoInstallOnAppQuit = false;
      au.setFeedURL({ provider: "github", owner: repo.owner, repo: repo.repo });
      au.removeAllListeners?.("download-progress");
      au.removeAllListeners?.("update-downloaded");
      au.on("download-progress", (p: any) => this.set({ state: "downloading", percent: Math.round(p?.percent ?? 0) }));
      au.on("update-downloaded", () => this.set({ state: "downloaded", percent: 100 }));
      await au.checkForUpdates();
      await au.downloadUpdate();
      if ((this.st.state as string) === "downloading") this.set({ state: "downloaded", percent: 100 });
    } catch (e: any) {
      // 例如 Release 里没有 latest.yml / 安装包：让用户去页面手动下载
      this.set({ state: "error", error: `自动下载失败：${e?.message ?? e}`, percent: undefined });
      if (url) this.d.openExternal(url);
    }
    return this.state;
  }

  /** 退出并安装已下载的更新 */
  install(): void {
    if (this.st.state === "downloaded") this.au?.quitAndInstall(false, true);
  }
}

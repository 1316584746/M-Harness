import type { UpdateStateDTO } from "../shared/api";

/**
 * 应用更新：用 GitHub Releases 判断有没有新版本，有就提示用户。
 * - 检查：GET /repos/{owner}/{repo}/releases/latest，对比 tag 与当前版本（各平台通用）。
 * - 下载安装：Windows 安装版用 electron-updater（读 Release 里的 latest.yml，校验后静默安装并重启）；
 *   其它情况（开发模式、macOS 未签名、没有 latest.yml）退化为打开 Release 页面让用户手动下载。
 * 不依赖 Electron，所有外部能力从构造参数注入，便于测试。
 */

/** 发布到 GitHub 之后把 "owner/repo" 填在这里，用户就不用在设置里配置了；设置里填写的优先 */
export const DEFAULT_UPDATE_REPO = "1316584746/M-Harness";

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
  /** 测试用：替换 GitHub 网页地址（用来读 /releases/latest 的跳转） */
  webBase?: string;
  /** 设置里没填时用的默认仓库；缺省为 DEFAULT_UPDATE_REPO（测试可传 "" 模拟未配置） */
  defaultRepo?: string;
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
    const r = parseRepo(this.d.repo() || (this.d.defaultRepo ?? DEFAULT_UPDATE_REPO));
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
    const repo = parseRepo(this.d.repo() || (this.d.defaultRepo ?? DEFAULT_UPDATE_REPO));
    if (!repo) return silent ? this.state : this.set({ state: "unconfigured", error: undefined });
    const prev = this.st.state;
    if (!silent) this.set({ state: "checking", error: undefined });
    try {
      // 版本号走网页的 /releases/latest 跳转（不占 GitHub API 的额度）。
      // API 对没登录的请求每小时每个 IP 只给 60 次，公司网络里很多人共用一个出口 IP，很容易被用光，所以 API 只用来取更新说明，取不到也不影响。
      const tag = await this.latestTag(repo);
      const latest = tag.replace(/^v/i, "");
      const common = { checkedAt: Date.now(), error: undefined, percent: undefined };
      if (compareVersions(latest, this.d.version) > 0) {
        const j = await this.releaseNotes(repo, tag);
        return this.set({ ...common, state: "available", latest, notes: String(j?.body ?? "").slice(0, 6000), url: String(j?.html_url ?? `https://github.com/${repo.owner}/${repo.repo}/releases/tag/${encodeURIComponent(tag)}`) });
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

  private async timedFetch(url: string, init: RequestInit, ms: number): Promise<Response> {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms);
    try {
      return await fetch(url, { ...init, signal: ctl.signal, headers: { "user-agent": "M-Harness-Updater", ...(init.headers as Record<string, string> | undefined) } });
    } finally {
      clearTimeout(t);
    }
  }

  /** 最新 Release 的 tag：请求网页 /releases/latest，读它跳转到的 /releases/tag/<tag> */
  private async latestTag(repo: { owner: string; repo: string }): Promise<string> {
    const web = (this.d.webBase ?? "https://github.com").replace(/\/+$/, "");
    const res = await this.timedFetch(`${web}/${repo.owner}/${repo.repo}/releases/latest`, { redirect: "manual" }, 15_000);
    if (res.status === 404) throw new Error("仓库不存在，或还没有发布过 Release");
    if (res.status === 403 || res.status === 429) throw new Error("GitHub 访问过于频繁，请稍后再试");
    const loc = res.headers.get("location") ?? "";
    const m = /\/releases\/tag\/([^/?#]+)/.exec(loc) ?? (res.status === 200 ? /\/releases\/tag\/([^/?#]+)/.exec(res.url) : null);
    if (m) return decodeURIComponent(m[1]);
    if (res.status >= 300 && res.status < 400) throw new Error("仓库还没有发布过 Release");
    throw new Error(`GitHub 返回 HTTP ${res.status}`);
  }

  /** 更新说明：走 API，被限流 / 没网都当没有，不影响「有新版本」的结论 */
  private async releaseNotes(repo: { owner: string; repo: string }, tag: string): Promise<{ body?: string; html_url?: string } | undefined> {
    try {
      const base = (this.d.apiBase ?? "https://api.github.com").replace(/\/+$/, "");
      const res = await this.timedFetch(`${base}/repos/${repo.owner}/${repo.repo}/releases/tags/${encodeURIComponent(tag)}`, { headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" } }, 8_000);
      return res.ok ? ((await res.json()) as any) : undefined;
    } catch {
      return undefined;
    }
  }

  /** 应用内下载；做不到（或失败）就打开 Release 页面 */
  async download(): Promise<UpdateStateDTO> {
    const url = this.st.url;
    if (this.st.state !== "available" && this.st.state !== "error") return this.state;
    const repo = parseRepo(this.d.repo() || (this.d.defaultRepo ?? DEFAULT_UPDATE_REPO));
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

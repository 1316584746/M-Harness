import fs from "node:fs";
import path from "node:path";
import { DBX_CATALOG_URL, DBX_SOURCE, OFFICIAL_REPO_NAME, OFFICIAL_REPO_URL, type PluginRepo } from "../shared/plugins";
import { parseGithubUrl } from "./repo-import";

/**
 * 插件仓库列表：M-Harness 官方插件仓库（1316584746/M-Market）和 DBX 插件中心是第一次使用时预置的两个仓库，
 * 之后和用户自己添加的没有区别：都能停用、能删，删了不会再回来，想要再从「常用仓库」里加。
 * 仓库的名字当「来源名」用，插件卡片的 key 是 `${来源}:${插件id}`。
 * rev：预置仓库是哪一版加进来的。老用户的文件里记着自己已经预置到第几版，新加的预置仓库只补一次。
 */
export type SeedRepo = PluginRepo & { rev?: number };

/** 预置的仓库（官方的排在最前；rev 缺省为 1） */
export const seedRepos = (dbxUrl: string = DBX_CATALOG_URL, officialUrl: string | null = OFFICIAL_REPO_URL): SeedRepo[] => [
  ...(officialUrl ? [{ id: "m-market", name: OFFICIAL_REPO_NAME, url: officialUrl, enabled: true, rev: 2 }] : []),
  { id: "dbx", name: DBX_SOURCE, url: dbxUrl, enabled: true },
];

export const SEED_REPOS: SeedRepo[] = seedRepos();

const MAX_REPOS = 20;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function checkRepoUrl(raw: string): string {
  // owner/repo 简写 → GitHub 仓库地址
  const gh = parseGithubUrl(raw);
  if (gh && !/^https?:/i.test(raw.trim())) raw = `https://github.com/${gh.owner}/${gh.repo}`;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("地址不合法：请填 GitHub 仓库链接（或 owner/repo），或者目录文件的直链");
  }
  const local = u.protocol === "http:" && /^(127\.0\.0\.1|localhost)$/.test(u.hostname);
  if (u.protocol !== "https:" && !local) throw new Error("地址只支持 https");
  if (u.username || u.password) throw new Error("地址里不要带账号密码");
  return u.toString();
}

export class PluginRepos {
  constructor(
    private file: string,
    /** 第一次使用时预置的第三方仓库；测试时把它指到本地服务 */
    private seed: SeedRepo[] = SEED_REPOS,
  ) {}

  private clean(j: any): PluginRepo[] {
    if (!Array.isArray(j?.repos)) return [];
    return j.repos
      .filter((r: any) => r && typeof r.id === "string" && ID_RE.test(r.id) && typeof r.url === "string" && !r.url.startsWith("builtin:"))
      .map((r: any) => ({ id: r.id, name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 40) : r.id, url: r.url, enabled: r.enabled !== false }));
  }

  private read(): PluginRepo[] {
    let j: any = null;
    try {
      j = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch {
      /* 没有文件（第一次用）或文件坏了 */
    }
    const plain = (s: SeedRepo): PluginRepo => ({ id: s.id, name: s.name, url: s.url, enabled: s.enabled });
    if (!j) return this.seed.map(plain);
    const repos = this.clean(j);
    const missing = (s: SeedRepo) => !repos.some(x => x.id === s.id || x.url === s.url);
    if (j.seeded) {
      // 以前预置到第几版：之后新增的预置仓库补一次（补进去以后用户停用、删除都照常，因为保存时会记下新版本号）
      const rev = Number(j.seedRev) || 1;
      return [...this.seed.filter(s => (s.rev ?? 1) > rev && missing(s)).map(plain), ...repos];
    }
    // 最早版本的文件：当时 DBX 仓库是固定的，这里补成普通一行，保留它的启用状态
    return [...this.seed.filter(missing).map(s => ({ ...plain(s), enabled: (s.rev ?? 1) > 1 ? true : j.officialEnabled !== false })), ...repos];
  }

  private write(repos: PluginRepo[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ seeded: true, seedRev: Math.max(1, ...this.seed.map(s => s.rev ?? 1)), repos }, null, 2));
  }

  list(): PluginRepo[] {
    return this.read();
  }

  /** 已启用的仓库 */
  extra(): PluginRepo[] {
    return this.read().filter(r => r.enabled);
  }

  /** 用户没填 ID 时自动生成：优先用名称里的英文数字，其次用 GitHub 仓库名或域名，保证不和已有的重复 */
  private autoId(name: string, url: string, taken: Set<string>): string {
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28);
    let host = "";
    try {
      host = new URL(url.trim()).hostname.replace(/^www\./, "");
    } catch {
      /* 地址不合法，后面会报错 */
    }
    const gh = parseGithubUrl(url);
    const base = slug(name) || (gh ? slug(gh.repo) : "") || slug(host) || "repo";
    let id = base;
    for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
    return id;
  }

  add(input: { id?: string; name?: string; url: string }): PluginRepo {
    const all = this.read();
    const given = String(input.id ?? "").trim().toLowerCase();
    const id = given || this.autoId(String(input.name ?? ""), String(input.url ?? ""), new Set(all.map(r => r.id)));
    if (!ID_RE.test(id)) throw new Error("仓库 ID 只能用小写字母、数字、- 和 _，最长 32 位");
    if (all.some(r => r.id === id)) throw new Error(`仓库 ID「${id}」已经存在`);
    if (all.length >= MAX_REPOS) throw new Error(`最多添加 ${MAX_REPOS} 个仓库`);
    const url = checkRepoUrl(String(input.url ?? ""));
    if (all.some(r => r.url === url)) throw new Error("这个地址已经添加过了");
    const name = String(input.name ?? "").trim().slice(0, 40) || id;
    if (all.some(r => r.name === name)) throw new Error(`仓库名称「${name}」已经被用了，换一个`);
    const repo: PluginRepo = { id, name, url, enabled: true };
    this.write([...all, repo]);
    return repo;
  }

  remove(id: string): boolean {
    const all = this.read();
    if (!all.some(r => r.id === id)) return false;
    this.write(all.filter(r => r.id !== id));
    return true;
  }

  setEnabled(id: string, enabled: boolean): void {
    const all = this.read();
    if (!all.some(r => r.id === id)) throw new Error("没有这个仓库");
    this.write(all.map(r => (r.id === id ? { ...r, enabled } : r)));
  }
}

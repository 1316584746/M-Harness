import fs from "node:fs";
import path from "node:path";
import { DBX_CATALOG_URL, DBX_SOURCE, type PluginRepo } from "../shared/plugins";

/**
 * 插件仓库列表：官方仓库固定在最前面，不能删，也不能关；第三方仓库由用户自己添加，存在本软件的数据目录里（不进代码仓库）。
 * 仓库的 id 当「来源名」用，插件卡片的 key 是 `${来源}:${插件id}`。
 */

export const OFFICIAL_REPO: PluginRepo = { id: "dbx", name: DBX_SOURCE, url: DBX_CATALOG_URL, official: true, enabled: true };

const MAX_REPOS = 10;
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

export function checkRepoUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new Error("目录地址不合法");
  }
  const local = u.protocol === "http:" && /^(127\.0\.0\.1|localhost)$/.test(u.hostname);
  if (u.protocol !== "https:" && !local) throw new Error("目录地址只支持 https");
  if (u.username || u.password) throw new Error("目录地址里不要带账号密码");
  return u.toString();
}

export class PluginRepos {
  constructor(
    private file: string,
    /** 测试时把官方仓库指到本地服务 */
    private official: PluginRepo = OFFICIAL_REPO,
  ) {}

  private read(): PluginRepo[] {
    try {
      const j = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!Array.isArray(j?.repos)) return [];
      return j.repos
        .filter((r: any) => r && typeof r.id === "string" && ID_RE.test(r.id) && typeof r.url === "string")
        .map((r: any) => ({ id: r.id, name: typeof r.name === "string" && r.name.trim() ? r.name.trim().slice(0, 40) : r.id, url: r.url, enabled: r.enabled !== false }));
    } catch {
      return [];
    }
  }

  private write(repos: PluginRepo[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify({ repos }, null, 2));
  }

  /** 官方 + 第三方 */
  list(): PluginRepo[] {
    return [this.official, ...this.read()];
  }

  /** 已启用的第三方仓库 */
  extra(): PluginRepo[] {
    return this.read().filter(r => r.enabled);
  }

  add(input: { id: string; name?: string; url: string }): PluginRepo {
    const id = String(input.id ?? "").trim().toLowerCase();
    if (!ID_RE.test(id)) throw new Error("仓库 ID 只能用小写字母、数字、- 和 _，最长 32 位");
    const all = this.read();
    if (id === this.official.id || all.some(r => r.id === id)) throw new Error(`仓库 ID「${id}」已经存在`);
    if (all.length >= MAX_REPOS) throw new Error(`最多添加 ${MAX_REPOS} 个第三方仓库`);
    const url = checkRepoUrl(String(input.url ?? ""));
    if (all.some(r => r.url === url) || url === this.official.url) throw new Error("这个目录地址已经添加过了");
    const name = String(input.name ?? "").trim().slice(0, 40) || id;
    if (name === this.official.name || all.some(r => r.name === name)) throw new Error(`仓库名称「${name}」已经被用了，换一个`);
    const repo: PluginRepo = { id, name, url, enabled: true };
    this.write([...all, repo]);
    return repo;
  }

  remove(id: string): boolean {
    if (id === this.official.id) throw new Error("官方仓库不能删除");
    const all = this.read();
    if (!all.some(r => r.id === id)) return false;
    this.write(all.filter(r => r.id !== id));
    return true;
  }

  setEnabled(id: string, enabled: boolean): void {
    if (id === this.official.id) throw new Error("官方仓库不能停用");
    const all = this.read();
    if (!all.some(r => r.id === id)) throw new Error("没有这个仓库");
    this.write(all.map(r => (r.id === id ? { ...r, enabled } : r)));
  }
}

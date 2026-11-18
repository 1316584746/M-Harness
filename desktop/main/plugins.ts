import { marketplaceUrl, parseMarketplace, parsePackage, type MarketResult, type MarketplaceCfg, type PluginEntry } from "../shared/plugins";
import { BUNDLED, BUNDLED_SOURCE } from "./plugin-catalog";

const TTL = 10 * 60_000;
const MAX_BYTES = 2_000_000;

interface CacheItem {
  at: number;
  entries: PluginEntry[];
  name?: string;
  skipped: string[];
}

/** 插件商店的数据：自带的插件 + 用户配置的远程插件源（JSON，带缓存） */
export class PluginMarket {
  private cache = new Map<string, CacheItem>();

  constructor(private fetchImpl: typeof fetch = fetch) {}

  private async fetchOne(m: MarketplaceCfg, refresh: boolean): Promise<{ label: string; item: CacheItem }> {
    const url = marketplaceUrl(m.url);
    const fallback = m.name?.trim() || m.url;
    if (!url) throw Object.assign(new Error("地址不对：需要 http(s) 链接，或 owner/repo"), { label: fallback });
    const hit = this.cache.get(url);
    if (hit && !refresh && Date.now() - hit.at < TTL) return { label: m.name?.trim() || hit.name || fallback, item: hit };
    try {
      const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      if (text.length > MAX_BYTES) throw new Error("插件源文件太大（超过 2MB）");
      const label = m.name?.trim() || fallback;
      // 先用名字解析一遍拿到 JSON 里的 name，再用最终的源名重新生成 key
      const probe = parseMarketplace(JSON.parse(text), label);
      const final = m.name?.trim() || probe.name || fallback;
      const parsed = final === label ? probe : parseMarketplace(JSON.parse(text), final);
      const item: CacheItem = { at: Date.now(), entries: parsed.entries, name: probe.name, skipped: parsed.skipped };
      this.cache.set(url, item);
      return { label: final, item };
    } catch (e) {
      // 网络失败时用旧缓存兜底
      if (hit) return { label: m.name?.trim() || hit.name || fallback, item: hit };
      throw Object.assign(new Error(e instanceof Error ? e.message : String(e)), { label: fallback });
    }
  }

  /** 从链接安装：下载一个插件包（单个插件或插件列表的 JSON），只解析不安装 */
  async fetchPackage(url: string): Promise<{ entries: PluginEntry[]; skipped: string[] }> {
    if (!/^https?:\/\//i.test(url.trim())) throw new Error("需要 http(s) 链接");
    const res = await this.fetchImpl(url.trim(), { signal: AbortSignal.timeout(15_000), headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (text.length > MAX_BYTES) throw new Error("文件太大（超过 2MB）");
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("不是有效的 JSON");
    }
    return parsePackage(json);
  }

  async load(marketplaces: MarketplaceCfg[], refresh = false): Promise<MarketResult> {
    const entries: PluginEntry[] = [...BUNDLED];
    const errors: MarketResult["errors"] = [];
    const sources: NonNullable<MarketResult["sources"]> = [];
    const taken = new Set<string>([BUNDLED_SOURCE]);
    const on = marketplaces.filter(m => m.enabled !== false);
    const results = await Promise.allSettled(on.map(m => this.fetchOne(m, refresh)));
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        if (taken.has(r.value.label)) {
          errors.push({ source: r.value.label, error: "插件源名称重复，已忽略" });
          return;
        }
        taken.add(r.value.label);
        entries.push(...r.value.item.entries);
        sources.push({ url: on[i].url, label: r.value.label, count: r.value.item.entries.length });
        if (r.value.item.skipped.length) errors.push({ source: r.value.label, error: `跳过 ${r.value.item.skipped.length} 个无效条目：${r.value.item.skipped.slice(0, 3).join("；")}` });
      } else {
        const e: any = r.reason;
        errors.push({ source: e?.label ?? on[i].name ?? on[i].url, error: e?.message ?? String(e) });
      }
    });
    return { entries, errors, sources };
  }
}

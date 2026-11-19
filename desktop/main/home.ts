import fs from "node:fs";
import path from "node:path";
import type { DailyDTO, WeatherDTO } from "../shared/api";
import { pickQuote, QUOTES } from "./quotes";

/**
 * 首页数据：按 IP 定位城市 + 天气，每日一图一句。
 * 只在主进程联网（渲染进程的 CSP 不允许直接请求外网），结果缓存在数据目录里：断网时也有上次的内容。
 * - 定位：ipwho.is → ip-api.com（任一可用即可）
 * - 天气：Open-Meteo（免费、无需 Key）
 * - 每日图片：必应每日一图（下载到数据目录，当天不再重复下载）
 */

export interface HomeUrls {
  ip: string[];
  weather: string;
  geocode: string;
  bingApi: string;
  bingHost: string;
}

export const DEFAULT_URLS: HomeUrls = {
  ip: ["https://ipwho.is/?lang=zh-CN&fields=success,ip,city,region,country,latitude,longitude", "http://ip-api.com/json/?lang=zh-CN&fields=status,message,country,regionName,city,lat,lon,query"],
  weather: "https://api.open-meteo.com",
  geocode: "https://geocoding-api.open-meteo.com",
  bingApi: "https://cn.bing.com/HPImageArchive.aspx?format=js&idx=0&n=1&mkt=zh-CN",
  bingHost: "https://cn.bing.com",
};

interface Loc {
  lat: number;
  lon: number;
  city?: string;
  region?: string;
  country?: string;
  ip?: string;
}

const WEATHER_TTL = 30 * 60_000;

/** WMO 天气代码 → 文字 + 图标 */
export function describeWeather(code: number, isDay = true): { text: string; icon: string } {
  if (code === 0) return isDay ? { text: "晴", icon: "☀️" } : { text: "晴", icon: "🌙" };
  if (code === 1) return isDay ? { text: "大部晴朗", icon: "🌤️" } : { text: "大部晴朗", icon: "🌙" };
  if (code === 2) return { text: "多云", icon: "⛅" };
  if (code === 3) return { text: "阴", icon: "☁️" };
  if (code === 45 || code === 48) return { text: "雾", icon: "🌫️" };
  if (code >= 51 && code <= 57) return { text: "毛毛雨", icon: "🌦️" };
  if (code === 61 || code === 80) return { text: "小雨", icon: "🌦️" };
  if (code === 63 || code === 81) return { text: "中雨", icon: "🌧️" };
  if (code === 65 || code === 82) return { text: "大雨", icon: "🌧️" };
  if (code === 66 || code === 67) return { text: "冻雨", icon: "🌧️" };
  if (code === 71 || code === 85) return { text: "小雪", icon: "🌨️" };
  if (code === 73) return { text: "中雪", icon: "🌨️" };
  if (code === 75 || code === 86) return { text: "大雪", icon: "❄️" };
  if (code === 77) return { text: "雪粒", icon: "🌨️" };
  if (code === 95) return { text: "雷暴", icon: "⛈️" };
  if (code === 96 || code === 99) return { text: "雷暴伴冰雹", icon: "⛈️" };
  return { text: "未知", icon: "🌡️" };
}

export function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export class HomeService {
  private urls: HomeUrls;
  private fetchFn: typeof fetch;
  private now: () => Date;
  private weatherInflight = new Map<string, Promise<WeatherDTO>>();
  private dailyInflight?: Promise<DailyDTO>;
  private dailyFailedAt = 0;

  constructor(
    private home: string,
    deps: { urls?: Partial<HomeUrls>; fetch?: typeof fetch; now?: () => Date } = {},
  ) {
    this.urls = { ...DEFAULT_URLS, ...deps.urls };
    this.fetchFn = deps.fetch ?? fetch;
    this.now = deps.now ?? (() => new Date());
  }

  private async getJson(url: string, ms = 8000): Promise<any> {
    const r = await this.fetchFn(url, { signal: AbortSignal.timeout(ms), headers: { "user-agent": "M-Harness", accept: "application/json" } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  // ───────────── 天气 ─────────────

  private cacheFile(): string {
    return path.join(this.home, "home-cache.json");
  }
  private readCache(): Record<string, { at: number; res: WeatherDTO }> {
    try {
      return JSON.parse(fs.readFileSync(this.cacheFile(), "utf8"));
    } catch {
      return {};
    }
  }

  /** 按 IP 定位（city 为空）或按城市名查天气；30 分钟内用缓存，联网失败时给旧数据 */
  weather(opts: { refresh?: boolean; city?: string } = {}): Promise<WeatherDTO> {
    const city = opts.city?.trim() || "";
    const key = city ? `city:${city}` : "ip";
    const cache = this.readCache();
    const hit = cache[key];
    if (hit && !opts.refresh && this.now().getTime() - hit.at < WEATHER_TTL) return Promise.resolve({ ...hit.res, cached: true });
    const running = this.weatherInflight.get(key);
    if (running) return running;
    const p = this.fetchWeather(city)
      .then(res => {
        const c = this.readCache();
        c[key] = { at: res.at!, res };
        try {
          fs.writeFileSync(this.cacheFile(), JSON.stringify(c), "utf8");
        } catch {
          /* 缓存写不进去不影响显示 */
        }
        return res;
      })
      .catch((e: any): WeatherDTO => {
        const msg = e?.name === "TimeoutError" ? "请求超时" : (e?.cause?.code ? `网络错误（${e.cause.code}）` : (e?.message ?? String(e)));
        return hit ? { ...hit.res, stale: true, cached: true } : { ok: false, byIp: !city, error: msg };
      })
      .finally(() => this.weatherInflight.delete(key));
    this.weatherInflight.set(key, p);
    return p;
  }

  private async locateByIp(): Promise<Loc> {
    let lastErr = "";
    for (const url of this.urls.ip) {
      try {
        const j = await this.getJson(url, 6000);
        if (j.success === true && typeof j.latitude === "number") return { lat: j.latitude, lon: j.longitude, city: j.city, region: j.region, country: j.country, ip: j.ip };
        if (j.status === "success" && typeof j.lat === "number") return { lat: j.lat, lon: j.lon, city: j.city, region: j.regionName, country: j.country, ip: j.query };
        lastErr = j.message ?? "定位失败";
      } catch (e: any) {
        lastErr = e?.message ?? String(e);
      }
    }
    throw new Error(`无法根据 IP 定位城市（${lastErr}）`);
  }

  private async geocode(name: string): Promise<Loc> {
    const j = await this.getJson(`${this.urls.geocode}/v1/search?name=${encodeURIComponent(name)}&count=1&language=zh&format=json`);
    const r = j?.results?.[0];
    if (!r) throw new Error(`没有找到城市：${name}`);
    return { lat: r.latitude, lon: r.longitude, city: r.name, region: r.admin1, country: r.country };
  }

  private async fetchWeather(cityName: string): Promise<WeatherDTO> {
    const loc = cityName ? await this.geocode(cityName) : await this.locateByIp();
    const q = new URLSearchParams({
      latitude: String(loc.lat),
      longitude: String(loc.lon),
      current: "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day",
      daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
      timezone: "auto",
      forecast_days: "4",
    });
    const j = await this.getJson(`${this.urls.weather}/v1/forecast?${q}`);
    const c = j?.current;
    if (!c) throw new Error("天气服务没有返回数据");
    const now = describeWeather(c.weather_code, c.is_day !== 0);
    const d = j.daily ?? {};
    const daily = (d.time ?? []).map((date: string, i: number) => ({
      date,
      max: Math.round(d.temperature_2m_max?.[i]),
      min: Math.round(d.temperature_2m_min?.[i]),
      code: d.weather_code?.[i],
      ...describeWeather(d.weather_code?.[i] ?? -1),
      pop: d.precipitation_probability_max?.[i] ?? undefined,
    }));
    return {
      ok: true,
      byIp: !cityName,
      ip: loc.ip,
      city: loc.city,
      region: loc.region && loc.region !== loc.city ? loc.region : undefined,
      country: loc.country,
      current: {
        temp: Math.round(c.temperature_2m),
        feels: Math.round(c.apparent_temperature),
        humidity: Math.round(c.relative_humidity_2m),
        wind: Math.round(c.wind_speed_10m),
        code: c.weather_code,
        ...now,
      },
      daily,
      at: this.now().getTime(),
    };
  }

  // ───────────── 每日一图一句 ─────────────

  private dailyDir(): string {
    return path.join(this.home, "daily");
  }

  private readMeta(date: string): { title?: string; copyright?: string; urlbase?: string; res?: string } | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.dailyDir(), `${date}.json`), "utf8"));
    } catch {
      return null;
    }
  }

  private readDay(date: string): { title?: string; copyright?: string; image: string; res?: string } | null {
    const meta = this.readMeta(date);
    if (!meta) return null;
    try {
      const img = fs.readFileSync(path.join(this.dailyDir(), `${date}.jpg`));
      return { title: meta.title, copyright: meta.copyright, res: meta.res, image: `data:image/jpeg;base64,${img.toString("base64")}` };
    } catch {
      return null;
    }
  }

  private latestCachedDate(): string | null {
    try {
      const days = fs.readdirSync(this.dailyDir()).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort();
      return days.length ? days[days.length - 1] : null;
    } catch {
      return null;
    }
  }

  /** 今天的图片和句子：当天首次联网下载，之后读本地；下载不了就沿用最近一次的图片 */
  daily(): Promise<DailyDTO> {
    this.dailyInflight ??= this.loadDaily().finally(() => (this.dailyInflight = undefined));
    return this.dailyInflight;
  }

  /** 下载必应图片：优先 4K（3840×2160），没有再退回 1080p；返回图片和实际清晰度 */
  private async downloadBing(urlbase: string): Promise<{ buf: Buffer; res: "uhd" | "hd" }> {
    for (const [suffix, res] of [["_UHD.jpg", "uhd"], ["_1920x1080.jpg", "hd"]] as const) {
      try {
        const r = await this.fetchFn(`${this.urls.bingHost}${urlbase}${suffix}`, { signal: AbortSignal.timeout(60_000) });
        if (!r.ok) continue;
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length >= 5000) return { buf, res };
      } catch {
        /* 换下一档清晰度 */
      }
    }
    throw new Error("图片下载失败");
  }

  private async loadDaily(): Promise<DailyDTO> {
    const date = ymd(this.now());
    let day = this.readDay(date);
    // 今天没有图，或者是旧版本留下的低清图（没有清晰度标记）：联网下载高清图；失败了先用现有的
    const need = !day || day.res === undefined;
    if (need && this.now().getTime() - this.dailyFailedAt > 10 * 60_000) {
      try {
        const j = await this.getJson(this.urls.bingApi, 10_000);
        const it = j?.images?.[0];
        if (!it?.urlbase) throw new Error("没有图片");
        // 必应还没换新图（和最近一次缓存的是同一张）：先不记成今天的，稍后再试，避免连着两天同一张
        const lastDate = this.latestCachedDate();
        if (lastDate && lastDate !== date && this.readMeta(lastDate)?.urlbase === it.urlbase) throw new Error("必应今天的图片还没更新");
        const { buf, res } = await this.downloadBing(it.urlbase);
        fs.mkdirSync(this.dailyDir(), { recursive: true });
        fs.writeFileSync(path.join(this.dailyDir(), `${date}.jpg`), buf);
        fs.writeFileSync(path.join(this.dailyDir(), `${date}.json`), JSON.stringify({ title: it.title, copyright: it.copyright, urlbase: it.urlbase, res }), "utf8");
        this.prune(date);
        day = this.readDay(date);
      } catch {
        this.dailyFailedAt = this.now().getTime();
      }
    }
    if (!day) {
      const last = this.latestCachedDate();
      if (last) day = this.readDay(last);
    }
    const hint = `${day?.title ?? ""} ${day?.copyright ?? ""}`;
    const q = this.quoteFor(date, hint, !!this.readDayExists(date));
    return { date, image: day?.image, title: day?.title, copyright: day?.copyright, quote: { text: q.text, author: q.author } };
  }

  private readDayExists(date: string): boolean {
    return fs.existsSync(path.join(this.dailyDir(), `${date}.jpg`));
  }

  private historyFile(): string {
    return path.join(this.dailyDir(), "quotes.json");
  }

  /**
   * 每天一句且不重复：记录每天用了哪句、一共用过哪些；同一天再次打开读回同一句。
   * 只有今天的图片已就绪时才记账（图片没下到就先临时选一句，等图片到了再按它来配句子）。
   */
  private quoteFor(date: string, hint: string, commit: boolean) {
    let h: { byDate: Record<string, string>; used: string[] } = { byDate: {}, used: [] };
    try {
      h = JSON.parse(fs.readFileSync(this.historyFile(), "utf8"));
      if (!h.byDate || !Array.isArray(h.used)) throw new Error("bad");
    } catch {
      h = { byDate: {}, used: [] };
    }
    const saved = h.byDate[date] && QUOTES.find(q => q.text === h.byDate[date]);
    if (saved) return saved;
    let used = new Set(h.used);
    // 整个句库都用过一轮：重新开始，但最近 30 天用过的先不重复
    if (used.size >= QUOTES.length) used = new Set(Object.values(h.byDate));
    const q = pickQuote(date, hint, used);
    if (commit) {
      used.add(q.text);
      const dates = Object.keys(h.byDate).sort().slice(-30);
      const byDate: Record<string, string> = {};
      for (const d of dates) byDate[d] = h.byDate[d];
      byDate[date] = q.text;
      try {
        fs.mkdirSync(this.dailyDir(), { recursive: true });
        fs.writeFileSync(this.historyFile(), JSON.stringify({ byDate, used: [...used] }), "utf8");
      } catch {
        /* 记不上账就退回按日期固定选 */
      }
    }
    return q;
  }

  /** 只留最近 10 天的图片 */
  private prune(today: string): void {
    try {
      const days = fs.readdirSync(this.dailyDir()).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort();
      for (const d of days.slice(0, Math.max(0, days.length - 10))) {
        if (d === today) continue;
        for (const ext of ["json", "jpg"]) fs.rmSync(path.join(this.dailyDir(), `${d}.${ext}`), { force: true });
      }
    } catch {
      /* 清理失败不影响 */
    }
  }

  /** 启动时后台预取，打开首页时现成可用 */
  prefetch(city?: string): void {
    void this.weather({ city }).catch(() => {});
    void this.daily().catch(() => {});
  }
}

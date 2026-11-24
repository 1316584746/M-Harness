import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { describeWeather, HomeService, ymd } from "../desktop/main/home";
import { detectTags, pickQuote, QUOTES } from "../desktop/main/quotes";

describe("每日一句", () => {
  it("按图片说明里的景物挑相配的句子，且同一天结果固定", () => {
    expect(detectTags("雪松林步道，冰川国家公园，蒙大拿州")).toEqual(expect.arrayContaining(["forest", "mountain", "snow", "road"]));
    const q = pickQuote("2026-11-17", "科罗拉多大峡谷");
    expect(q.tags).toContain("mountain");
    expect(pickQuote("2026-11-17", "科罗拉多大峡谷")).toEqual(q);
  });
  it("没有匹配时从全部里取；每句都有内容", () => {
    expect(QUOTES).toContain(pickQuote("2026-01-01", "xyz"));
    expect(QUOTES.every(x => x.text.length > 4)).toBe(true);
    expect(QUOTES.filter(x => !x.author?.trim()).map(x => x.text)).toEqual([]); // 每一句都要有出处（人名 / 书名）
    expect(new Set(QUOTES.map(x => x.text)).size).toBe(QUOTES.length); // 句库里不能有重复的句子
  });
  it("已用过的句子不会再选，相配的用完了就从剩下的里选", () => {
    const used = new Set(QUOTES.filter(q => q.tags.includes("mountain")).map(q => q.text));
    const q = pickQuote("2026-11-17", "科罗拉多大峡谷", used);
    expect(used.has(q.text)).toBe(false);
  });
  it("不同日期会换句子", () => {
    const set = new Set(Array.from({ length: 30 }, (_, i) => pickQuote(`2026-11-${String(i + 1).padStart(2, "0")}`, "").text));
    expect(set.size).toBeGreaterThan(10);
  });
});

describe("天气代码", () => {
  it("describeWeather", () => {
    expect(describeWeather(0, true).text).toBe("晴");
    expect(describeWeather(0, false).icon).toBe("🌙");
    expect(describeWeather(63).text).toBe("中雨");
    expect(describeWeather(95).text).toBe("雷暴");
  });
});

describe("HomeService", () => {
  let server: http.Server;
  let base = "";
  let home = "";
  const hits: string[] = [];
  const mode = { ip1: "fail" as "fail" | "ok", weather: "ok" as "ok" | "fail", bing: "ok" as "ok" | "fail", pic: "A", uhd: true };
  const jpg = Buffer.alloc(8000, 7);
  const jpgUhd = Buffer.alloc(20000, 9);

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = req.url ?? "";
      hits.push(url.split("?")[0]);
      const json = (o: any, status = 200) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(o));
      };
      if (url.startsWith("/ip1")) return mode.ip1 === "ok" ? json({ success: true, ip: "1.2.3.4", city: "北京", region: "北京市", country: "中国", latitude: 39.9, longitude: 116.4 }) : json({ success: false }, 500);
      if (url.startsWith("/ip2")) return json({ status: "success", query: "5.6.7.8", city: "上海", regionName: "上海市", country: "中国", lat: 31.2, lon: 121.4 });
      if (url.startsWith("/geo/v1/search")) {
        const name = decodeURIComponent(/name=([^&]*)/.exec(url)![1]);
        return json(name === "广州" ? { results: [{ name: "广州", admin1: "广东", country: "中国", latitude: 23.1, longitude: 113.3 }] } : {});
      }
      if (url.startsWith("/w/v1/forecast")) {
        if (mode.weather === "fail") return json({}, 500);
        return json({
          current: { temperature_2m: 12.4, apparent_temperature: 10.6, relative_humidity_2m: 55, weather_code: 2, wind_speed_10m: 9.2, is_day: 1 },
          daily: { time: ["2026-11-17", "2026-11-18"], weather_code: [2, 61], temperature_2m_max: [15.2, 13], temperature_2m_min: [6.1, 5], precipitation_probability_max: [10, 60] },
        });
      }
      if (url.startsWith("/bing/api")) return mode.bing === "ok" ? json({ images: [{ urlbase: `/th?id=OHR.Test${mode.pic}`, title: "云海", copyright: "黄山云海，安徽 (© Someone)" }] }) : json({}, 500);
      if (url.startsWith("/bing/th")) {
        if (url.includes("_UHD") && !mode.uhd) return json({}, 404);
        res.writeHead(200, { "content-type": "image/jpeg" });
        return res.end(url.includes("_UHD") ? jpgUhd : jpg);
      }
      json({}, 404);
    });
    await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
    base = `http://127.0.0.1:${(server.address() as any).port}`;
  });
  afterAll(() => void server.close());

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-home-"));
    hits.length = 0;
    mode.ip1 = "fail";
    mode.weather = "ok";
    mode.bing = "ok";
    mode.pic = "A";
    mode.uhd = true;
  });

  const make = (now = new Date(2026, 10, 17, 9, 0, 0)) =>
    new HomeService(home, {
      now: () => now,
      urls: { ip: [`${base}/ip1`, `${base}/ip2`], weather: `${base}/w`, geocode: `${base}/geo`, bingApi: `${base}/bing/api`, bingHost: `${base}/bing` },
    });

  it("按 IP 定位：第一个服务失败时换第二个；解析天气", async () => {
    const w = await make().weather();
    expect(w).toMatchObject({ ok: true, byIp: true, ip: "5.6.7.8", city: "上海", region: "上海市", country: "中国" });
    expect(w.current).toMatchObject({ temp: 12, feels: 11, humidity: 55, wind: 9, text: "多云" });
    expect(w.daily).toHaveLength(2);
    expect(w.daily![1]).toMatchObject({ max: 13, min: 5, text: "小雨", pop: 60 });
  });

  it("30 分钟内走缓存；refresh 才重新联网；并发合并", async () => {
    const s = make();
    await Promise.all([s.weather(), s.weather()]);
    expect(hits.filter(h => h === "/w/v1/forecast")).toHaveLength(1);
    const again = await s.weather();
    expect(again.cached).toBe(true);
    expect(hits.filter(h => h === "/w/v1/forecast")).toHaveLength(1);
    await s.weather({ refresh: true });
    expect(hits.filter(h => h === "/w/v1/forecast")).toHaveLength(2);
  });

  it("联网失败：有旧数据就给旧数据（标记离线），没有就报错", async () => {
    mode.weather = "fail";
    const first = await make().weather();
    expect(first.ok).toBe(false);
    expect(first.error).toBeTruthy();

    mode.weather = "ok";
    await make().weather();
    mode.weather = "fail";
    const stale = await make().weather({ refresh: true });
    expect(stale).toMatchObject({ ok: true, stale: true, city: "上海" });
  });

  it("指定城市：用地理编码；找不到时报错", async () => {
    const w = await make().weather({ city: "广州" });
    expect(w).toMatchObject({ ok: true, byIp: false, city: "广州", region: "广东" });
    expect(w.ip).toBeUndefined();
    const bad = await make().weather({ city: "不存在的城市" });
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("没有找到城市");
  });

  it("每日一图：下载一次后当天读本地；句子与图片说明相配", async () => {
    const s = make();
    const d = await s.daily();
    expect(d.date).toBe("2026-11-17");
    expect(d.image).toMatch(/^data:image\/jpeg;base64,/);
    expect(d.copyright).toContain("黄山");
    expect(QUOTES.find(q => q.text === d.quote.text)?.tags.some(t => ["mountain", "sky"].includes(t))).toBe(true);
    expect(fs.existsSync(path.join(home, "daily", "2026-11-17.jpg"))).toBe(true);

    hits.length = 0;
    const d2 = await make().daily();
    expect(d2.image).toBe(d.image);
    expect(d2.quote).toEqual(d.quote);
    expect(hits).toEqual([]);
  });

  it("第二天：下载新图；下载失败时沿用最近一次的图，句子仍按新日期", async () => {
    await make().daily();
    mode.pic = "B";
    mode.bing = "fail";
    const next = await make(new Date(2026, 10, 18, 9, 0, 0)).daily();
    expect(next.date).toBe("2026-11-18");
    expect(next.image).toMatch(/^data:image\/jpeg/);
    expect(next.copyright).toContain("黄山");
  });

  it("断网且从没下载过：没有图片但仍有句子", async () => {
    mode.bing = "fail";
    const d = await make().daily();
    expect(d.image).toBeUndefined();
    expect(d.quote.text.length).toBeGreaterThan(4);
  });

  it("只保留最近 10 天的图片", async () => {
    for (let day = 1; day <= 13; day++) {
      mode.pic = String(day);
      await make(new Date(2026, 10, day, 9, 0, 0)).daily();
    }
    const files = fs.readdirSync(path.join(home, "daily")).filter(f => f.endsWith(".jpg"));
    expect(files.length).toBe(10);
    expect(files).toContain("2026-11-13.jpg");
    expect(files).not.toContain("2026-11-01.jpg");
  });

  it("必应还没换图（和上一张相同）：不记成今天的，仍显示上一张，稍后换图后再更新", async () => {
    await make(new Date(2026, 10, 17, 9)).daily();
    const stale = await make(new Date(2026, 10, 18, 0, 5)).daily();
    expect(stale.date).toBe("2026-11-18");
    expect(fs.existsSync(path.join(home, "daily", "2026-11-18.jpg"))).toBe(false);
    expect(stale.image).toMatch(/^data:image/); // 沿用昨天的
    mode.pic = "B";
    const fresh = await make(new Date(2026, 10, 18, 12)).daily();
    expect(fs.existsSync(path.join(home, "daily", "2026-11-18.jpg"))).toBe(true);
    expect(fresh.image).toMatch(/^data:image/);
  });

  it("激励语：同一天固定，连续多天不重复，整个句库用完一轮才重来", async () => {
    const texts: string[] = [];
    for (let i = 0; i < QUOTES.length; i++) {
      const day = new Date(2026, 0, 1 + i, 9);
      mode.pic = "Q" + i; // 每天换一张图，句子才会被记账
      const s = make(day);
      const a = await s.daily();
      const b = await make(day).daily(); // 同一天再打开
      expect(b.quote).toEqual(a.quote);
      texts.push(a.quote.text);
    }
    expect(new Set(texts).size).toBe(QUOTES.length);
    // 下一轮：又从头开始（不再受「已用过」限制）
    mode.pic = "Q-next";
    const again = await make(new Date(2026, 0, 1 + QUOTES.length, 9)).daily();
    expect(QUOTES.some(q => q.text === again.quote.text)).toBe(true);
  });

  it("优先下载 4K 原图；没有 4K 时退回 1080p，且不会反复重试", async () => {
    const d = await make().daily();
    expect(fs.statSync(path.join(home, "daily", "2026-11-17.jpg")).size).toBe(20000);
    expect(JSON.parse(fs.readFileSync(path.join(home, "daily", "2026-11-17.json"), "utf8")).res).toBe("uhd");
    expect(d.image).toBeTruthy();

    mode.uhd = false;
    mode.pic = "N";
    await make(new Date(2026, 10, 18, 9)).daily();
    expect(fs.statSync(path.join(home, "daily", "2026-11-18.jpg")).size).toBe(8000);
    hits.length = 0;
    await make(new Date(2026, 10, 18, 10)).daily();
    expect(hits).toEqual([]);
  });

  it("旧版本留下的低清缓存（没有清晰度标记）会升级成 4K", async () => {
    fs.mkdirSync(path.join(home, "daily"), { recursive: true });
    fs.writeFileSync(path.join(home, "daily", "2026-11-17.jpg"), jpg);
    fs.writeFileSync(path.join(home, "daily", "2026-11-17.json"), JSON.stringify({ title: "云海", copyright: "黄山云海", urlbase: "/th?id=OHR.Old" }));
    await make().daily();
    expect(fs.statSync(path.join(home, "daily", "2026-11-17.jpg")).size).toBe(20000);
  });

  it("ymd", () => expect(ymd(new Date(2026, 0, 5))).toBe("2026-01-05"));
});

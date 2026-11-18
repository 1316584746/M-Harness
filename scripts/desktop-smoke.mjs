// 桌面端冒烟测试：启动真实 Electron 应用，通过 DevTools 协议驱动界面，验证核心流程。
// 用法：npm run desktop:build && npm run desktop:smoke
// 用一个假的 OpenAI 兼容服务 + 临时数据目录，不会碰你的 harness.config.json / .env。
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { makeZip } from "./zip.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const electron = path.join(root, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");
const home = fs.mkdtempSync(path.join(os.tmpdir(), "harness-desktop-"));
const DEBUG_PORT = 9333;
const LLM_PORT = 18999;

if (!fs.existsSync(path.join(root, "out", "main", "index.cjs"))) {
  console.error("请先执行 npm run desktop:build");
  process.exit(2);
}

// 假的 DBX 插件包（.dbxp 就是 zip）：manifest + 界面 + 后台程序 + checksums
const sha256 = b => crypto.createHash("sha256").update(b).digest("hex");
const dbxpFiles = [
  { name: "manifest.json", data: JSON.stringify({ id: "io.dbx.ssh", name: "Terminal", version: "0.7.14", permissions: ["host.ai"], entrypoints: { ui: { entry: "ui/index.html" }, backend: { executable: "bin/x" } }, contributions: [{ type: "workbench", id: "w" }, { type: "mcp", id: "m", tools: { list_hosts: {}, run: {} } }] }) },
  { name: "ui/index.html", data: "<html></html>" },
  { name: "bin/x", data: "exe" },
];
dbxpFiles.push({ name: "checksums.json", data: JSON.stringify({ algorithm: "sha256", files: Object.fromEntries(dbxpFiles.map(x => [x.name, sha256(x.data)])) }) });
const dbxp = makeZip(dbxpFiles);

// 另外三个假包：第三方仓库里的插件、本地文件安装、链接安装
const mkPkg = (id, version) => {
  const f = [
    { name: "manifest.json", data: JSON.stringify({ id, name: "包 " + id, version, entrypoints: { ui: { entry: "ui/index.html" } } }) },
    { name: "ui/index.html", data: "<html></html>" },
  ];
  f.push({ name: "checksums.json", data: JSON.stringify({ algorithm: "sha256", files: Object.fromEntries(f.map(x => [x.name, sha256(x.data)])) }) });
  return makeZip(f);
};
const pkgThird = mkPkg("com.third.tool", "1.0.0");
const pkgLocal = mkPkg("com.pkg.local", "1.2.0");
const pkgUrl = mkPkg("com.pkg.url", "0.3.0");

// 假的 OpenAI 兼容服务：先要求写文件，拿到工具结果后给出最终回答
let lastChat = {};
const llm = http.createServer((req, res) => {
  if (req.method === "GET" && req.url.endsWith("/models")) {
    const authed = req.headers.authorization === "Bearer sk-fake-12345";
    res.statusCode = authed ? 200 : 401;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(authed ? { data: [{ id: "beta-2" }, { id: "alpha-1" }] } : { error: "bad key" }));
  }
  if (req.method === "GET" && /^\/(ip1|w\/|geo\/|bing\/)/.test(req.url)) {
    const json = o => (res.setHeader("content-type", "application/json"), res.end(JSON.stringify(o)));
    if (req.url.startsWith("/ip1")) return json({ success: true, ip: "1.2.3.4", city: "北京", region: "北京市", country: "中国", latitude: 39.9, longitude: 116.4 });
    if (req.url.startsWith("/geo/")) return json({ results: [{ name: "广州", admin1: "广东", country: "中国", latitude: 23.1, longitude: 113.3 }] });
    if (req.url.startsWith("/w/")) {
      const gz = req.url.includes("latitude=23.1");
      return json({
        current: { temperature_2m: gz ? 26.2 : 12.4, apparent_temperature: 10.6, relative_humidity_2m: 55, weather_code: 2, wind_speed_10m: 9.2, is_day: 1 },
        daily: { time: ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20"], weather_code: [2, 61, 3, 0], temperature_2m_max: [15, 13, 12, 14], temperature_2m_min: [6, 5, 4, 5], precipitation_probability_max: [10, 60, 20, 0] },
      });
    }
    if (req.url.startsWith("/bing/api")) return json({ images: [{ urlbase: "/th?id=OHR.Smoke", title: "云海", copyright: "黄山云海，安徽 (© Smoke)" }] });
    res.setHeader("content-type", "image/png");
    return res.end(fs.readFileSync(path.join(root, "build", "icon.png")));
  }
  if (req.method === "GET" && req.url === "/market.json") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ name: "团队插件源", plugins: [{ id: "team/weekly", name: "团队周报", kind: "action", author: "team", description: "按团队模板写周报", version: "1.0.0", tags: ["report"], repo: "https://github.com/acme/weekly", downloads: 1234, install: { prompt: "团队周报：{{input}}" } }, { id: "bad id" }] }));
  }
  if (req.method === "GET" && req.url === "/pkg/io.dbx.ssh-0.7.14.dbxp") {
    res.setHeader("content-type", "application/octet-stream");
    return res.end(dbxp);
  }
  if (req.method === "GET" && req.url === "/dbx-catalog.json") {
    const art = () => [{ target: "universal", url: `http://127.0.0.1:${LLM_PORT}/pkg/io.dbx.ssh-0.7.14.dbxp`, sha256: sha256(dbxp), size: dbxp.length }];
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ catalogVersion: 1, plugins: [{ id: "io.dbx.ssh", name: "Terminal", description: "A secure terminal for DBX", publisher: "jinpy", tags: ["ssh", "sftp"], permissions: ["host.ai"], source: "https://github.com/jinpy/terminal/tree/v0.7.14", license: "MIT", latestVersion: "0.7.14", versions: [{ version: "0.7.14", releasedAt: "2026-11-10T00:00:00Z", artifacts: art() }], localizations: { "zh-CN": { name: "终端", description: "安全的终端：SSH、SFTP、远程命令" } } }, { id: "acme.noart", name: "No Package", description: "没有安装包的插件", latestVersion: "0.1.0", versions: [{ version: "0.1.0", artifacts: [] }] }] }));
  }
  if (req.method === "GET" && (req.url === "/pkg/third.dbxp" || req.url === "/pkg/url-plugin.dbxp")) {
    res.setHeader("content-type", "application/octet-stream");
    return res.end(req.url === "/pkg/third.dbxp" ? pkgThird : pkgUrl);
  }
  if (req.method === "GET" && req.url === "/repo2.json") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ catalogVersion: 1, plugins: [{ id: "com.third.tool", name: "第三方工具", description: "来自第三方仓库", publisher: "third", latestVersion: "1.0.0", versions: [{ version: "1.0.0", artifacts: [{ target: "universal", url: `http://127.0.0.1:${LLM_PORT}/pkg/third.dbxp`, sha256: sha256(pkgThird), size: pkgThird.length }] }] }] }));
  }
  if (req.method === "GET" && req.url === "/pkg.json") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ id: "pkg/hello", name: "包里的动作", kind: "action", description: "从链接安装的插件包", version: "0.1.0", install: { prompt: "打招呼：{{input}}" } }));
  }
  if (req.method === "GET" && req.url === "/repos/acme/app/releases/latest") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ tag_name: "v9.9.9", body: "## 更新内容\n- 修复了若干问题", html_url: "https://github.com/acme/app/releases/tag/v9.9.9" }));
  }
  if (req.method === "GET" && req.url === "/api/v4/user") {
    const authed = req.headers["private-token"] === "glpat-smoke-token-1";
    res.statusCode = authed ? 200 : 401;
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify(authed ? { name: "Smoke User", username: "smoke", email: "smoke@example.com", created_at: "2026-07-10T00:00:00Z" } : {}));
  }
  if (req.method !== "POST") {
    res.statusCode = 404;
    return res.end("not found");
  }
  let raw = "";
  req.on("data", c => (raw += c));
  req.on("end", () => {
    const body = JSON.parse(raw);
    lastChat = { model: body.model, tools: (body.tools ?? []).map(t => t.function.name), system: String(body.messages?.[0]?.content ?? ""), users: body.messages.filter(m => m.role === "user").map(m => m.content) };
    if (body.model === "echo") {
      // 回声：把用户最后一句话原样回出来（产品里没有内置假模型，测试走真实的 openai-compat 适配器）
      const lastUser = [...body.messages].reverse().find(m => m.role === "user")?.content ?? "";
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: `【echo】${lastUser}` } }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
    }
    const done = body.messages.some(m => m.role === "tool");
    const message = done
      ? { role: "assistant", content: "已写入 hello.txt" }
      : { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "write_file", arguments: JSON.stringify({ path: "hello.txt", content: "hi from agent" }) } }] };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 } }));
  });
});
await new Promise(r => llm.listen(LLM_PORT, "127.0.0.1", r));

// 预置一个带提交的 git 仓库，用来验证「代码仓库」页与工作区选择
const demoRepo = path.join(home, "demo-repo");
fs.mkdirSync(demoRepo);
const g = (...a) => spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...a], { cwd: demoRepo });
g("init", "-b", "main");
fs.writeFileSync(path.join(demoRepo, "README.md"), "demo\n");
g("add", ".");
g("commit", "-m", "init demo");
fs.writeFileSync(path.join(demoRepo, "dirty.txt"), "x");

fs.writeFileSync(
  path.join(home, "harness.config.json"),
  JSON.stringify({
    defaultProvider: "echo",
    workspace: ".",
    repos: { demo: { path: demoRepo, url: "https://github.com/acme/demo.git", platform: "github" } },
    providers: {
      echo: { type: "openai-compat", baseURL: `http://127.0.0.1:${LLM_PORT}/v1`, apiKey: "sk-fake-12345", model: "echo" },
      fake: { type: "openai-compat", baseURL: `http://127.0.0.1:${LLM_PORT}/v1`, apiKey: "sk-fake-12345", model: "m" },
      nokey: { type: "openai-compat", baseURL: "http://x", apiKey: "${NOPE_NOT_SET}", model: "m" },
    },
  }),
);

const child = spawn(electron, [root, `--remote-debugging-port=${DEBUG_PORT}`, `--user-data-dir=${path.join(home, ".ud")}`], { cwd: home, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HARNESS_DBX_CATALOG: `http://127.0.0.1:${LLM_PORT}/dbx-catalog.json`, HARNESS_DBX_DIR: path.join(home, "dbx-data"), HARNESS_PLUGINS_DIR: path.join(home, "plugins-local"), HARNESS_AUTOMATION_TICK_MS: "400", HARNESS_NO_NOTIFY: "1", HARNESS_PLUGIN_SCRIPT_HOST: "1", HARNESS_DBX_OPEN_LOG: path.join(home, "dbx-open.log"), HARNESS_DBX_MCP: process.execPath, HARNESS_GITHUB_API: `http://127.0.0.1:${LLM_PORT}`, HARNESS_HOME_BASE: `http://127.0.0.1:${LLM_PORT}` } });
let log = "";
child.stdout.on("data", d => (log += d));
child.stderr.on("data", d => (log += d));

const sleep = ms => new Promise(r => setTimeout(r, ms));
async function pageWs() {
  for (let i = 0; i < 80; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`)).json();
      const p = list.find(x => x.type === "page" && x.url.includes("index.html"));
      if (p) return p.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error("Electron 页面未出现\n" + log);
}

const out = [];
const ok = (name, cond) => out.push(`${cond ? "PASS" : "FAIL"} ${name}`);
let ws;

try {
  ws = new WebSocket(await pageWs());
  await new Promise(r => (ws.onopen = r));
  let id = 0;
  const waiters = new Map();
  ws.onmessage = e => {
    const m = JSON.parse(e.data);
    if (m.id && waiters.has(m.id)) waiters.get(m.id)(m);
    if (m.method === "Runtime.exceptionThrown") log += "\n[renderer exception] " + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text);
  };
  const cdp = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const i = ++id;
      waiters.set(i, resolve);
      setTimeout(() => reject(new Error("cdp timeout " + method)), 8000);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  await cdp("Runtime.enable");
  const ev = async expr => {
    const r = await cdp("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true });
    if (!r.result) throw new Error("CDP error: " + JSON.stringify(r.error) + " expr=" + expr.slice(0, 120));
    if (r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails));
    return r.result.result.value;
  };
  const until = async (expr, ms = 15000) => {
    for (let t = 0; t < ms; t += 100) {
      if (await ev(`!!(${expr})`)) return true;
      await sleep(100);
    }
    throw new Error("等待超时：" + expr);
  };
  const setVal = (sel, v, proto, evt) =>
    `(() => { const el = document.querySelector(${JSON.stringify(sel)}); Object.getOwnPropertyDescriptor(window.${proto}.prototype, 'value').set.call(el, ${JSON.stringify(v)}); el.dispatchEvent(new Event('${evt}', { bubbles: true })); return true; })()`;
  const clickText = (sel, text) =>
    `(() => { const b = [...document.querySelectorAll(${JSON.stringify(sel)})].find(x => x.textContent.includes(${JSON.stringify(text)})); if (!b) return false; b.click(); return true; })()`;

  const click = tid => `(() => { const b = document.querySelector('[data-testid="${tid}"]'); if (!b || b.disabled) return false; b.click(); return true; })()`;
  const shot = async name => {
    try {
      const r = await cdp("Page.captureScreenshot", { format: "png" });
      fs.mkdirSync(path.join(root, "out", "smoke"), { recursive: true });
      fs.writeFileSync(path.join(root, "out", "smoke", name + ".png"), Buffer.from(r.result.data, "base64"));
    } catch {}
  };
  const send = async text => {
    await ev(setVal('[data-testid="composer-input"]', text, "HTMLTextAreaElement", "input"));
    await until(`document.querySelector('[data-testid="send"]') && !document.querySelector('[data-testid="send"]').disabled`);
    await ev(click("send"));
  };
  const newChat = async () => {
    await ev(click("new-chat"));
  };
  const lastAnswer = `[...document.querySelectorAll('[data-testid="msg-assistant"]')].pop()`;
  const waitDone = (extra = "true") => until(`${lastAnswer}?.dataset.status === 'done' && ${lastAnswer}.textContent.includes(${JSON.stringify(extra === "true" ? "" : extra)})`);

  // 窗口在后台时 focus()/blur() 不触发事件；模拟页面始终有焦点，让依赖 onBlur 的输入框可测
  await cdp("Emulation.setFocusEmulationEnabled", { enabled: true });
  await until("document.querySelector('[data-testid=\"brand\"]')");
  ok("应用启动并渲染标题栏", true);
  ok("暴露了 preload API", await ev("typeof window.harness?.run === 'function'"));

  // 0) 首页：启动后默认停在首页（问候、天气、日历、每日一图一句）
  ok("启动后默认显示首页", await ev(`!!document.querySelector('[data-testid="home"]') && !document.querySelector('[data-testid="home"]').closest('[hidden]')`));
  ok("按时段问候", /^(早上好|中午好|下午好|晚上好|夜深了)/.test(await ev(`document.querySelector('[data-testid="home-greeting"]').innerText`)));
  await until(`document.querySelector('[data-testid="weather-city"]')`);
  ok("按 IP 定位显示城市与温度", await ev(`(() => { const s = document.querySelector('[data-testid="home-weather"]').innerText; return s.includes('北京') && s.includes('12°') && s.includes('1.2.3.4'); })()`));
  ok("天气在右上角、只展示今天", await ev(`(() => { const w = document.querySelector('[data-testid="home-weather"]').getBoundingClientRect(); const h = document.querySelector('[data-testid="home"]').getBoundingClientRect(); return document.querySelectorAll('.weather-day').length === 0 && w.right > h.right - 120 && w.top < h.top + 140 && /15° ~ 6°|6° ~ 15°/.test(document.querySelector('[data-testid="home-weather"]').innerText); })()`));
  ok("日历在右下角且不大、没有不透明底板", await ev(`(() => { const c = document.querySelector('[data-testid="home-calendar"]'); const r = c.getBoundingClientRect(); const h = document.querySelector('[data-testid="home"]').getBoundingClientRect(); return r.width < 320 && r.height < 300 && r.bottom > h.bottom - 120 && r.right > h.right - 120 && getComputedStyle(c).backgroundColor === 'rgba(0, 0, 0, 0)'; })()`));
  await until(`document.querySelector('[data-testid="home-quote"]')`);
  ok("显示每日一句", (await ev(`document.querySelector('[data-testid="home-quote"]').innerText.length`)) > 6);
  await until(`getComputedStyle(document.querySelector('[data-testid="home-hero"]')).backgroundImage.includes('data:image')`);
  ok("顶部是每日一图", true);
  const nowD = new Date();
  ok("日历显示当前月份并高亮今天", (await ev(`document.querySelector('[data-testid="calendar-title"]').innerText`)) === `${nowD.getFullYear()}年${nowD.getMonth() + 1}月` && (await ev(`document.querySelectorAll('.cal-cell.today').length`)) === 1);
  ok("日历格子带农历", await ev(`[...document.querySelectorAll('.cal-cell .cal-lunar:not(.fest)')].some(e => /[初十廿三]/.test(e.innerText))`));
  await shot("0-home");
  await ev(click("calendar-next"));
  ok("日历可以翻月", (await ev(`document.querySelectorAll('.cal-cell.today').length`)) === 0 && (await ev(`!!document.querySelector('[data-testid="calendar-today"]')`)));
  await ev(click("calendar-today"));
  ok("回到今天", (await ev(`document.querySelectorAll('.cal-cell.today').length`)) === 1);
  // 停在某一天上：弹出节日 / 休班 / 宜 / 忌（翻到 2026 年 10 月，国庆节放假、10 月 10 日补班）
  const hop = (2026 - nowD.getFullYear()) * 12 + (9 - nowD.getMonth());
  for (let i = 0; i < Math.abs(hop); i++) await ev(click(hop > 0 ? "calendar-next" : "calendar-prev"));
  await sleep(200);
  const cell = d => `document.querySelector('.cal-cell[data-date="2026-10-${d}"]')`;
  const hover = (d, on = true) => ev(`${cell(d)}.dispatchEvent(new MouseEvent('${on ? "mouseover" : "mouseout"}', { bubbles: true, relatedTarget: null }))`);
  ok("节日显示在日历格子里，放假标「休」、补班标「班」", await ev(`${cell("01")}.querySelector('.cal-lunar').innerText === '国庆节' && ${cell("01")}.querySelector('.cal-badge.off')?.innerText === '休' && ${cell("10")}.querySelector('.cal-badge.work')?.innerText === '班' && !${cell("20")}.querySelector('.cal-badge')`));
  ok("没停留时没有黄历卡片", await ev(`!document.querySelector('[data-testid="day-card"]')`));
  await hover("01");
  await until(`document.querySelector('[data-testid="day-card"]')`);
  ok("停在国庆节上：卡片有日期、农历、放假、节日、宜和忌", await ev(`(() => { const c = document.querySelector('[data-testid="day-card"]'); const t = c.innerText; return t.includes('10月1日 星期四') && t.includes('农历') && t.includes('国庆节 · 放假') && c.querySelector('[data-testid="day-card-yi"] .dc-v').innerText.trim().length > 0 && c.querySelector('[data-testid="day-card-ji"] .dc-v').innerText.trim().length > 0; })()`));
  await shot("0-home-daycard");
  await hover("01", false);
  await until(`!document.querySelector('[data-testid="day-card"]')`);
  await hover("10");
  await until(`document.querySelector('[data-testid="day-card"]')`);
  ok("补班那天卡片写明「调休补班」", await ev(`document.querySelector('[data-testid="day-card-tags"]').innerText.includes('调休补班')`));
  await hover("10", false);
  await ev(click("calendar-today"));
  // 更改城市（比如挂了代理，IP 城市不对）
  await ev(click("weather-city"));
  await until(`document.querySelector('[data-testid="weather-city-input"]')`);
  await ev(setVal('[data-testid="weather-city-input"]', "广州", "HTMLInputElement", "input"));
  await ev(`document.querySelector('[data-testid="weather-city-input"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`);
  await until(`document.querySelector('[data-testid="home-weather"]').innerText.includes('广州') && document.querySelector('[data-testid="home-weather"]').innerText.includes('26°')`);
  ok("可以手动指定城市", (await ev(`localStorage.getItem('harness.home.city')`)) === "广州");
  await ev(clickText(".link-btn", "恢复 IP 定位"));
  await until(`document.querySelector('[data-testid="home-weather"]').innerText.includes('北京')`);
  ok("可以恢复 IP 定位", (await ev(`localStorage.getItem('harness.home.city')`)) === null);
  ok("一进来首页铺满整个窗口，侧边栏不占位", await ev(`!document.querySelector('.nav') && document.querySelector('[data-testid="home"]').getBoundingClientRect().left < 2`));
  // 只有对话页有侧边栏：点新建对话进去，在对话页里测宽度、折叠
  await ev(click("new-chat"));
  await until(`document.querySelector('.nav')`);
  // 侧边栏宽度可拖动，范围受限，双击恢复，并记住
  const navW = () => ev(`document.querySelector('.nav').getBoundingClientRect().width`);
  const dragNav = async toX => {
    const r = await ev(`(() => { const b = document.querySelector('[data-testid="nav-resizer"]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + 100 }; })()`);
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y });
    await cdp("Input.dispatchMouseEvent", { type: "mousePressed", x: r.x, y: r.y, button: "left", clickCount: 1 });
    await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: toX, y: r.y, button: "left" });
    await cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x: toX, y: r.y, button: "left", clickCount: 1 });
  };
  ok("侧边栏默认 260 宽", Math.abs((await navW()) - 260) < 2);
  await dragNav(340);
  await sleep(450);
  ok("拖动后侧边栏变宽并记住", Math.abs((await navW()) - 340) < 3 && (await ev(`localStorage.getItem('harness.nav.w')`)) === "340");
  await dragNav(20);
  await sleep(450);
  ok("宽度有下限", Math.abs((await navW()) - 180) < 2);
  await dragNav(900);
  await sleep(450);
  ok("宽度有上限", Math.abs((await navW()) - 480) < 2);
  await ev(`document.querySelector('[data-testid="nav-resizer"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(450);
  ok("双击恢复默认宽度", Math.abs((await navW()) - 260) < 2 && (await ev(`localStorage.getItem('harness.nav.w')`)) === null);
  await dragNav(300);
  await sleep(450);
  ok("首页入口是左上角的图标和名字，侧边栏里没有单独的「首页」", await ev(`!!document.querySelector('[data-testid="brand"] svg') && !document.querySelector('[data-testid="nav-home"]')`));
  const beforeW = await navW();
  await ev(click("nav-toggle"));
  await sleep(350);
  ok("点侧边栏上的折叠按钮：折叠成只剩图标", (await navW()) < 70 && (await ev(`document.querySelector('[data-testid="nav"]').classList.contains('collapsed')`)) === true);
  await shot("0b-nav-collapsed");
  ok("折叠状态被记住", (await ev(`localStorage.getItem('harness.nav.collapsed')`)) === "1");
  // 点左上角：回首页，首页铺满、没有侧边栏
  await ev(click("brand"));
  await until(`!document.querySelector('[data-testid="home"]').closest('[hidden]')`);
  ok("点首页后回到首页，侧边栏不再出现、首页铺满", await ev(`!document.querySelector('.nav') && document.querySelector('[data-testid="home"]').getBoundingClientRect().left < 2`));
  await ev(click("nav-workbench"));
  await until(`document.querySelector('[data-testid="workbench"]') && !document.querySelector('[data-testid="workbench"]').closest('[hidden]')`);
  ok("工作台页还没有任务时没有侧边栏，也不显示历史对话", await ev(`!document.querySelector('.nav') && !document.querySelector('[data-testid="session-item"]')`));
  await ev(click("new-chat"));
  await until(`document.querySelector('.nav')`);
  ok("回到对话页侧边栏还是折叠的", (await navW()) < 70);
  await ev(click("nav-toggle"));
  await sleep(350);
  ok("展开后记住", Math.abs((await navW()) - beforeW) < 3 && (await ev(`localStorage.getItem('harness.nav.collapsed')`)) === "0");
  // 清掉上面为了出现侧边栏而新建的空对话，重新进来（侧边栏回到隐藏）
  await sleep(600);
  await ev(`(() => { localStorage.removeItem('harness.sessions.v1'); location.reload(); return true; })()`);
  await until("document.querySelector('[data-testid=\"brand\"]')", 30000);
  await sleep(500);
  // 工作台
  await ev(click("nav-workbench"));
  await until(`document.querySelector('[data-testid="workbench"]') && !document.querySelector('[data-testid="workbench"]').closest('[hidden]')`);
  ok("侧边栏「工作台」进入工作台页", true);
  await until(`document.querySelector('[data-testid="wb-off"]')`);
  ok("没接入飞书项目 / 钉钉时只提示一次去设置，不展示排期", await ev(`document.querySelectorAll('[data-testid="wb-off"]').length === 1 && !document.querySelector('[data-testid="gantt"]')`));
  ok("工作台有统计和我的排期，没有最近对话 / 代码仓库 / 快捷动作这几块", await ev(`['wb-stat-todo','wb-stat-running','wb-stat-repo','wb-schedule'].every(i => !!document.querySelector('[data-testid="' + i + '"]')) && ['wb-recent','wb-repos','wb-actions'].every(i => !document.querySelector('[data-testid="' + i + '"]'))`));
  await shot("0c-workbench");
  const nItems = `document.querySelectorAll('[data-testid="session-item"]').length`;
  ok("还没点新建对话时，没有任何对话", (await ev(nItems)) === 0);
  await ev(click("new-chat"));
  await until(`document.querySelector('[data-testid="workbench"]').closest('[hidden]')`);
  ok("点新建对话进入对话页", true);
  ok("对话按工作区分组，分组标题是文件夹名", await ev(`(() => { const h = document.querySelector('[data-testid="session-group-head"]'); return !!h && h.querySelector('.sess-group-name').innerText.length > 0 && !!document.querySelector('[data-testid="session-group"] [data-testid="session-item"]'); })()`));
  ok("点一次新建对话，侧边栏立刻多一个选中的「新对话」", (await ev(nItems)) === 1 && (await ev(`document.querySelector('[data-testid="session-item"]').classList.contains('active') && document.querySelector('[data-testid="session-item"] .session-title').innerText === '新对话'`)));
  await shot("1-empty");

  // 1) 回声 + 过程面板
  await send("你好 harness");
  await waitDone("【echo】你好 harness");
  ok("对话能收到模型的回复", true);
  await until("document.querySelector('[data-testid=\"open-process\"]')");
  await ev(click("open-process"));
  ok("展开后有步骤详情", await until("document.querySelectorAll('.detail-box .step').length >= 1").catch(() => false));
  ok("会话出现在侧边栏", (await ev("document.querySelectorAll('[data-testid=\"session-item\"]').length")) === 1);
  ok("对话条目带图标和相对时间（如「刚刚」）", await ev(`(() => { const s = document.querySelector('[data-testid="session-item"]'); return !!s.querySelector('svg, .spinner') && /刚刚|分钟前|小时前|天前/.test(s.innerText); })()`));
  await ev(click("session-group-head"));
  ok("点分组标题可以折叠", (await ev("document.querySelectorAll('[data-testid=\"session-item\"]').length")) === 0);
  await ev(click("session-group-head"));
  ok("再点展开", (await ev("document.querySelectorAll('[data-testid=\"session-item\"]').length")) === 1);
  ok("发送后这条对话的标题变成第一句话", (await ev(`document.querySelector('[data-testid="session-item"] .session-title').innerText`)).includes("你好 harness"));
  await ev(click("new-chat"));
  await until(`document.querySelectorAll('[data-testid="session-item"]').length === 2`);
  ok("每点一次新建对话就多一个，原对话仍在列表里", (await ev(nItems)) === 2);
  await ev(click("new-chat"));
  await until(`document.querySelectorAll('[data-testid="session-item"]').length === 3`);
  ok("连点也是每次多一个，对话页是空的新对话", (await ev(nItems)) === 3 && (await ev(`!document.querySelector('[data-testid="msg-assistant"]')`)));
  await ev(`document.querySelectorAll('[data-testid="session-item"]')[2].click()`);
  await sleep(200);
  ok("点回原对话，内容还在", await ev(`!!document.querySelector('[data-testid="msg-assistant"]')`));
  await shot("2-chat-reply");

  // AI 助手面板：右上角机器人按钮 / Ctrl+Alt+I；对话独立于主对话列表
  ok("右上角有 AI 助手按钮", await ev(`!!document.querySelector('.titlebar [data-testid="nav-assistant"]')`));
  await ev(click("nav-assistant"));
  await until(`document.querySelector('[data-testid="assistant-panel"]')`);
  ok("点击后打开右侧助手面板，显示空状态", await ev(`!!document.querySelector('[data-testid="assistant-empty"]') && !!document.querySelector('[data-testid="assistant-quick"]')`));
  await shot("2a-assistant-empty");
  await ev(setVal('[data-testid="assistant-input"]', "你好助手", "HTMLTextAreaElement", "input"));
  await ev(click("assistant-send"));
  await until(`document.querySelector('[data-testid="assistant-panel"] [data-testid="msg-assistant"][data-status="done"]')`);
  ok("助手能对话", (await ev(`document.querySelector('[data-testid="assistant-panel"] [data-testid="msg-assistant"]').textContent`)).includes("【echo】你好助手"));
  ok("助手对话不进主对话列表", (await ev(nItems)) === 3);
  await sleep(700);
  ok("助手默认可读数据目录（工作区为数据目录）", JSON.parse(await ev(`localStorage.getItem('harness.assistant.v1')`))[0].workspace === home);
  await shot("2b-assistant-chat");
  await ev(click("assistant-wide"));
  ok("可以展开加宽", (await ev(`document.querySelector('[data-testid="assistant-panel"]').offsetWidth`)) > 500);
  await ev(click("assistant-wide"));
  await ev(click("assistant-new"));
  await until(`document.querySelector('[data-testid="assistant-empty"]')`);
  await ev(click("assistant-history"));
  await until(`document.querySelector('[data-testid="assistant-history-item"]')`);
  ok("历史里能找到刚才的对话", (await ev(`document.querySelector('[data-testid="assistant-history-menu"]').innerText`)).includes("你好助手"));
  await ev(`document.querySelector('[data-testid="assistant-history-item"]').click()`);
  await until(`document.querySelector('[data-testid="assistant-panel"] [data-testid="msg-assistant"]')`);
  await ev(click("assistant-delete"));
  await until(`document.querySelector('[data-testid="assistant-empty"]')`);
  await sleep(700);
  ok("删除当前助手对话", JSON.parse(await ev(`localStorage.getItem('harness.assistant.v1')`) || "[]").length === 0);
  await ev(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'i', ctrlKey: true, altKey: true, bubbles: true }))`);
  await until(`!document.querySelector('[data-testid="assistant-panel"]')`);
  ok("Ctrl+Alt+I 可以收起面板", true);
  await ev(click("nav-assistant"));
  await until(`document.querySelector('[data-testid="assistant-panel"]')`);
  await ev(click("assistant-close"));
  await until(`!document.querySelector('[data-testid="assistant-panel"]')`);
  ok("可以关闭助手面板", true);

  // 模型选择器：缺 Key 的 provider 标记为不可用
  await ev(click("provider-trigger"));
  await until("document.querySelector('[data-testid=\"provider-nokey\"]')");
  ok("缺 Key 的 provider 不可选", await ev("document.querySelector('[data-testid=\"provider-nokey\"]').disabled === true"));
  await shot("3-picker");
  await ev(click("provider-fake"));

  // 2) 工具审批流（顺带验证输入框：顶部工作区 / 工具、底部模型；对话级模型与工具开关）
  await newChat();
  const q = sel => `document.querySelector('[data-testid="${sel}"]')`;
  ok("输入框顶部有工作区与工具", await ev(`!!document.querySelector('.composer-top [data-testid="workspace-trigger"]') && !!document.querySelector('.composer-top [data-testid="tools-trigger"]')`));
  ok("输入框是大输入框", (await ev(`${q("composer-input")}.offsetHeight`)) >= 90);
  await until(`/^[1-9]\\d*\\/\\d+$/.test(${q("tools-count")}.textContent)`);
  const cnt0 = await ev(`${q("tools-count")}.textContent`);
  const [on0, total0] = cnt0.split("/").map(Number);
  ok("工具数显示为 N/N", on0 === total0);
  await ev(click("tools-trigger"));
  await until(`document.querySelector('[data-testid="tool-http_request"] input')`);
  await ev(`document.querySelector('[data-testid="tool-http_request"] input').click()`);
  await ev(click("tools-trigger"));
  ok("关闭一个工具后计数变为 N-1/N", (await ev(`${q("tools-count")}.textContent`)) === `${on0 - 1}/${total0}`);
  await ev(click("model-trigger"));
  await until(`${q("model-alpha-1")}`);
  await shot("3b-model-menu");
  await ev(click("model-alpha-1"));
  await until(`${q("model-trigger")}.textContent.includes('alpha-1')`);
  ok("对话里可临时换模型", true);
  await shot("3c-composer");
  await send("写一个 hello.txt");
  await until("document.querySelector('[data-testid=\"approval-modal\"]')");
  ok("write_file 触发审批弹窗", (await ev("document.querySelector('[data-testid=\"approval-modal\"]').textContent")).includes("write_file"));
  ok("审批前文件未被写入", !fs.existsSync(path.join(home, "hello.txt")));
  await shot("4-approval");
  await ev(click("approval-allow"));
  await waitDone("已写入");
  ok("本次请求使用了选中的模型、且不含被关掉的工具", lastChat.model === "alpha-1" && !lastChat.tools.includes("http_request") && lastChat.tools.includes("write_file"));
  ok("审批通过后文件写入沙箱", fs.existsSync(path.join(home, "hello.txt")) && fs.readFileSync(path.join(home, "hello.txt"), "utf8") === "hi from agent");
  ok("工具调用内联在回复里", (await ev("document.querySelectorAll('.msg-a .tool').length")) >= 1);
  await shot("5-tool-done");

  // 3) 拒绝审批
  fs.rmSync(path.join(home, "hello.txt"));
  await newChat();
  await send("再写一次");
  await until("document.querySelector('[data-testid=\"approval-modal\"]')");
  await ev(click("approval-deny"));
  await waitDone("已写入");
  ok("拒绝审批后文件不会生成", !fs.existsSync(path.join(home, "hello.txt")));

  // 4) 回放页
  await ev(click("nav-replay"));
  await until("document.querySelectorAll('[data-testid=\"trace-item\"]').length >= 3");
  await ev("document.querySelector('[data-testid=\"trace-item\"]').click()");
  await until("document.querySelectorAll('.detailpane .step').length >= 1");
  ok("回放页列出历史并展示步骤", true);
  await shot("6-replay");

  // 5) 设置页：非法配置被拒
  await ev(click("nav-settings"));
  await until("document.querySelector('[data-testid=\"settings-office\"]')");
  ok("设置里没有配置文件入口，办公通道/项目管理合并为办公集成", await ev("!document.querySelector('[data-testid=\"settings-config\"]') && !document.querySelector('[data-testid=\"settings-channels\"]') && !document.querySelector('[data-testid=\"settings-projects\"]')"));
  await until("document.querySelector('[data-testid=\"model-select\"]')");
  ok("模型是下拉框，默认选中全局使用的提供方", (await ev("document.querySelector('[data-testid=\"model-select\"]').value")) === "echo");
  ok("选中后只展示该提供方的卡片", (await ev("document.querySelectorAll('.pcard[data-testid^=\"provider-card-\"]').length")) === 1);
  ok("自定义提供方有独立的新增入口", await ev("!!document.querySelector('[data-testid=\"provider-add\"]')"));
  await ev(setVal('[data-testid="model-select"]', "nokey", "HTMLSelectElement", "change"));
  await until("document.querySelector('[data-testid=\"provider-card-nokey\"]')");
  await shot("7a-settings-models");
  ok(
    "设置页内容可以滚动",
    await ev(`(() => { const b = document.querySelector('.settings-body'); b.scrollTop = 99999; return b.scrollHeight > b.clientHeight && b.scrollTop > 0 && document.documentElement.scrollHeight <= window.innerHeight + 1; })()`),
  );
  await ev("document.querySelector('.settings-body').scrollTop = 0");
  // 填写 Key 后自动校验：加载模型下拉框 + 显示账号信息（不需要点任何按钮）
  await ev(setVal('[data-testid="model-select"]', "fake", "HTMLSelectElement", "change"));
  await until("document.querySelector('[data-testid=\"provider-card-fake\"]')");
  await ev(setVal('[data-testid="provider-card-fake"] input[type="password"]', "sk-bad-key-000", "HTMLInputElement", "input"));
  await until(`document.querySelector('[data-testid="provider-card-fake"] .keyinfo.bad')`);
  ok("Key 无效时给出提示", (await ev(`document.querySelector('[data-testid="provider-card-fake"] .keyinfo.bad').textContent`)).includes("无效"));
  await ev(setVal('[data-testid="provider-card-fake"] input[type="password"]', "sk-fake-12345", "HTMLInputElement", "input"));
  await until(`document.querySelector('[data-testid="provider-card-fake"] select[data-testid^="model-pick-"]')`);
  ok(
    "填写 Key 后自动加载模型并变为下拉框",
    JSON.stringify(await ev(`[...document.querySelectorAll('[data-testid="provider-card-fake"] select[data-testid^="model-pick-"] option')].map(o => o.value)`)) === JSON.stringify(["m", "alpha-1", "beta-2"]),
  );
  ok("自动显示 Key 校验/账号信息", (await ev(`document.querySelector('[data-testid="provider-card-fake"] .keyinfo').textContent`)).includes("Key 有效"));
  await shot("7a2-settings-keyinfo");
  await ev(setVal('[data-testid="provider-card-fake"] select[data-testid^="model-pick-"]', "beta-2", "HTMLSelectElement", "change"));
  await until(`!document.querySelector('[data-testid="provider-save-fake"]').disabled`);
  await ev(click("provider-save-fake"));
  await until(`document.querySelector('[data-testid="provider-card-fake"] .chip.run')`);
  ok("选中的模型写入配置", JSON.parse(fs.readFileSync(path.join(home, "harness.config.json"), "utf8")).providers.fake.model === "beta-2");
  await ev(setVal('[data-testid="model-select"]', "nokey", "HTMLSelectElement", "change"));
  await until("document.querySelector('[data-testid=\"provider-card-nokey\"]')");
  // 在界面里给 nokey 填 Key：写进 .env，provider 变为可用
  await ev(setVal('[data-testid="provider-card-nokey"] input[type="password"]', "sk-smoke-123", "HTMLInputElement", "input"));
  await until(`!document.querySelector('[data-testid="provider-save-nokey"]').disabled`);
  await ev(click("provider-save-nokey"));
  await until(`document.querySelector('[data-testid="provider-card-nokey"] .chip.ok')`);
  ok("保存后设为全局使用的 Agent", JSON.parse(fs.readFileSync(path.join(home, "harness.config.json"), "utf8")).defaultProvider === "nokey");
  ok("Key 写入 .env 且不进配置文件", fs.readFileSync(path.join(home, ".env"), "utf8").includes("NOPE_NOT_SET=sk-smoke-123") && !fs.readFileSync(path.join(home, "harness.config.json"), "utf8").includes("sk-smoke-123"));
  // 工具权限
  await ev(click("settings-safety"));
  await until("document.querySelector('[data-testid=\"policy-write\"]')");
  await ev(setVal('[data-testid="policy-write"]', "deny", "HTMLSelectElement", "change"));
  await sleep(500);
  ok("工具权限写入配置", JSON.parse(fs.readFileSync(path.join(home, "harness.config.json"), "utf8")).guard?.policy?.write === "deny");
  await shot("7b-settings-safety");
  await ev(click("settings-general"));
  await sleep(200);
  await shot("7c-settings-general");
  // 字体：自定义界面字体 / 代码字体后立刻作用于整个应用，并持久化
  await ev(setVal('[data-testid="font-ui"]', "Georgia", "HTMLInputElement", "input"));
  await ev(setVal('[data-testid="font-mono"]', "Courier New", "HTMLInputElement", "input"));
  await sleep(200);
  ok("自定义界面字体实时生效", (await ev("getComputedStyle(document.body).fontFamily")).startsWith("Georgia"));
  ok("自定义代码字体实时生效", (await ev("getComputedStyle(document.documentElement).getPropertyValue('--mono')")).includes("Courier New"));
  ok("字体偏好持久化", (await ev("localStorage.getItem('harness.font.v1')")).includes("Georgia"));
  await shot("7d-font-custom");
  await ev(`document.querySelector('[data-testid="font-zoom"] button:last-child').click()`);
  await sleep(300);
  ok("界面缩放生效", (await ev("window.devicePixelRatio")) !== undefined && (await ev("localStorage.getItem('harness.font.v1')")).includes('"zoom":150'));
  await ev(`document.querySelector('[data-testid="font-zoom"] button:nth-child(2)').click()`);
  await ev(setVal('[data-testid="font-ui"]', "", "HTMLInputElement", "input"));
  await ev(setVal('[data-testid="font-mono"]', "", "HTMLInputElement", "input"));
  await sleep(200);
  ok("清空后恢复默认字体", !(await ev("getComputedStyle(document.body).fontFamily")).includes("Georgia"));
  await shot("7-settings");

  // 代码仓库页：显示分支与未提交改动；一键在新对话中使用
  await ev(click("settings-repos"));
  await until("document.querySelector('[data-testid=\"repo-card-demo\"] .chip')");
  await sleep(500);
  const repoText = await ev("document.querySelector('[data-testid=\"repo-card-demo\"]').innerText");
  ok("仓库卡片显示分支与未提交改动", repoText.includes("main") && repoText.includes("1 处未提交") && repoText.includes("init demo"));
  await shot("8a-repos");
  // 托管平台：下拉选 GitLab → 填令牌 → 自动校验显示账号 → 保存到 .env，实例地址进配置
  ok("托管平台是下拉框", await ev("document.querySelector('[data-testid=\"host-select\"]')?.tagName === 'SELECT'"));
  await ev(setVal('[data-testid="host-select"]', "gitlab", "HTMLSelectElement", "change"));
  await sleep(300);
  ok("令牌框标题随平台变化", (await ev("document.querySelector('[data-testid=\"git-hosts\"]').innerText")).includes("GitLab Token"));
  await ev(setVal('[data-testid="git-hosts"] input.mono:not([type="password"])', `http://127.0.0.1:${LLM_PORT}`, "HTMLInputElement", "input"));
  await ev(setVal('[data-testid="git-hosts"] input[type="password"]', "glpat-bad-token-0", "HTMLInputElement", "input"));
  await until(`document.querySelector('[data-testid="host-info"].bad')`);
  ok("令牌无效时给出提示", true);
  await ev(setVal('[data-testid="git-hosts"] input[type="password"]', "glpat-smoke-token-1", "HTMLInputElement", "input"));
  await until(`document.querySelector('[data-testid="host-info"]') && !document.querySelector('[data-testid="host-info"].bad') && !document.querySelector('[data-testid="host-info"].loading')`);
  ok("自动显示令牌所属账号", (await ev(`document.querySelector('[data-testid="host-info"]').innerText`)).includes("Smoke User"));
  await shot("8a2-repos-host");
  await ev(click("host-save"));
  await until(`document.querySelector('[data-testid="git-hosts"] .inline-ok')`);
  ok("令牌写入 .env 且不进配置文件", fs.readFileSync(path.join(home, ".env"), "utf8").includes("GITLAB_TOKEN=glpat-smoke-token-1") && !fs.readFileSync(path.join(home, "harness.config.json"), "utf8").includes("glpat-smoke"));
  ok("实例地址写入配置", JSON.parse(fs.readFileSync(path.join(home, "harness.config.json"), "utf8")).gitHosts?.gitlab?.baseURL === `http://127.0.0.1:${LLM_PORT}`);
  // 分支约定：基线 / 提测 / 联调，带清空按钮，候选来自仓库已有分支
  ok("仓库卡片有三个分支输入框", (await ev("document.querySelectorAll('[data-testid=\"repo-branches-demo\"] input.mono').length")) === 3);
  ok("分支候选来自仓库", (await ev("[...document.querySelectorAll('#branches-demo option')].map(o => o.value).join(',')")) === "main");
  await ev(setVal('[data-testid="branch-test-demo"]', "test/1.30.1", "HTMLInputElement", "input"));
  await ev(setVal('[data-testid="branch-integration-demo"]', "master", "HTMLInputElement", "input"));
  await until(`document.querySelector('[data-testid="branch-save-demo"]')`);
  await shot("8a3-repo-branches");
  await ev(click("branch-save-demo"));
  await until(`!document.querySelector('[data-testid="branch-save-demo"]')`);
  const br = JSON.parse(fs.readFileSync(path.join(home, "harness.config.json"), "utf8")).repos.demo.branches;
  ok("分支设置写入配置", br?.test === "test/1.30.1" && br?.integration === "master" && br?.base === undefined);
  await ev(`document.querySelector('[data-testid="repo-branches-demo"] .clear-btn').click()`);
  await until(`document.querySelector('[data-testid="branch-save-demo"]')`);
  await ev(click("branch-save-demo"));
  await until(`!document.querySelector('[data-testid="branch-save-demo"]')`);
  ok("清空后从配置中移除", JSON.parse(fs.readFileSync(path.join(home, "harness.config.json"), "utf8")).repos.demo.branches?.test === undefined);
  await ev(click("repo-use-demo"));
  await until("document.querySelector('[data-testid=\"workspace-trigger\"]')");
  ok("在新对话中使用后，工作区显示为仓库名", (await ev("document.querySelector('[data-testid=\"workspace-trigger\"]').innerText")).includes("demo"));
  await ev(click("nav-settings"));
  await until("document.querySelector('[data-testid=\"settings-office\"]')");

  // 6) 办公集成：飞书（集成 + 消息通道 + 项目管理）与钉钉合在一页
  await ev(click("settings-office"));
  await until("document.querySelector('[data-testid=\"office-page\"]')");
  ok("办公集成页有飞书消息通道卡片", await ev("!!document.querySelector('[data-testid=\"feishu-channel-card\"]')"));
  ok("办公集成页有飞书项目卡片", await ev("!!document.querySelector('[data-testid=\"feishu-project-card\"]')"));
  ok("未启用消息通道时没有启动按钮", await ev("!document.querySelector('[data-testid=\"channel-toggle\"]')"));
  await until("(document.querySelector('[data-testid=\"int-lark\"]')?.innerText ?? '').match(/v\\d|未安装|未登录/)");
  ok("有飞书集成卡片（版本 / 登录状态）", await ev("!!document.querySelector('[data-testid=\"feishu-integration\"]') && !!document.querySelector('[data-testid=\"int-check-update\"]')"));
  ok("有钉钉集成卡片", await ev("!!document.querySelector('[data-testid=\"dingtalk-integration\"]')"));
  await until("(document.querySelector('[data-testid=\"int-dws\"]')?.innerText ?? '').match(/v\\d|未安装|未登录/)");
  await shot("8-office");
  // 消息通道：在界面里打开开关，配置里出现 channels.larkCli，不再需要手写 JSON
  await ev(click("channel-switch"));
  await until("document.querySelector('[data-testid=\"channel-toggle\"]')");
  ok("界面里启用消息通道后写入配置", !!JSON.parse(fs.readFileSync(path.join(home, "harness.config.json"), "utf8")).channels?.larkCli);
  await ev(setVal('[data-testid="allow-input"]', "ou_abc123", "HTMLInputElement", "input"));
  await ev(click("allow-add"));
  await until(`document.querySelector('[data-testid="allow-users"] code')`);
  ok("允许用户写入配置", JSON.parse(fs.readFileSync(path.join(home, "harness.config.json"), "utf8")).channels?.larkCli?.allowUsers?.[0] === "ou_abc123");
  await shot("8-office-channel");
  ok("办公集成页有钉钉项目管理卡片", await ev("!!document.querySelector('[data-testid=\"dingtalk-project-card\"]')"));
  await ev(click("dingtalk-project-switch"));
  await until("document.querySelector('[data-testid=\"dingtalk-project-write\"]')");
  ok("启用钉钉项目管理后写入配置", !!JSON.parse(fs.readFileSync(path.join(home, "harness.config.json"), "utf8")).integrations?.dingtalkProject);
  await ev(click("dingtalk-project-switch"));
  // 飞书项目：打开开关，配置里出现 integrations.feishuProject
  await ev(click("feishu-project-switch"));
  await until("document.querySelector('[data-testid=\"feishu-project-write\"]')");
  ok("启用飞书项目后写入配置", !!JSON.parse(fs.readFileSync(path.join(home, "harness.config.json"), "utf8")).integrations?.feishuProject);
  await shot("8b-office-project");
  // 飞书集成：meegle 版本 / 登录；已登录时可选默认空间（依赖本机真实 meegle 登录态，未登录则跳过）
  await until("(document.querySelector('[data-testid=\"int-meegle\"]')?.innerText ?? '').match(/v\\d|未安装|未登录/)");
  const meegleText = await ev("document.querySelector('[data-testid=\"int-meegle\"]').innerText");
  ok("飞书集成显示 meegle 版本与登录状态", /v\d+\.\d+/.test(meegleText) || /未安装|未登录/.test(meegleText));
  if (/已登录/.test(meegleText)) {
    await until("document.querySelectorAll('[data-testid=\"default-space\"] option').length > 1");
    const firstKey = await ev("document.querySelectorAll('[data-testid=\"default-space\"] option')[1].value");
    await ev(setVal('[data-testid="default-space"]', firstKey, "HTMLSelectElement", "change"));
    await sleep(600);
    ok("默认空间写入配置", JSON.parse(fs.readFileSync(path.join(home, "harness.config.json"), "utf8")).integrations?.feishuProject?.defaultSpace?.key === firstKey);
  }

  // 7) 规则 / 技能 / MCP / 动作
  const readCfg = () => JSON.parse(fs.readFileSync(path.join(home, "harness.config.json"), "utf8"));
  const typeInto = async (tid, value, proto = "HTMLTextAreaElement") => {
    await ev(`document.querySelector('[data-testid="${tid}"]').focus()`);
    await ev(setVal(`[data-testid="${tid}"]`, value, proto, "input"));
    await ev(`document.querySelector('[data-testid="${tid}"]').blur()`);
    await sleep(500);
  };
  const openPlugin = async k => {
    if (!(await ev(`!!document.querySelector('[data-testid="settings-${k}"]')`))) await ev(click("nav-settings"));
    await until(`document.querySelector('[data-testid="settings-${k}"]')`);
    await ev(click("settings-" + k));
  };
  await ev(click("nav-plugins"));
  await until(`document.querySelector('[data-testid="plugins-page"]')`);
  ok("标题栏有新建对话 / 工作台 / 插件中心；插件中心有 插件商店 / 已安装 / 设置", await ev(`['new-chat','nav-workbench','nav-plugins'].every(i => !!document.querySelector('.titlebar [data-testid="' + i + '"]')) && ['store','installed','settings'].every(k => !!document.querySelector('[data-testid="plugin-tab-' + k + '"]'))`));
  await until(`document.querySelectorAll('[data-testid="plugin-card"]').length === 2`, 20000);
  ok("插件商店只有 DBX 插件（含名称、作者、标签、安装按钮），没有技能 / MCP / 规则 / 动作", await ev(`(() => { const cs = [...document.querySelectorAll('[data-testid="plugin-card"]')]; return cs.every(c => c.dataset.key.startsWith('DBX 插件中心:') && !!c.querySelector('.px-name') && !!c.querySelector('.px-by') && !!c.querySelector('[data-testid="plugin-install"], [data-testid="plugin-nopkg"]')) && !document.querySelector('[data-testid="plugin-kind"]') && !document.querySelector('[data-testid="plugin-batch"]'); })()`));
  await ev(click("plugin-tab-settings"));
  await until(`document.querySelector('[data-testid="plugin-settings"]')`);
  ok("插件中心的设置里是本机 DBX / AI 桥接 / 插件目录，不再有技能 MCP 规则动作", await ev(`['dbx-status','dbx-bridge','dbx-catalog'].every(k => !!document.querySelector('[data-testid="' + k + '"]')) && !document.querySelector('[data-testid="plugin-dev-toggle"]') && !document.querySelector('[data-testid="plugin-sub-skills"]')`));
  await ev(click("plugin-tab-store"));
  await until(`document.querySelector('[data-testid="plugin-search"]')`);
  await shot("0d-plugin-store");
  const nCards = `document.querySelectorAll('[data-testid="plugin-card"]').length`;
  await ev(setVal('[data-testid="plugin-search"]', "终端", "HTMLInputElement", "input"));
  await sleep(200);
  ok("搜索只留下匹配的插件", (await ev(nCards)) === 1);
  await ev(setVal('[data-testid="plugin-search"]', "", "HTMLInputElement", "input"));
  await ev(click("plugin-view-list"));
  await sleep(150);
  ok("可以切换成列表视图", await ev(`!!document.querySelector('.px-list.list')`));
  await ev(click("plugin-view-grid"));
  // 技能 / MCP / 规则 / 动作不是插件：回到设置里
  await ev(click("nav-settings"));
  await until(`document.querySelector('[data-testid="settings-skills"]')`);
  ok("设置里有 技能 / MCP / 规则 / 动作，侧边栏里没有新建对话 / 工作台", await ev(`['skills','mcp','rules','actions'].every(k => !!document.querySelector('[data-testid="settings-' + k + '"]')) && !document.querySelector('.nav [data-testid="new-chat"]') && !document.querySelector('.nav [data-testid="nav-workbench"]')`));
  for (const k of ["skills", "mcp", "rules", "actions"]) {
    await ev(click("settings-" + k));
    await sleep(150);
  }
  await ev(click("settings-skills"));
  await sleep(300);
  await shot("0l-settings-skills");
  await ev(click("settings-actions"));
  ok("设置里的 技能 / MCP / 规则 / 动作 页面都能打开", await ev(`!document.querySelector('[data-testid="config-error"]') && document.querySelector('[data-testid="settings-title"]').innerText === 'ACTIONS'`));

  fs.writeFileSync(path.join(home, "AGENTS.md"), "项目约定：回复末尾加一句【收到】", "utf8");
  fs.writeFileSync(path.join(demoRepo, "AGENTS.md"), "项目约定：回复末尾加一句【收到】", "utf8"); // 对话的工作区是 demo 仓库
  await openPlugin("rules");
  await until(`document.querySelector('[data-testid="rule-add"]')`);
  await until(`document.querySelectorAll('[data-testid="rule-file"]').length >= 1`);
  ok("规则页识别到工作区里的 AGENTS.md", (await ev(`document.querySelector('[data-testid="rule-file"]').innerText`)).includes("AGENTS.md"));
  await ev(click("rule-add"));
  await until(`document.querySelector('[data-testid="rule-content"]')`);
  await typeInto("rule-content", "回复一律使用中文");
  ok("规则写入配置", readCfg().rules?.items?.[0]?.content === "回复一律使用中文");
  await shot("9a-rules");

  await openPlugin("skills");
  await until(`document.querySelector('[data-testid="skill-add"]')`);
  await ev(click("skill-add"));
  await until(`document.querySelector('[data-testid="skill-form"]')`);
  await ev(setVal('[data-testid="skill-name"]', "review", "HTMLInputElement", "input"));
  await ev(setVal('[data-testid="skill-desc"]', "代码审查", "HTMLInputElement", "input"));
  await ev(setVal('[data-testid="skill-content"]', "先看改动范围", "HTMLTextAreaElement", "input"));
  await until(`!document.querySelector('[data-testid="skill-save"]').disabled`);
  await ev(click("skill-save"));
  await until(`document.querySelector('[data-testid="skill-review"]')`);
  ok("新建的技能写成 SKILL.md", fs.readFileSync(path.join(home, "skills", "review", "SKILL.md"), "utf8").includes("先看改动范围"));
  ok("应用内新建的技能可编辑 / 删除", await ev(`!!document.querySelector('[data-testid="skill-review"] [data-testid="skill-edit"]') && !!document.querySelector('[data-testid="skill-review"] [data-testid="skill-delete"]')`));
  const skillSwitch = `document.querySelector('[data-testid="skill-review"] [data-testid="skill-switch"]')`;
  await ev(`${skillSwitch}.click()`);
  await sleep(600);
  ok("停用技能写入配置", readCfg().skills?.disabled?.includes("review") === true);
  await ev(`${skillSwitch}.click()`);
  await sleep(600);
  ok("重新启用技能", !readCfg().skills?.disabled?.includes("review"));
  await ev(click("skill-user-dirs"));
  await sleep(600);
  ok("可以关闭扫描用户目录（测试里关掉，避免带入本机真实技能）", readCfg().skills?.scanUserDirs === false);
  await shot("9b-skills");

  await openPlugin("mcp");
  await until(`document.querySelector('[data-testid="mcp-import-btn"]')`);
  await ev(click("mcp-import-btn"));
  await until(`document.querySelector('[data-testid="mcp-import-text"]')`);
  const mcpJson = JSON.stringify({ mcpServers: { smoke: { command: "node", args: [path.join(root, "test", "fixtures", "mcp-echo.mjs")] } } });
  await ev(setVal('[data-testid="mcp-import-text"]', mcpJson, "HTMLTextAreaElement", "input"));
  await ev(click("mcp-import-go"));
  await until(`document.querySelector('[data-testid="mcp-smoke"]')`);
  ok("导入 mcp.json 后写入配置", readCfg().mcpServers?.smoke?.command === "node");
  await until(`document.querySelector('[data-testid="mcp-smoke"] .chip.ok')`, 60000);
  ok("MCP 服务连接成功并显示工具数", (await ev(`document.querySelector('[data-testid="mcp-smoke"] .chip.ok').innerText`)).includes("3 个工具"));
  await ev(click("mcp-tools-toggle"));
  await until(`document.querySelector('[data-testid="mcp-tool-boom"]')`);
  await shot("9c-mcp");
  await ev(click("mcp-tool-boom"));
  await sleep(600);
  ok("关闭单个 MCP 工具写入配置", readCfg().mcpServers?.smoke?.disabledTools?.includes("boom") === true);
  await ev(setVal('[data-testid="mcp-permission"]', "auto", "HTMLSelectElement", "change"));
  await sleep(600);
  ok("MCP 调用权限写入配置", readCfg().mcpServers?.smoke?.permission === "auto");
  await ev(setVal('[data-testid="mcp-permission"]', "confirm", "HTMLSelectElement", "change"));
  await sleep(400);
  // 连不上的服务：给出失败原因，不影响其他服务
  await ev(click("mcp-add"));
  await until(`document.querySelector('[data-testid="mcp-form"]')`);
  await ev(setVal('[data-testid="mcp-name"]', "broken", "HTMLInputElement", "input"));
  await ev(setVal('[data-testid="mcp-command"]', "definitely-not-a-command-xyz --flag", "HTMLInputElement", "input"));
  await ev(click("mcp-save"));
  await until(`document.querySelector('[data-testid="mcp-broken"] [data-testid="mcp-error"]')`, 30000);
  ok("MCP 连接失败时显示原因", true);
  ok("失败的服务不影响已连接的服务", await ev(`!!document.querySelector('[data-testid="mcp-smoke"] .chip.ok')`));
  await ev(`document.querySelector('[data-testid="mcp-broken"] [data-testid="mcp-delete"]').click()`);
  await sleep(600);
  ok("删除 MCP 服务", readCfg().mcpServers?.broken === undefined);

  await openPlugin("actions");
  await until(`document.querySelector('[data-testid="action-add"]')`);
  await ev(click("action-add"));
  await until(`document.querySelector('[data-testid="action-name"]')`);
  await typeInto("action-name", "写周报", "HTMLInputElement");
  await typeInto("action-prompt", "请根据以下内容写周报：{{input}}（用中文）");
  ok("动作写入配置", readCfg().actions?.[0]?.name === "写周报" && readCfg().actions[0].prompt.includes("{{input}}"));
  await shot("9d-actions");

  // 回到对话：输入 / 出现动作菜单，选中后填入模板；规则 / 技能 / MCP 工具进入下一次请求
  await newChat();
  await until(`document.querySelector('[data-testid="composer-input"]')`);
  await ev(click("provider-trigger"));
  await until(`document.querySelector('[data-testid="provider-fake"]')`);
  await ev(click("provider-fake"));
  await ev(setVal('[data-testid="composer-input"]', "/", "HTMLTextAreaElement", "input"));
  await until(`document.querySelector('[data-testid="action-menu"]')`);
  ok("输入 / 出现动作菜单", (await ev(`document.querySelector('[data-testid="action-menu"]').innerText`)).includes("写周报"));
  await shot("9e-action-menu");
  await ev(`document.querySelector('[data-testid^="action-item-"]').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await sleep(200);
  ok("选中动作后模板填入输入框", (await ev(`document.querySelector('[data-testid="composer-input"]').value`)) === "请根据以下内容写周报：（用中文）");
  ok("光标停在 {{input}} 的位置", (await ev(`document.querySelector('[data-testid="composer-input"]').selectionStart`)) === "请根据以下内容写周报：".length);
  await ev(setVal('[data-testid="composer-input"]', "你好 skills", "HTMLTextAreaElement", "input"));
  await ev(click("send"));
  // 前面把写入策略设成了拒绝，模型会反复尝试写文件直到步数用完；这里只关心第一次请求带了什么
  for (let i = 0; i < 200 && !lastChat.users?.includes("你好 skills"); i++) await sleep(100);
  if (!lastChat.users?.includes("你好 skills")) out.push("INFO 没有收到这次请求：" + JSON.stringify(lastChat.users));
  ok("请求里带上 MCP 工具（未关闭的）和 use_skill", lastChat.tools.includes("mcp__smoke__echo") && lastChat.tools.includes("mcp__smoke__danger") && lastChat.tools.includes("use_skill"));
  ok("被关闭的 MCP 工具不会提供给模型", !lastChat.tools.includes("mcp__smoke__boom"));
  ok("system 里包含自定义规则、项目规则与技能目录", lastChat.system.includes("回复一律使用中文") && lastChat.system.includes("回复末尾加一句【收到】") && lastChat.system.includes("review：代码审查"));

  // 应用更新：设置里填仓库 → 检查到新版本 → 自动提示 → 稍后 / 跳过
  await ev(click("nav-settings"));
  await until(`document.querySelector('[data-testid="settings-general"]')`);
  await ev(click("settings-general"));
  await until(`document.querySelector('[data-testid="update-repo"]')`);
  ok("偏好里显示当前版本", /^v\d/.test(await ev(`document.querySelector('[data-testid="update-current"]').innerText`)));
  ok("没配仓库时标题栏没有更新按钮", await ev(`!document.querySelector('[data-testid="nav-update"]')`));
  await ev(setVal('[data-testid="update-repo"]', "acme/app", "HTMLInputElement", "input"));
  await ev(`(() => { const el = document.querySelector('[data-testid="update-repo"]'); el.focus(); el.blur(); })()`);
  await until(`document.querySelector('[data-testid="update-dialog"]')`);
  ok("发现新版本时自动弹出提示，带版本号和更新说明", await ev(`(() => { const s = document.querySelector('[data-testid="update-dialog"]').innerText; return s.includes('9.9.9') && s.includes('修复了若干问题'); })()`));
  ok("仓库写入配置", readCfg().update?.repo === "acme/app");
  await shot("12a-update-dialog");
  await ev(click("update-later"));
  await until(`!document.querySelector('[data-testid="update-dialog"]')`);
  ok("稍后：标题栏出现更新按钮", await ev(`!!document.querySelector('[data-testid="nav-update"]')`));
  await shot("12b-update-button");
  await ev(click("nav-update"));
  await until(`document.querySelector('[data-testid="update-dialog"]')`);
  await ev(click("update-skip"));
  await until(`!document.querySelector('[data-testid="update-dialog"]')`);
  ok("跳过此版本：按钮消失", await ev(`!document.querySelector('[data-testid="nav-update"]')`));
  await ev(click("update-check"));
  await until(`document.querySelector('[data-testid="nav-update"]')`);
  ok("手动检查会重新显示被跳过的版本", true);
  ok("设置里显示状态", (await ev(`document.querySelector('[data-testid="update-status"]').innerText`)).includes("9.9.9"));
  await shot("12c-update-settings");
  await ev(click("settings-back"));

  // 8) 深色主题
  const t0 = await ev("document.documentElement.dataset.theme");
  await ev(click("theme-toggle"));
  ok("主题可切换", (await ev("document.documentElement.dataset.theme")) !== t0);
  await ev(click("theme-toggle"));
  await shot("10-dark-settings");
  await ev("document.querySelectorAll('[data-testid=\"session-item\"]')[1].click()");
  await sleep(300);
  await shot("11-dark-chat");

  // 工作台「我的排期」：项目管理只接一个（飞书项目或钉钉）；用假的 meegle / dws
  const fake = path.join(home, "fake-cli.cjs");
  fs.writeFileSync(
    fake,
    `const a = process.argv.slice(2);
const sfile = require("path").join(__dirname, "defects-state.json");
const dstate = () => { try { return JSON.parse(require("fs").readFileSync(sfile, "utf8")); } catch { return []; } };
const day = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const item = (id, name, s, e, node, sub) => ({ work_item_info: { work_item_id: id, work_item_name: name, work_item_type_key: "story" }, project_key: "p1", project_name: "测试空间", node_info: { node_name: node || "", node_state_key: node ? "n_" + id : "x" }, ...(sub ? { sub_task_info: { id: sub, name: "" } } : {}), ...(s ? { schedule: { start_time: s, end_time: e } } : {}) });
if (a[0] === "mywork" && a.includes("--action=todo") && a.includes("--todo-scope=in_progress")) console.log(JSON.stringify({ list: [item(1, "飞书排期A", day(-1), day(2), "技术排期"), item(4, "飞书进行中无排期", "", "", "技术开发联调")] }));
else if (a[0] === "mywork" && a.includes("--action=todo")) console.log(JSON.stringify({ list: [item(1, "飞书排期A", day(-1), day(2), "技术排期"), item(1, "飞书排期A", day(0), day(1), "", 101), item(2, "飞书排期B", day(3), day(3)), item(3, "飞书未排期"), item(3, "飞书未排期", "", "", "", 301), item(4, "飞书进行中无排期", "", "", "技术开发联调")] }));
else if (a[0] === "mywork") console.log(JSON.stringify({ list: null, total: 0 }));
else if (a[0] === "workflow" && a[1] === "get-node") console.log(JSON.stringify({ list: [{ basic: { name: "技术排期" }, sub_tasks: [{ sub_task_id: "101", sub_task_name: "后端开发", estimate_start_date: "", estimate_end_date: "", is_finished: false, points: 1, owner: '[{"username":"u1"}]' }, { sub_task_id: "102", sub_task_name: "已做完的联调", estimate_start_date: "", estimate_end_date: "", is_finished: true, points: 0.5, owner: '[{"username":"u1"}]' }, { sub_task_id: "103", sub_task_name: "别人的子任务", is_finished: false, owner: '[{"username":"u2"}]' }, { sub_task_id: "301", sub_task_name: "写接口文档", is_finished: false, owner: '[{"username":"u1"}]' }].filter(s => (a.includes("--work-item-id=3") ? s.sub_task_id === "301" : a.includes("--work-item-id=1") && s.sub_task_id !== "301")) }], pagination: { has_more: false } }));
else if (a[0] === "user" && a[1] === "me") console.log(JSON.stringify({ name_cn: "测试用户", user_key: "u1" }));
else if (a[0] === "todo") console.log(JSON.stringify({ result: { todoCards: [{ taskId: "d1", subject: "钉钉任务甲", dueTime: Date.now() + 2 * 86400000 }, { taskId: "d2", subject: "钉钉任务乙" }] } }));
else if (a[0] === "project" && a[1] === "search") console.log(JSON.stringify({ projects: [{ name: "测试空间", project_key: "p1", simple_name: "ts" }] }));
else if (a[0] === "workitem" && a[1] === "meta-types") console.log(JSON.stringify({ list: [{ type_key: "story", name: "需求" }, { type_key: "issue", name: "缺陷" }] }));
else if (a[0] === "workitem" && a[1] === "query") {
  const F = (key, value) => ({ key, name: key, value });
  const rows = dstate().filter(x => x.status !== "CLOSED").map(x => ({ moql_field_list: [F("work_item_id", { long_value: x.id }), F("name", { string_value: x.name }), F("work_item_status", { key_label_value_list: [{ key: x.status, label: x.status }] }), F("priority", { key_label_value: { key: "p", label: "P1" } }), F("owner", { user_value: { name_cn: x.by } }), F("current_status_operator", { user_value_list: [{ name_cn: "测试用户" }] }), F("start_time", { string_value: "2026-11-09" }), F("updated_at", { string_value: "2026-11-13" })] }));
  console.log(JSON.stringify({ data: rows.length ? { "1": rows } : {} }));
}
else if (a[0] === "workflow" && a[1] === "list-state-transitions") {
  const id = Number(a.find(x => x.startsWith("--work-item-id=")).slice(15));
  const it = dstate().find(x => x.id === id);
  const t = id === 503 ? [{ id: 12, state_name: "RESOLVED", confirm_form: [{ key: "reason" }] }] : it.status === "OPEN" ? [{ id: 11, state_name: "IN PROGRESS", confirm_form: null }, { id: 12, state_name: "RESOLVED", confirm_form: null }] : [{ id: 12, state_name: "RESOLVED", confirm_form: null }, { id: 13, state_name: "CLOSED", confirm_form: null }, { id: 15, state_name: "转测试", confirm_form: null }];
  console.log(JSON.stringify({ state_key: it.status, state_name: it.status, transition: t }));
}
else if (a[0] === "workflow" && a[1] === "transition-state") {
  const id = Number(a.find(x => x.startsWith("--work-item-id=")).slice(15));
  const tid = Number(a.find(x => x.startsWith("--transition-id=")).slice(16));
  if (tid === 15) console.log(JSON.stringify({ data: null, error: { message: "error=Forbidden,message=无权流转到转测试" } }));
  else {
    const s = dstate();
    s.find(x => x.id === id).status = { 11: "IN PROGRESS", 12: "RESOLVED", 13: "CLOSED" }[tid];
    require("fs").writeFileSync(sfile, JSON.stringify(s));
    console.log("{}");
  }
}
else { console.error("unknown"); process.exit(2); }`,
  );
  const dfile = path.join(home, "defects-state.json");
  const D1 = { id: 501, name: "登录页白屏", status: "OPEN", by: "张三" };
  const D2 = { id: 502, name: "支付回调失败", status: "IN PROGRESS", by: "李四" };
  const D3 = { id: 503, name: "导出报表乱码", status: "OPEN", by: "王五" };
  fs.writeFileSync(dfile, JSON.stringify([D1, D2]));
  const cfg0 = JSON.parse(fs.readFileSync(path.join(home, "harness.config.json"), "utf8"));
  cfg0.defaultProvider = "echo";
  cfg0.integrations = { ...cfg0.integrations, dingtalk: { bin: process.execPath }, feishuProject: { bin: process.execPath, binArgs: [fake], write: false }, dingtalkProject: { binArgs: [fake], write: false } };
  await ev(`window.harness.saveConfig(${JSON.stringify(JSON.stringify(cfg0, null, 2))}).then(() => true)`);
  await ev(`location.reload()`);
  await until(`document.querySelector('[data-testid="nav-workbench"]')`, 30000);
  await sleep(500);
  // 重启后：已有历史对话，但一进来侧边栏不显示；点「新建对话」进到对话页才出现
  ok("重启后一进来侧边栏不显示历史对话", await ev(`!document.querySelector('[data-testid="session-group"]') && !document.querySelector('[data-testid="session-item"]') && !document.querySelector('.session-empty')`));
  await ev(click("new-chat"));
  await until(`document.querySelector('[data-testid="session-group"] [data-testid="session-item"]')`);
  ok("点新建对话后侧边栏出现分组和历史对话", (await ev(`document.querySelectorAll('[data-testid="session-item"]').length`)) > 1);
  // 删除对话：侧边栏少一个，工作台里的「全部对话」也同步
  const delTotal = await ev(`document.querySelectorAll('[data-testid="session-item"]').length`);
  await ev(`document.querySelector('[data-testid="session-item"].active .session-del').click()`);
  await until(`document.querySelectorAll('[data-testid="session-item"]').length === ${delTotal - 1}`);
  await ev(click("nav-workbench"));
  await until(`document.querySelector('[data-testid="workbench"]') && !document.querySelector('[data-testid="workbench"]').closest('[hidden]')`);
  ok("删除对话后，工作台的「全部对话」同步少一个", (await ev(`document.querySelectorAll('.wb-stat b')[3].innerText`)) === String(delTotal - 1));
  await ev(click("new-chat"));
  await until(`document.querySelector('.nav')`);
  await ev(click("nav-workbench"));
  await until(`document.querySelector('[data-testid="workbench"]') && !document.querySelector('[data-testid="workbench"]').closest('[hidden]')`);
  await ev(click("wb-refresh"));
  await until(`document.querySelectorAll('[data-testid="gantt-bar"]').length > 0`, 20000);
  ok("配置里同时有飞书和钉钉时只展示飞书的排期，没有来源切换", await ev(`document.querySelectorAll('[data-testid="wb-schedule"]').length === 1 && !document.querySelector('[data-testid="wb-source"]') && document.querySelector('[data-testid="wb-schedule"]').dataset.source === 'feishu' && (document.body.innerText.match(/钉钉任务/g) ?? []).length === 0`));
  ok("飞书排期按天画成条，带节点，未排期的单独列出", await ev(`(() => { const t = [...document.querySelectorAll('[data-testid="gantt-bar"]')].map(b => b.innerText); return t.length === 2 && t[0].includes('飞书排期A') && t[0].includes('技术排期') && t[1].includes('飞书排期B') && document.querySelector('[data-testid="wb-unscheduled"]').innerText.includes('飞书未排期'); })()`));
  ok("排期条跨越多天（A 比 B 宽）", await ev(`(() => { const b = [...document.querySelectorAll('[data-testid="gantt-bar"]')].map(x => x.getBoundingClientRect().width); return b[0] > b[1] * 2; })()`));
  await ev(click("gantt-bar"));
  await until(`document.querySelector('[data-testid="gantt-detail"]')`);
  ok("排期标题旁显示当前登录账号", (await ev(`document.querySelector('[data-testid="wb-user"]')?.innerText ?? ''`)).includes("测试用户"));
  ok("「进行中的需求」按需求列出（不管有没有排期），每个需求下是我负责的节点 / 子任务", await ev(`(() => { const a = [...document.querySelectorAll('[data-testid="wb-active-item"]')]; const t = a.map(x => x.innerText); return a.length === 2 && t[0].includes('飞书排期A') && t[0].includes('后端开发') && t[0].includes('技术排期') && t[1].includes('飞书进行中无排期') && t[1].includes('技术开发联调'); })()`));
  ok("节点是需求上的小标签，下面的列表只放子任务", await ev(`(() => { const it = document.querySelector('[data-testid="wb-active-item"]'); return !!it.querySelector('[data-testid="wb-node"]') && [...it.querySelectorAll('[data-testid="wb-child"]')].every(x => x.dataset.kind === 'subtask'); })()`));
  ok("子任务显示名字、负责人、人天；我名下已做完的也在，别人的子任务不在", await ev(`(() => { const r = [...document.querySelectorAll('[data-testid="wb-active-item"]')[0].querySelectorAll('[data-testid="wb-child"]')]; const t = r.map(x => x.innerText); return r.length === 2 && t[0].includes('后端开发') && t[0].includes('测试用户') && t[0].includes('1 人天') && t[1].includes('已做完的联调') && t[1].includes('0.5 人天') && !!r[1].querySelector('.sub-check.on') && !r[0].querySelector('.sub-check.on') && !document.body.innerText.includes('别人的子任务'); })()`));
  // 在本软件里填排期（只存在本机）：子任务、需求本身
  const iso = n => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
  const fillSched = async (days, a, b, d) => {
    await until(`document.querySelector('[data-testid="sched-edit"]')`);
    await ev(setVal('[data-testid="sched-start"]', iso(a), "HTMLInputElement", "change"));
    await ev(setVal('[data-testid="sched-end"]', iso(b), "HTMLInputElement", "change"));
    if (d !== undefined) await ev(setVal('[data-testid="sched-days"]', String(d), "HTMLInputElement", "change"));
    await ev(click("sched-save"));
  };
  ok("子任务没有排期时显示「未排期」", await ev(`document.querySelectorAll('[data-testid="wb-active-item"]')[0].querySelectorAll('[data-testid="wb-child-when"]')[1].innerText.includes('未排期')`));
  await ev(`document.querySelectorAll('[data-testid="wb-active-item"]')[0].querySelectorAll('[data-testid="wb-child-when"]')[1].click()`);
  await fillSched(1, 3, 4, 2);
  await until(`document.querySelectorAll('[data-testid="wb-active-item"]')[0].querySelectorAll('[data-testid="wb-child-when"]')[1].classList.contains('local')`);
  ok("在子任务上填排期和人天后立刻显示，并标成本地的", await ev(`(() => { const r = document.querySelectorAll('[data-testid="wb-active-item"]')[0].querySelectorAll('[data-testid="wb-child"]')[1]; return r.innerText.includes('2 人天') && !r.innerText.includes('未排期'); })()`));
  ok("排期存在本机的 localStorage 里，不是配置文件", await ev(`Object.keys(JSON.parse(localStorage.getItem('harness.schedule.v1') || '{}')).some(k => k.startsWith('feishu:1:102'))`));
  await ev(`document.querySelectorAll('[data-testid="wb-active-item"]')[1].querySelector('[data-testid="wb-self-sched"]').click()`);
  await fillSched(1, 0, 1);
  await until(`document.querySelectorAll('[data-testid="gantt-bar"]').length === 3`);
  ok("没有排期的需求在本软件里填了排期，就画到甘特图上，并且不再算未排期", await ev(`[...document.querySelectorAll('[data-testid="gantt-bar"]')].some(b => b.innerText.includes('飞书进行中无排期'))`));
  await ev(`document.querySelectorAll('[data-testid="wb-active-item"]')[1].querySelector('[data-testid="wb-self-sched"]').click()`);
  await until(`document.querySelector('[data-testid="sched-clear"]')`);
  await ev(click("sched-clear"));
  await until(`document.querySelectorAll('[data-testid="gantt-bar"]').length === 2`);
  ok("清除后恢复原来的排期", true);
  await ev(`document.querySelectorAll('[data-testid="wb-active-item"]')[0].querySelectorAll('[data-testid="wb-child-when"]')[1].click()`);
  await until(`document.querySelector('[data-testid="sched-clear"]')`);
  await ev(click("sched-clear"));
  await until(`!document.querySelectorAll('[data-testid="wb-active-item"]')[0].querySelectorAll('[data-testid="wb-child-when"]')[1].classList.contains('local')`);
  ok("同一个需求只出现一次，未排期里不重复也不含进行中的", await ev(`(() => { const u = [...document.querySelectorAll('[data-testid="wb-todo"]')].map(x => x.querySelector('.wb-todo-title').innerText); return u.length === 1 && u[0] === '飞书未排期'; })()`));
  await ev(click("wb-sub-toggle"));
  await until(`document.querySelector('[data-testid="wb-unscheduled"] [data-testid="wb-child"]')`);
  ok("未排期的需求可以展开看我的子任务", await ev(`document.querySelector('[data-testid="wb-unscheduled"]').innerText.includes('写接口文档')`));
  ok("点排期条展开详情，可以打开任务", await ev(`!!document.querySelector('[data-testid="gantt-detail"] [data-testid="wb-todo-ai"]')`));

  // 点需求：左侧创建任务；点任务：打开任务详情（需求信息 / 关联仓库 / 改动 / MCP / 事件流）
  ok("点排期条后，左侧「进行中的任务」里多了一个以需求命名的任务，状态待确认", await ev(`(() => { const it = document.querySelectorAll('[data-testid="task-item"]'); const nav = document.querySelector('[data-testid="task-nav"]'); return it.length === 1 && it[0].innerText.includes('飞书排期A') && it[0].innerText.includes('待确认') && !!nav && nav.innerText.includes('进行中的任务') && nav.innerText.includes('今天'); })()`));
  ok("工作台的侧边栏里只有任务，没有历史对话", await ev(`!!document.querySelector('.nav [data-testid="task-nav"]') && !document.querySelector('.nav [data-testid="session-group"]') && !document.querySelector('.nav [data-testid="session-item"]:not(.task-item)')`));
  await ev(click("new-chat"));
  await until(`!!document.querySelector('.nav [data-testid="session-group"]')`);
  ok("新建对话页的侧边栏只有对话，没有任务", await ev(`!document.querySelector('.nav [data-testid="task-nav"]') && !document.querySelector('.nav [data-testid="task-item"]') && !document.querySelector('.nav [data-testid="task-chip"]')`));
  await ev(click("nav-workbench"));
  await until(`document.querySelector('[data-testid="gantt-bar"]')`);
  await ev(click("gantt-bar"));
  await until(`document.querySelector('[data-testid="task-page"]') && !document.querySelector('[data-testid="task-page"]').closest('[hidden]')`);
  ok("需求已有对应任务时，点排期条直接跳到任务，不会重复创建", (await ev(`document.querySelectorAll('[data-testid="task-item"]').length`)) === 1 && (await ev(`document.querySelector('[data-testid="task-title"]').innerText`)) === '飞书排期A');
  await ev(click("task-back"));
  await sleep(250);
  const readmeFile = path.join(demoRepo, "README.md");
  fs.appendFileSync(readmeFile, "line a\nline b\n");
  await ev(`document.querySelector('[data-testid="task-item"]').click()`);
  await until(`document.querySelector('[data-testid="task-page"]') && !document.querySelector('[data-testid="task-page"]').closest('[hidden]')`);
  ok("点任务进入任务详情：标题是需求名、状态待确认", await ev(`document.querySelector('[data-testid="task-title"]').innerText === '飞书排期A' && document.querySelector('[data-testid="task-phase"]').innerText.includes('待确认') && document.querySelector('[data-testid="task-item"]').classList.contains('active')`));
  ok("详情有 基本信息 / 任务上下文 / MCP / 改动 / 任务文件夹 / 关联仓库 / 事件流 / 输入框", await ev(`['task-info-btn','task-ctx-btn','task-mcp-btn','task-diff','task-folder','task-repo-add','task-flow','task-composer','task-back','task-done','task-drop'].every(i => !!document.querySelector('[data-testid="' + i + '"]'))`));
  ok("输入框里预填了让 AI 读取这个需求的提示词", await ev(`(() => { const v = document.querySelector('[data-testid="task-input"]').value; return v.includes('飞书排期A') && v.includes('feishu_project_read'); })()`));
  await ev(click("task-info-btn"));
  await until(`document.querySelector('[data-testid="pop-info"]')`);
  ok("基本信息里有来源、工作项 ID、节点", await ev(`(() => { const t = document.querySelector('[data-testid="pop-info"]').innerText; return t.includes('飞书项目') && t.includes('技术排期') && t.includes('工作项 ID'); })()`));
  await ev(click("task-info-btn"));
  await ev(click("task-repo-add"));
  await until(`document.querySelector('[data-testid="pop-repo-item"]')`);
  ok("关联仓库的下拉里仓库名不换行，旁边显示的是基线分支（不是当前所在分支）", await ev(`(() => { const i = document.querySelector('[data-testid="pop-repo-item"]'); const b = i.querySelector('b'); return getComputedStyle(b).whiteSpace === 'nowrap' && b.getBoundingClientRect().height < 22 && i.querySelector('[data-testid="pop-repo-base"]').innerText === '基线 main'; })()`));
  await shot("0p-repo-pop");
  await ev(click("pop-repo-item"));
  await until(`document.querySelector('[data-testid="task-repo"]')`);
  await until(`document.querySelector('[data-testid="task-repo-notes"]')`, 20000);
  ok("可以关联代码仓库，显示仓库名和当前分支", await ev(`(() => { const t = document.querySelector('[data-testid="task-repo"]').innerText; return t.includes('demo') && t.includes('main'); })()`));
  ok("刚关联仓库会自动同步到基线分支（没有远端的只用本地分支，并说明）", await ev(`(() => { const t = document.querySelector('[data-testid="task-repo-notes"]').innerText; return t.includes('基线分支 main') && t.includes('没有远端') && !document.querySelector('[data-testid="task-repo-syncing"]'); })()`));
  ok("仓库标签是一行：仓库名不换行，分支名是小标签", await ev(`(() => { const c = document.querySelector('[data-testid="task-repo"]'); return c.getBoundingClientRect().height < 34 && c.querySelector('b').getBoundingClientRect().height < 22 && !!c.querySelector('[data-testid="task-repo-branch"]'); })()`));
  await shot("0m-task-repo-chip");
  await until(`document.querySelector('[data-testid="task-diff"]').innerText.includes('+2')`);
  ok("改动统计的是关联仓库相对 HEAD 的新增 / 删除行数", await ev(`document.querySelector('[data-testid="task-diff"]').innerText.includes('+2')`));
  await ev(click("task-ctx-btn"));
  await until(`document.querySelector('[data-testid="task-ctx-input"]')`);
  await ev(setVal('[data-testid="task-ctx-input"]', "接口文档：见群公告", "HTMLTextAreaElement", "input"));
  await ev(click("task-ctx-btn"));
  ok("任务上下文写了内容后计数变成 1", await ev(`document.querySelector('[data-testid="task-ctx-btn"] .num').innerText === '1'`));
  await until(`document.querySelector('[data-testid="task-mcp-num"]') && /\\d+\\/\\d+/.test(document.querySelector('[data-testid="task-mcp-num"]').innerText)`);
  ok("MCP 显示 已连接 / 已启用 数量", true);
  await shot("0e-task");
  await ev(click("task-send"));
  await until(`document.querySelectorAll('[data-testid="round-tab"]').length === 1`);
  await until(`document.querySelector('[data-testid="task-phase"]').innerText.includes('等待回复')`, 20000);
  ok("发出指令后出现 #1 轮次，状态变成等待回复，产物里是 AI 的回复", await ev(`document.querySelector('[data-testid="round-tab"]').innerText.includes('#1') && document.querySelector('[data-testid="out-body"]').innerText.includes('【echo】')`));
  ok("第一次发送会带上任务说明：需求名、关联仓库、任务上下文", await ev(`(() => { const t = document.querySelector('[data-testid="out-body"]').innerText; return t.includes('【任务】飞书排期A') && t.includes('demo') && t.includes('接口文档：见群公告'); })()`));
  ok("事件流里记录了这一轮", await ev(`(() => { const r = document.querySelectorAll('[data-testid="flow-round"]'); return r.length === 1 && r[0].innerText.includes('已完成'); })()`));
  await ev(setVal('[data-testid="task-input"]', "第二条", "HTMLTextAreaElement", "input"));
  await ev(click("task-send"));
  await until(`document.querySelectorAll('[data-testid="round-tab"]').length === 2`);
  await until(`document.querySelector('[data-testid="task-phase"]').innerText.includes('等待回复') && document.querySelector('[data-testid="out-body"]').innerText.includes('【echo】第二条')`, 20000);
  ok("第二轮不再重复带任务说明，轮次切换到 #2", await ev(`!document.querySelector('[data-testid="out-body"]').innerText.includes('【任务】') && document.querySelectorAll('[data-testid="round-tab"]')[1].classList.contains('on')`));
  await ev(`document.querySelectorAll('[data-testid="round-tab"]')[0].click()`);
  await until(`document.querySelector('[data-testid="out-body"]').innerText.includes('【任务】飞书排期A')`);
  ok("点 #1 能看回第一轮的产物", true);
  await shot("0e-task-rounds");
  await sleep(700);
  await ev(`location.reload()`);
  await until(`document.querySelector('[data-testid="nav-workbench"]')`, 30000);
  await sleep(500);
  await ev(click("nav-workbench"));
  await until(`document.querySelector('[data-testid="task-item"]')`);
  ok("重启后任务还在，状态是等待回复", await ev(`(() => { const t = document.querySelector('[data-testid="task-item"]'); return t.innerText.includes('飞书排期A') && t.innerText.includes('等待回复'); })()`));
  await ev(`document.querySelector('[data-testid="task-item"]').click()`);
  await until(`document.querySelector('[data-testid="task-page"]') && !document.querySelector('[data-testid="task-page"]').closest('[hidden]')`);
  ok("重启后任务的轮次和关联仓库都保留", (await ev(`document.querySelectorAll('[data-testid="round-tab"]').length`)) === 2 && (await ev(`document.querySelector('[data-testid="task-repo"]')?.innerText.includes('demo')`)));
  await ev(click("task-back"));
  await until(`document.querySelector('[data-testid="workbench"]') && !document.querySelector('[data-testid="workbench"]').closest('[hidden]')`);
  ok("点返回回到工作台", true);
  await ev(`document.querySelector('[data-testid="task-item"]').click()`);
  await until(`document.querySelector('[data-testid="task-done"]')`);
  await ev(click("task-done"));
  await until(`document.querySelector('[data-testid="task-done-head"]')`);
  ok("点完成后任务移到「已完成」里", await ev(`document.querySelectorAll('[data-testid="task-item"]').length === 0 && document.querySelector('[data-testid="task-done-head"]').innerText.includes('1')`));
  await ev(click("task-done"));
  await until(`document.querySelectorAll('[data-testid="task-item"]').length === 1`);
  ok("可以重新打开任务", true);
  await ev(click("task-drop"));
  await ev(click("task-drop-confirm"));
  await until(`document.querySelectorAll('[data-testid="task-item"]').length === 0 && !document.querySelector('[data-testid="task-done-head"]')`);
  ok("放弃任务后侧边栏里没有了，回到工作台", await ev(`!document.querySelector('[data-testid="workbench"]').closest('[hidden]')`));
  spawnSync("git", ["checkout", "--", "README.md"], { cwd: demoRepo });
  await shot("0f-workbench-schedule");
  const range0 = await ev(`document.querySelector('[data-testid="wb-range"]').innerText`);
  await ev(click("wb-next"));
  await until(`document.querySelector('[data-testid="wb-today"]')`);
  ok("可以翻到下一段时间，并能回到今天", (await ev(`document.querySelector('[data-testid="wb-range"]').innerText`)) !== range0 && (await ev(click("wb-today"))) && (await ev(`document.querySelector('[data-testid="wb-range"]').innerText`)) === range0);
  // 缺陷提醒：右上角按用户用的项目管理工具出现入口，图标上显示待处理数量，列表里能流转状态
  await ev(`window.harness.defectsRefresh().then(() => true)`);
  await until(`document.querySelector('[data-testid="defect-badge"]')?.innerText === '2'`, 30000);
  ok("接了飞书项目后右上角出现缺陷入口，图标上显示 2 个待处理", await ev(`document.querySelector('[data-testid="nav-defects"]').closest('.titlebar-tools') !== null && document.querySelector('[data-testid="nav-defects"]').title.includes('飞书缺陷')`));
  ok("还没看过的缺陷，数字是红色的", await ev(`document.querySelector('[data-testid="defect-badge"]').classList.contains('new')`));
  await ev(click("nav-defects"));
  await until(`document.querySelectorAll('[data-testid="defect-item"]').length === 2`, 20000);
  await until(`!document.querySelector('[data-testid="defect-badge"]').classList.contains('new')`, 10000);
  ok("打开列表看过之后，数字不再是红色", true);
  await ev(click("nav-defects"));
  fs.writeFileSync(dfile, JSON.stringify([D1, D2, D3])); // 有人又提了一个缺陷
  await ev(`window.harness.defectsRefresh().then(() => true)`);
  await until(`document.querySelector('[data-testid="defect-badge"]')?.innerText === '3'`, 30000);
  ok("有人新提了缺陷：数字变成 3 并变红，提示里写明有新的", await ev(`document.querySelector('[data-testid="defect-badge"]').classList.contains('new') && document.querySelector('[data-testid="nav-defects"]').title.includes('1 个新的')`));
  await shot("0o-defect-badge");
  await ev(click("nav-defects"));
  await until(`document.querySelectorAll('[data-testid="defect-item"]').length === 3`, 20000);
  ok("点图标列出 3 个问题：标题、状态、提出人，标题是飞书缺陷", await ev(`(() => { const t = [...document.querySelectorAll('[data-testid="defect-item"]')].map(x => x.innerText); return document.querySelector('[data-testid="defects"] h1').innerText === '飞书缺陷' && t[0].includes('导出报表乱码') && t[0].includes('王五 提出') && t.some(x => x.includes('登录页白屏') && x.includes('OPEN')) && t.some(x => x.includes('支付回调失败') && x.includes('IN PROGRESS')) && document.querySelector('[data-testid="defect-sub"]').innerText.includes('测试用户') && document.querySelector('[data-testid="defect-sub"]').innerText.includes('共 3 个'); })()`));
  ok("只有新来的那个带「新」标记，每个问题有打开原系统的链接", await ev(`(() => { const n = [...document.querySelectorAll('[data-testid="defect-item"]')].filter(x => x.querySelector('[data-testid="defect-new"]')); return n.length === 1 && n[0].innerText.includes('导出报表乱码') && document.querySelector('[data-testid="defect-open"]').getAttribute('href') === 'https://project.feishu.cn/ts/issue/detail/503'; })()`));
  await shot("0o-defects");
  await ev(`[...document.querySelectorAll('[data-testid="defect-filter"]')].find(b => b.innerText.includes('IN PROGRESS')).click()`);
  await until(`document.querySelectorAll('[data-testid="defect-item"]').length === 1`);
  ok("可以按状态筛选", await ev(`document.querySelector('[data-testid="defect-item"]').innerText.includes('支付回调失败')`));
  await ev(`[...document.querySelectorAll('[data-testid="defect-filter"]')][0].click()`);
  await ev(setVal('[data-testid="defect-search"]', "白屏", "HTMLInputElement", "input"));
  await until(`document.querySelectorAll('[data-testid="defect-item"]').length === 1`);
  ok("可以按标题搜索", await ev(`document.querySelector('[data-testid="defect-item"]').innerText.includes('登录页白屏')`));
  // 流转状态：OPEN → IN PROGRESS
  await ev(click("defect-flow"));
  await until(`document.querySelector('[data-testid="defect-flow-panel"] [data-testid="defect-to"]')`);
  ok("点「流转状态」列出当前状态能到的下一步", await ev(`[...document.querySelectorAll('[data-testid="defect-to"]')].map(b => b.innerText).join(',') === 'IN PROGRESS,RESOLVED'`));
  await ev(`document.querySelector('[data-testid="defect-to"]').click()`);
  await until(`document.querySelector('[data-testid="defect-confirm"]')`);
  ok("选了下一步要再确认一次，不会一点就改", (await ev(`document.querySelector('[data-testid="defect-status"]').innerText`)) === "OPEN");
  await ev(click("defect-confirm"));
  await until(`document.querySelector('[data-testid="defect-status"]')?.innerText === 'IN PROGRESS'`, 30000);
  ok("确认后状态流转到 IN PROGRESS，并提示成功", await ev(`document.querySelector('[data-testid="defect-msg"]').innerText.includes('已流转到 IN PROGRESS') && !document.querySelector('[data-testid="defect-flow-panel"]')`));
  ok("流转状态确实写回了项目管理系统", JSON.parse(fs.readFileSync(dfile, "utf8")).find(x => x.id === 501).status === "IN PROGRESS");
  // 流转被拒绝：显示原因，状态不变
  await ev(click("defect-flow"));
  await until(`document.querySelector('[data-testid="defect-to"]')`);
  await ev(`[...document.querySelectorAll('[data-testid="defect-to"]')].find(b => b.innerText === '转测试').click()`);
  await until(`document.querySelector('[data-testid="defect-confirm"]')`);
  await ev(click("defect-confirm"));
  await until(`document.querySelector('[data-testid="defect-flow-fail"]')`, 20000);
  ok("流转被拒绝时显示对方给的原因，状态不变", await ev(`document.querySelector('[data-testid="defect-flow-fail"]').innerText.includes('无权流转') && document.querySelector('[data-testid="defect-status"]').innerText === 'IN PROGRESS'`));
  // 流转到 CLOSED：从列表里消失，数字减少
  await ev(`[...document.querySelectorAll('[data-testid="defect-to"]')].find(b => b.innerText === 'CLOSED').click()`);
  await ev(click("defect-confirm"));
  await until(`document.querySelector('[data-testid="defect-badge"]')?.innerText === '2'`, 30000);
  await ev(setVal('[data-testid="defect-search"]', "", "HTMLInputElement", "input"));
  await until(`document.querySelectorAll('[data-testid="defect-item"]').length === 2`);
  ok("关闭后这个问题不再出现在待处理里，图标上的数字减到 2", await ev(`![...document.querySelectorAll('[data-testid="defect-title"]')].some(x => x.innerText.includes('登录页白屏'))`));
  // 需要填表单的流转：本软件填不了，禁用并指向原系统
  await ev(`[...document.querySelectorAll('[data-testid="defect-item"]')].find(x => x.innerText.includes('导出报表乱码')).querySelector('[data-testid="defect-flow"]').click()`);
  await until(`document.querySelector('[data-testid="defect-to"]')`);
  ok("需要填表单的流转按钮是禁用的，并说明去原系统里操作", await ev(`(() => { const b = document.querySelector('[data-testid="defect-to"]'); return b.disabled && b.innerText.includes('需填表单') && b.title.includes('原系统'); })()`));
  await ev(click("nav-defects"));
  ok("再点一次图标回到原来的页面", await ev(`!document.querySelector('[data-testid="defects"]')`));

  // 只接钉钉：配置里没有飞书项目时展示钉钉待办
  const cfg2 = JSON.parse(fs.readFileSync(path.join(home, "harness.config.json"), "utf8"));
  delete cfg2.integrations.feishuProject;
  await ev(`window.harness.saveConfig(${JSON.stringify(JSON.stringify(cfg2, null, 2))}).then(() => true)`);
  await ev(`location.reload()`);
  await until(`document.querySelector('[data-testid="nav-workbench"]')`, 30000);
  await sleep(500);
  await ev(click("nav-workbench"));
  await ev(click("wb-refresh"));
  await until(`document.querySelector('[data-testid="wb-schedule"]')?.dataset.source === 'dingtalk' && document.querySelectorAll('[data-testid="gantt-bar"]').length > 0`, 20000);
  ok("只接了钉钉时展示钉钉待办，不出现飞书", await ev(`(() => { const t = document.body.innerText; return t.includes('钉钉任务甲') && t.includes('钉钉任务乙') && !t.includes('飞书排期') && !document.querySelector('[data-testid="wb-source"]'); })()`));
  await shot("0g-workbench-dingtalk");
  await ev(`window.harness.defectsRefresh().then(() => true)`);
  await until(`document.querySelector('[data-testid="nav-defects"]')?.title.includes('钉钉待办')`, 30000);
  ok("只接钉钉时入口变成「钉钉待办」，数字是未完成的待办数", (await ev(`document.querySelector('[data-testid="defect-badge"]').innerText`)) === "2");
  await ev(click("nav-defects"));
  await until(`document.querySelectorAll('[data-testid="defect-item"]').length === 2`);
  await ev(click("defect-flow"));
  await until(`document.querySelector('[data-testid="defect-to"]')`);
  ok("钉钉待办列出任务，可以标记完成", await ev(`document.querySelector('[data-testid="defects"] h1').innerText === '钉钉待办' && document.body.innerText.includes('钉钉任务甲') && document.querySelector('[data-testid="defect-to"]').innerText === '标记完成'`));
  await ev(click("nav-defects"));
  // 设置里项目管理二选一：开一个就会关掉另一个
  await ev(click("nav-settings"));
  await until(`document.querySelector('[data-testid="settings-office"]')`);
  await ev(click("settings-office"));
  await until(`document.querySelector('[data-testid="feishu-project-switch"]')`);
  await ev(click("feishu-project-switch"));
  await sleep(900);
  ok("开启飞书项目会关掉钉钉项目管理", (c => !!c.feishuProject && !c.dingtalkProject)(JSON.parse(fs.readFileSync(path.join(home, "harness.config.json"), "utf8")).integrations));
  await ev(click("dingtalk-project-switch"));
  await sleep(900);
  ok("开启钉钉项目管理会关掉飞书项目", (c => !!c.dingtalkProject && !c.feishuProject)(JSON.parse(fs.readFileSync(path.join(home, "harness.config.json"), "utf8")).integrations));
  await shot("0h-project-exclusive");

  // DBX 插件中心：目录来自 DBX，直接装进本软件（不需要 DBX）；本机有 DBX 时还能识别 DBX 里的插件并桥接 AI
  const dbxRoot = path.join(home, "dbx-data");
  const localDir = path.join(home, "plugins-local");
  const dbxCard = `document.querySelector('[data-testid="plugin-card"][data-key="DBX 插件中心:io.dbx.ssh"]')`;
  await ev(click("nav-plugins"));
  await until(`document.querySelector('[data-testid="plugin-store"]')`);
  await ev(click("plugin-tab-store"));
  await until(`document.querySelector('[data-testid="plugin-card"][data-key="DBX 插件中心:io.dbx.ssh"]')`, 20000);
  ok("商店里有 DBX 插件中心的插件，用中文名和介绍", (await ev(nCards)) === 2 && (await ev(`${dbxCard}.innerText.includes('终端') && ${dbxCard}.innerText.includes('安全的终端') && ${dbxCard}.querySelector('.px-by').innerText.includes('jinpy')`)));
  ok("DBX 插件显示版本和源码仓库入口", await ev(`${dbxCard}.innerText.includes('v0.7.14') && ${dbxCard}.querySelector('[data-testid="plugin-repo"]').getAttribute('href') === 'https://github.com/jinpy/terminal'`));
  ok("没有当前系统安装包的 DBX 插件，不显示安装按钮，而是写明「暂无 xx 版」", await ev(`(() => { const c = document.querySelector('[data-testid="plugin-card"][data-key="DBX 插件中心:acme.noart"]'); return !c.querySelector('[data-testid="plugin-install"]') && /暂无 .+ 版/.test(c.querySelector('[data-testid="plugin-nopkg"]')?.innerText ?? ''); })()`));
  await ev(setVal('[data-testid="plugin-status"]', "installed", "HTMLSelectElement", "change"));
  await sleep(150);
  ok("可以按状态筛选：还没装任何插件时「已安装」为空", (await ev(nCards)) === 0);
  await ev(setVal('[data-testid="plugin-status"]', "none", "HTMLSelectElement", "change"));
  await sleep(150);
  ok("「未安装」筛选出全部 2 个", (await ev(nCards)) === 2);
  await ev(setVal('[data-testid="plugin-status"]', "all", "HTMLSelectElement", "change"));
  await shot("0j-plugin-dbx-store");
  ok("本机没有 DBX 也能看到商店里的插件并安装（没有 DBX 的数据目录）", !fs.existsSync(dbxRoot) && (await ev(`!!${dbxCard}.querySelector('[data-testid="plugin-install"]') && !document.querySelector('[data-testid="plugin-dbx-missing"]')`)));
  await ev(`${dbxCard}.querySelector('[data-testid="plugin-install"]').click()`);
  await until(`${dbxCard}?.dataset.state === 'installed'`, 20000);
  ok("点安装：直接下载到本软件的插件目录，并校验通过，不需要 DBX", fs.existsSync(path.join(localDir, "io.dbx.ssh", "versions", "0.7.14", "manifest.json")) && fs.existsSync(path.join(localDir, "io.dbx.ssh", "versions", "0.7.14", "ui", "index.html")) && !fs.existsSync(dbxRoot) && !fs.existsSync(path.join(home, "dbx-open.log")));
  ok("提示已安装，卡片标已安装", await ev(`document.querySelector('[data-testid="plugin-msg"]').innerText.includes('已安装「终端」') && !${dbxCard}.querySelector('[data-testid="plugin-install"]')`));
  await ev(click("plugin-tab-installed"));
  await until(`document.querySelector('[data-testid="installed-row"][data-key="DBX 插件中心:io.dbx.ssh"]')`);
  await ev(`document.querySelector('[data-testid="installed-row"][data-key="DBX 插件中心:io.dbx.ssh"]').click()`);
  await until(`document.querySelector('[data-testid="installed-detail"]')?.dataset.key === 'DBX 插件中心:io.dbx.ssh' && document.querySelector('[data-testid="installed-content"]')`);
  ok("已安装页列出本软件里的插件，显示插件内容（界面 / 后台 / AI 工具数 / 权限）", await ev(`(() => { const c = document.querySelector('[data-testid="installed-content"]').innerText; return c.includes('2 个') && c.includes('host.ai') && c.includes('workbench') && !!document.querySelector('[data-testid="installed-uninstall"]'); })()`));
  ok("没有 DBX 时如实说明：插件界面 / 工具要靠 DBX 运行环境，本软件只负责安装和管理", await ev(`document.querySelector('[data-testid="installed-runtime-note"]')?.innerText.includes('右侧插件栏') && !document.querySelector('[data-testid="dbx-bridge-switch"]')`));
  await shot("0k-plugin-installed-local");
  await ev("window.confirm = () => true");
  await ev(click("installed-uninstall"));
  await until(`!document.querySelector('[data-testid="installed-detail"]')`, 10000);
  ok("卸载：删除本软件里的插件文件", !fs.existsSync(path.join(localDir, "io.dbx.ssh")));
  await ev(click("plugin-tab-store"));
  await until(`${dbxCard}?.dataset.state === 'none'`, 20000);
  fs.mkdirSync(path.join(dbxRoot, "plugins"), { recursive: true }); // 有这个目录就算本机装了 DBX
  // 模拟用户在 DBX 里装了一个旧一点的版本，商店自动识别
  const mkVer = v => {
    const d = path.join(dbxRoot, "plugins", "io.dbx.ssh", "versions", v);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, "manifest.json"), "{}");
  };
  mkVer("0.7.13");
  await ev(click("plugin-refresh"));
  await sleep(800);
  ok("DBX 里装了同一个插件，不算本软件已安装：商店里仍是未安装，可以直接装", await ev(`${dbxCard}.dataset.state === 'none' && !!${dbxCard}.querySelector('[data-testid="plugin-install"]')`));
  await ev(click("plugin-tab-settings"));
  await until(`document.querySelector('[data-testid="dbx-found"]')`);
  ok("设置里显示本机 DBX 已检测到、已装 1 个插件、桥接用的 MCP 组件", await ev(`document.querySelector('[data-testid="dbx-found"]').innerText === '已检测到' && document.querySelector('[data-testid="dbx-status"]').innerText.includes('1 个')`));
  await sleep(400);
  await shot("0i-plugin-settings");
  await ev(click("dbx-bridge-switch"));
  await sleep(700);
  ok("在设置里打开 AI 桥接：把 DBX 的 MCP 加进配置并启用", readCfg().mcpServers?.dbx?.command === process.execPath && readCfg().mcpServers.dbx.enabled === true);
  await ev(click("dbx-bridge-switch"));
  await sleep(700);
  ok("在设置里关掉 AI 桥接", readCfg().mcpServers?.dbx?.enabled === false);
  await ev(click("plugin-tab-installed"));
  await until(`document.querySelector('[data-testid="plugin-installed-empty"]')`);
  ok("已安装页只列装在本软件里的插件，DBX 里装的不列出，tab 上也没有数量", await ev(`!document.querySelector('[data-testid="installed-row"]') && !document.querySelector('[data-testid="plugin-tab-installed"] .px-count')`));
  await ev(click("plugin-tab-store"));
  await until(`${dbxCard}?.dataset.state === 'none'`, 20000);
  await ev(`${dbxCard}.querySelector('[data-testid="plugin-install"]').click()`);
  await until(`${dbxCard}?.dataset.state === 'installed'`, 20000);
  // 模拟本软件里装的是旧一点的版本
  const verDir = v => path.join(localDir, "io.dbx.ssh", "versions", v);
  fs.cpSync(verDir("0.7.14"), verDir("0.7.13"), { recursive: true });
  fs.rmSync(verDir("0.7.14"), { recursive: true, force: true });
  await ev(click("plugin-refresh"));
  await until(`${dbxCard}?.dataset.state === 'update'`, 20000);
  ok("本软件里装的版本比目录旧时，商店标「更新」", await ev(`${dbxCard}.querySelector('[data-testid="plugin-install"]').innerText === '更新'`));
  await ev(click("plugin-tab-installed"));
  await until(`document.querySelector('[data-testid="installed-row"][data-key="DBX 插件中心:io.dbx.ssh"]')`);
  await ev(`document.querySelector('[data-testid="installed-row"][data-key="DBX 插件中心:io.dbx.ssh"]').click()`);
  await until(`document.querySelector('[data-testid="installed-detail"]')?.dataset.key === 'DBX 插件中心:io.dbx.ssh'`);
  ok("已安装页显示本软件里的插件，可以卸载；没有 DBX 的桥接开关和「仅 DBX」", await ev(`!!document.querySelector('[data-testid="installed-uninstall"]') && !document.querySelector('[data-testid="dbx-bridge-switch"]') && !document.querySelector('[data-testid="installed-detail"]').innerText.includes('DBX 的插件中心') && !document.querySelector('[data-testid="installed-row"]').innerText.includes('仅 DBX')`));
  ok("tab 上的数量是本软件里装的插件数", (await ev(`document.querySelector('[data-testid="plugin-tab-installed"] .px-count')?.innerText`)) === "1");
  ok("版本比目录旧时标「可更新」", await ev(`document.querySelector('[data-testid="installed-row"][data-key="DBX 插件中心:io.dbx.ssh"] .px-update')?.innerText === '可更新'`));
  await shot("0k-plugin-installed-update");
  await ev(click("installed-update"));
  await until(`!document.querySelector('[data-testid="installed-update"]') && document.querySelector('[data-testid="installed-uninstall"]')`, 20000);
  ok("已安装页的「更新」直接装到本软件（不拉起 DBX），装完不再提示更新", fs.existsSync(path.join(localDir, "io.dbx.ssh", "versions", "0.7.14", "manifest.json")) && !fs.existsSync(path.join(home, "dbx-open.log")));

  // 插件设置：安装插件包（文件 / 链接 / 拖放）、插件仓库（添加第三方、停用、删除）、第三方与开发者选项
  {
    const p64 = pkgLocal.toString("base64");
    await ev(click("nav-plugins"));
    await until(`document.querySelector('[data-testid="plugins-page"]')`);
    await ev(click("plugin-tab-settings"));
    await until(`document.querySelector('[data-testid="pkg-install"]')`);
    ok("插件设置里有：安装插件包、插件仓库、第三方与开发者选项", await ev(`['pkg-install', 'dbx-catalog', 'dev-options'].every(k => !!document.querySelector('[data-testid="' + k + '"]'))`));
    await until(`document.querySelector('[data-testid="repo-row"]')`);
    ok("官方仓库固定在第一行，标着官方和已启用，不能删也不能停", await ev(`(() => { const r = document.querySelector('[data-testid="repo-row"]'); return r.dataset.id === 'dbx' && r.innerText.includes('官方') && r.innerText.includes('已启用') && !r.querySelector('[data-testid="repo-del"]') && !r.querySelector('[data-testid="repo-switch"]') && r.querySelector('[data-testid="repo-count"]').innerText.includes('个插件'); })()`));
    ok("开发者选项默认折叠，展开后是本软件的插件目录", (await ev(`!document.querySelector('[data-testid="plugin-dir"]')`)) && (await ev(click("dev-toggle")) , await ev(`document.querySelector('[data-testid="plugin-dir"]')?.innerText`)) === localDir);
    await ev(click("dev-toggle"));
    await shot("0q-plugin-settings");

    // 添加第三方仓库
    await ev(setVal('[data-testid="repo-f-id"]', "third", "HTMLInputElement", "input"));
    await ev(setVal('[data-testid="repo-f-name"]', "第三方仓库", "HTMLInputElement", "input"));
    await ev(setVal('[data-testid="repo-f-url"]', `http://127.0.0.1:${LLM_PORT}/repo2.json`, "HTMLInputElement", "input"));
    await ev(click("repo-add"));
    await until(`document.querySelectorAll('[data-testid="repo-row"]').length === 2`);
    await until(`document.querySelectorAll('[data-testid="repo-row"]')[1].querySelector('[data-testid="repo-count"]').innerText === '1 个插件'`);
    ok("添加第三方仓库：多一行，能看到它的插件数，有开关和删除", await ev(`(() => { const r = document.querySelectorAll('[data-testid="repo-row"]')[1]; return r.innerText.includes('第三方仓库') && !r.innerText.includes('官方') && !!r.querySelector('[data-testid="repo-switch"]') && !!r.querySelector('[data-testid="repo-del"]'); })()`));
    ok("第三方仓库的数据存在本软件数据目录，不在代码仓库里", JSON.parse(fs.readFileSync(path.join(home, "plugin-repos.json"), "utf8")).repos[0].id === "third");
    await ev(setVal('[data-testid="repo-f-id"]', "third", "HTMLInputElement", "input"));
    await ev(setVal('[data-testid="repo-f-url"]', "https://other.example/i.json", "HTMLInputElement", "input"));
    await ev(click("repo-add"));
    await until(`document.querySelector('[data-testid="repo-err"]')`);
    ok("ID 重复添加不了，给出原因", await ev(`document.querySelector('[data-testid="repo-err"]').innerText.includes('已经存在')`));
    await ev(setVal('[data-testid="repo-f-id"]', "evil", "HTMLInputElement", "input"));
    await ev(setVal('[data-testid="repo-f-url"]', "http://evil.example/i.json", "HTMLInputElement", "input"));
    await ev(click("repo-add"));
    await until(`document.querySelector('[data-testid="repo-err"]')?.innerText.includes('https')`);
    ok("非 https 的远程目录地址不收", true);
    await ev(setVal('[data-testid="repo-f-id"]', "", "HTMLInputElement", "input"));
    await ev(setVal('[data-testid="repo-f-url"]', "", "HTMLInputElement", "input"));

    // 商店里出现第三方仓库的插件，能直接装
    await ev(click("plugin-tab-store"));
    await until(`document.querySelector('[data-testid="plugin-card"][data-key="第三方仓库:com.third.tool"]')`);
    ok("商店里出现第三方仓库的插件，来源是这个仓库", true);
    await ev(`document.querySelector('[data-testid="plugin-card"][data-key="第三方仓库:com.third.tool"] [data-testid="plugin-install"]').click()`);
    await until(`document.querySelector('[data-testid="plugin-card"][data-key="第三方仓库:com.third.tool"][data-state="installed"]')`, 20000);
    ok("第三方仓库的插件能装，装进本软件的插件目录", fs.existsSync(path.join(localDir, "com.third.tool", "versions", "1.0.0", "manifest.json")));

    // 停用 / 删除仓库
    await ev(click("plugin-tab-settings"));
    await until(`document.querySelectorAll('[data-testid="repo-row"]').length === 2`);
    await ev(`document.querySelectorAll('[data-testid="repo-row"]')[1].querySelector('[data-testid="repo-switch"]').click()`);
    await until(`document.querySelectorAll('[data-testid="repo-row"]')[1].classList.contains('off')`);
    ok("停用仓库：这一行变灰，显示已停用", await ev(`document.querySelectorAll('[data-testid="repo-row"]')[1].innerText.includes('已停用')`));
    await ev(click("plugin-tab-store"));
    await until(`!document.querySelector('[data-testid="plugin-card"][data-key="第三方仓库:com.third.tool"]')`);
    ok("停用后商店里不再有它的插件", true);
    await ev(click("plugin-tab-settings"));
    await until(`document.querySelectorAll('[data-testid="repo-row"]').length === 2`);
    await ev(`document.querySelectorAll('[data-testid="repo-row"]')[1].querySelector('[data-testid="repo-del"]').click()`);
    await until(`document.querySelectorAll('[data-testid="repo-row"]').length === 1`);
    ok("删除仓库：只剩官方", true);

    // 从本地文件安装（选择文件）
    await ev(`(() => { const bin = Uint8Array.from(atob(${JSON.stringify(p64)}), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bin], 'local.dbxp')); const i = document.querySelector('[data-testid="pkg-file"]'); i.files = dt.files; i.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await until(`document.querySelector('[data-testid="pkg-msg"]')`);
    ok("选 .dbxp 文件安装：提示已安装，装进插件目录", (await ev(`document.querySelector('[data-testid="pkg-msg"]').innerText.includes('已安装')`)) && fs.existsSync(path.join(localDir, "com.pkg.local", "versions", "1.2.0", "manifest.json")));
    // 从链接安装
    await ev(setVal('[data-testid="pkg-url"]', "http://evil.example/p.dbxp", "HTMLInputElement", "input"));
    await ev(click("pkg-url-install"));
    await until(`document.querySelector('[data-testid="pkg-msg"]')?.innerText.includes('https')`);
    ok("链接不是 https 的会拒绝，并说明原因", true);
    await ev(setVal('[data-testid="pkg-url"]', `http://127.0.0.1:${LLM_PORT}/pkg/url-plugin.dbxp`, "HTMLInputElement", "input"));
    await ev(click("pkg-url-install"));
    await until(`document.querySelector('[data-testid="pkg-msg"]')?.innerText.includes('已安装')`);
    ok("从链接安装成功，输入框清空", fs.existsSync(path.join(localDir, "com.pkg.url", "versions", "0.3.0", "manifest.json")) && (await ev(`document.querySelector('[data-testid="pkg-url"]').value === ''`)));
    // 拖放到插件中心页面
    await ev(click("plugin-tab-installed"));
    await ev(`(() => { const dt = new DataTransfer(); dt.items.add(new File(['x'], 'readme.txt')); document.querySelector('[data-testid="plugins-page"]').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return true; })()`);
    await until(`document.querySelector('[data-testid="pkg-drop-msg"]')`);
    ok("拖进来的不是 .dbxp，提示不支持", await ev(`document.querySelector('[data-testid="pkg-drop-msg"]').innerText.includes('不是 .dbxp')`));
    fs.rmSync(path.join(localDir, "com.pkg.local"), { recursive: true, force: true });
    await ev(`(() => { const bin = Uint8Array.from(atob(${JSON.stringify(p64)}), c => c.charCodeAt(0)); const dt = new DataTransfer(); dt.items.add(new File([bin], 'local.dbxp')); document.querySelector('[data-testid="plugins-page"]').dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true })); return true; })()`);
    await until(`document.querySelector('[data-testid="pkg-drop-msg"]')?.innerText.includes('已安装')`, 20000);
    await until(`[...document.querySelectorAll('[data-testid="installed-row"]')].some(r => r.dataset.key.includes('com.pkg.local'))`, 20000);
    ok("把 .dbxp 拖到插件中心页面直接安装，已安装列表里马上出现", fs.existsSync(path.join(localDir, "com.pkg.local", "versions", "1.2.0", "manifest.json")));
    await shot("0q-plugin-drop");
    // 收尾：把测试装的插件卸掉，不影响后面的用例
    for (const id of ["com.third.tool", "com.pkg.local", "com.pkg.url"]) await ev(`window.harness.pluginUninstall(${JSON.stringify(id)}).then(r => r.ok)`);
    ok("装进来的测试插件能卸载干净", !["com.third.tool", "com.pkg.local", "com.pkg.url"].some(id => fs.existsSync(path.join(localDir, id))));
    await ev(`window.dispatchEvent(new Event('harness:plugins-changed')); true`);
  }

  // 插件运行：右侧栏 + 界面 + 后台（用一个假插件，后台是脚本）
  {
    const pid = "com.fake.hello";
    const vdir = path.join(localDir, pid, "versions", "1.0.0");
    fs.mkdirSync(path.join(vdir, "ui"), { recursive: true });
    fs.mkdirSync(path.join(vdir, "assets"), { recursive: true });
    fs.mkdirSync(path.join(vdir, "bin", "x"), { recursive: true });
    fs.writeFileSync(path.join(vdir, "assets", "plugin.svg"), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" fill="#e11"/></svg>');
    fs.writeFileSync(path.join(vdir, "manifest.json"), JSON.stringify({ id: pid, name: "你好插件", version: "1.0.0", icon: "assets/plugin.svg", permissions: ["host.storage", "host.events", "host.network:https://example.com"], entrypoints: { backend: { executable: "bin/x/sidecar.js" }, ui: { root: "ui", entry: "ui/index.html" } } }));
    fs.writeFileSync(path.join(vdir, "ui", "index.html"), '<!doctype html><html><head><meta charset="utf-8"><title>hello</title></head><body><h1>hello plugin</h1><script src="app.js"></script></body></html>');
    fs.writeFileSync(path.join(vdir, "ui", "app.js"), [
      'const root = document.documentElement;',
      'const rep = o => dbxPlugin.invoke("report", o);',
      'dbxPlugin.onEvent(e => rep({ ev: e.method }));',
      'new MutationObserver(() => rep({ theme: root.dataset.dbxTheme })).observe(root, { attributes: true, attributeFilter: ["data-dbx-theme"] });',
      'dbxPlugin.ready.then(async ctx => {',
      '  const r = await dbxPlugin.invoke("echo", { n: 41 });',
      '  await dbxPlugin.storage.set("k", { v: 1 });',
      '  const st = await dbxPlugin.storage.get("k");',
      '  let net = "open"; try { await fetch("https://not-declared.example.org/x"); } catch (e) { net = "blocked"; }',
      '  let nosup = "ok"; try { await dbxPlugin.openWorkbench("x", {}); } catch (e) { nosup = e.message; }',
      '  await rep({ ctx: ctx.pluginId, n: r.n + 1, store: st, net, nosup, theme: root.dataset.dbxTheme, primary: root.style.getPropertyValue("--color-primary"), kit: !!getComputedStyle(root).getPropertyValue("--color-border") });',
      '  await dbxPlugin.invoke("emit");',
      '});',
    ].join("\n"));
    fs.writeFileSync(path.join(vdir, "bin", "x", "sidecar.js"), [
      'const fs = require("node:fs"), path = require("node:path");',
      'const dir = process.env.DBX_PLUGIN_DATA_DIR; const f = path.join(dir, "report.json");',
      'const send = o => process.stdout.write(JSON.stringify(o) + "\\n");',
      'require("node:readline").createInterface({ input: process.stdin }).on("line", l => {',
      '  const m = JSON.parse(l);',
      '  if (m.method === "plugin/initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, plugin: { id: process.env.DBX_PLUGIN_ID }, capabilities: [] } });',
      '  if (m.method === "echo") return send({ jsonrpc: "2.0", id: m.id, result: { n: m.params.n } });',
      '  if (m.method === "report") { let cur = {}; try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch {} fs.writeFileSync(f, JSON.stringify({ ...cur, ...m.params })); return send({ jsonrpc: "2.0", id: m.id, result: true }); }',
      '  if (m.method === "emit") { send({ jsonrpc: "2.0", method: "tick", params: {} }); return send({ jsonrpc: "2.0", id: m.id, result: true }); }',
      '  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });',
      '});',
    ].join("\n"));
    const reportFile = path.join(home, "plugin-data", pid, "report.json");
    const report = () => { try { return JSON.parse(fs.readFileSync(reportFile, "utf8")); } catch { return {}; } };
    const waitFile = async (fn, ms = 15000) => { for (let t = 0; t < ms; t += 150) { if (fn()) return true; await sleep(150); } return false; };
    const railBtn = `document.querySelector('[data-testid="rail-plugin"][data-id="${pid}"]')`;

    const t0 = await ev("document.documentElement.dataset.theme");
    await ev("document.querySelector('.titlebar .brand').click(); window.dispatchEvent(new Event('harness:plugins-changed')); true");
    await until(railBtn);
    ok("装了带界面的插件，右侧出现插件栏，有它的图标和名字", await ev(`(() => { const b = ${railBtn}; return !!document.querySelector('[data-testid="plugin-rail"]') && b.title === "你好插件" && b.querySelector("img")?.src.startsWith("data:image/svg+xml") && !!document.querySelector('[data-testid="rail-manage"]'); })()`));
    await shot("0m-plugin-rail");
    await ev(`${railBtn}.click()`);
    await until(`document.querySelector('[data-testid="plugin-consent"]:not([hidden])')`);
    ok("带本机程序的插件第一次打开，先让用户确认，没确认前后台没有跑", (await ev(`document.querySelector('[data-testid="plugin-consent"]').innerText.includes('本机程序') && document.querySelector('[data-testid="plugin-consent"]').innerText.includes('host.storage') && !document.querySelector('[data-testid="plugin-frame"]')`)) && !fs.existsSync(reportFile));
    await shot("0m-plugin-consent");
    await ev(click("plugin-trust"));
    ok("确认后界面加载，后台启动，界面调用后台、存储、事件都通了", await waitFile(() => report().ev === "tick" && report().n === 42));
    const r = report();
    ok("插件拿到自己的上下文；存储读写正常；没声明的网络被拦；不支持的宿主方法有明确错误", r.ctx === pid && r.store?.v === 1 && r.net === "blocked" && String(r.nosup).includes("暂不支持"));
    ok("主题跟随本软件，颜色变量已下发，小组件库在", r.theme === t0 && /^#|rgb/.test(r.primary) && r.kit === true);
    ok("信任记录写在本软件数据目录里", JSON.parse(fs.readFileSync(path.join(home, "plugin-consent.json"), "utf8"))[pid]?.version === "1.0.0");
    ok("右侧栏图标高亮，主区域在插件页", await ev(`${railBtn}.classList.contains("on") && !document.querySelector('[data-testid="plugin-view"]').hidden`));
    await sleep(500);
    await shot("0m-plugin-view");
    await ev(`window.__plugFrame = document.querySelector('[data-testid="plugin-frame"]'); true`);
    await ev(click("theme-toggle"));
    ok("切换主题，插件界面实时跟着变", await waitFile(() => report().theme === (t0 === "dark" ? "light" : "dark")));
    await ev(click("theme-toggle"));
    await ev(click("nav-workbench"));
    await ev(`${railBtn}.click()`);
    await sleep(300);
    ok("切到别的页面再点回来，插件界面还在，没有重新加载", await ev(`document.querySelector('[data-testid="plugin-frame"]') === window.__plugFrame && !document.querySelector('[data-testid="plugin-view"]').hidden`));
    await ev(`${railBtn}.click()`);
    await sleep(200);
    ok("再点一次当前插件图标，回到原来的页面", await ev(`document.querySelector('[data-testid="plugin-view"]').hidden`));
    await ev(click("rail-manage"));
    await until(`document.querySelector('[data-testid="plugins-page"]')`);
    ok("点栏底部的管理按钮，进插件中心", true);
    await ev(`window.harness.pluginUninstall(${JSON.stringify(pid)}).then(r => { window.dispatchEvent(new Event('harness:plugins-changed')); return r.ok; })`);
    await until(`!${railBtn}`);
    // Windows 上进程刚退出时，空目录有时要过一会儿才真正消失；这里只看有没有文件留下
    const hasFiles = d => fs.existsSync(d) && fs.readdirSync(d, { recursive: true, withFileTypes: true }).some(e => e.isFile());
    ok("卸载后，右侧栏图标消失，插件界面被关掉，后台已停、文件删干净", (await ev(`!document.querySelector('[data-testid="plugin-view"]')`)) && (await waitFile(() => !hasFiles(path.join(localDir, pid)))));
  }

  // 连接类插件（如 XXL-JOB）：用「设置 → 连接」里的连接，不需要 DBX
  {
    const pid = "com.fake.xxl";
    const vdir = path.join(localDir, pid, "versions", "1.0.0");
    fs.mkdirSync(path.join(vdir, "ui"), { recursive: true });
    fs.mkdirSync(path.join(vdir, "bin", "x"), { recursive: true });
    fs.writeFileSync(path.join(vdir, "manifest.json"), JSON.stringify({ id: pid, name: "调度插件", version: "1.0.0", permissions: [], entrypoints: { backend: { executable: "bin/x/sidecar.js" }, ui: { root: "ui", entry: "ui/index.html" } }, contributions: [{ type: "connection-provider", database_type: "xxl-job-dbx-plugin", id: pid + ".connection", workbench: pid + ".workbench" }, { type: "workbench", id: pid + ".workbench" }] }));
    fs.writeFileSync(path.join(vdir, "ui", "index.html"), '<!doctype html><html><head><meta charset="utf-8"></head><body><h1>xxl plugin</h1><script src="app.js"></script></body></html>');
    fs.writeFileSync(path.join(vdir, "ui", "app.js"), [
      'const run = async ctx => {',
      '  if (!ctx.connectionId) { await dbxPlugin.invoke("report", { last: { cid: "" } }); return; }',
      '  const r = await dbxPlugin.invoke("xxljob/info", { connectionId: ctx.connectionId });',
      '  await dbxPlugin.invoke("report", { last: { cid: ctx.connectionId, host: r.host, port: r.port, user: r.username, pw: r.password, path: r.config.context_path, env: r.config.environment } });',
      '};',
      'dbxPlugin.ready.then(ctx => { dbxPlugin.onContext(run); run(ctx); });',
    ].join("\n"));
    fs.writeFileSync(path.join(vdir, "bin", "x", "sidecar.js"), [
      'const fs = require("node:fs"), path = require("node:path");',
      'const f = path.join(process.env.DBX_PLUGIN_DATA_DIR, "report.json");',
      'const send = o => process.stdout.write(JSON.stringify(o) + "\\n");',
      'const sessions = new Map();',
      'require("node:readline").createInterface({ input: process.stdin }).on("line", l => {',
      '  const m = JSON.parse(l);',
      '  const ok = r => send({ jsonrpc: "2.0", id: m.id, result: r });',
      '  if (m.method === "plugin/initialize") return ok({ protocolVersion: 1, plugin: { id: process.env.DBX_PLUGIN_ID }, capabilities: ["connections"] });',
      '  if (m.method === "connection/connect") { sessions.set(m.params.connection.id, m.params.connection); return ok(true); }',
      '  if (m.method === "xxljob/info") { const s = sessions.get(m.params.connectionId); return s ? ok(s) : send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "连接尚未建立" } }); }',
      '  if (m.method === "report") { let cur = {}; try { cur = JSON.parse(fs.readFileSync(f, "utf8")); } catch {} fs.writeFileSync(f, JSON.stringify({ ...cur, ...m.params })); return ok(true); }',
      '  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });',
      '});',
    ].join("\n"));
    const reportFile = path.join(home, "plugin-data", pid, "report.json");
    const report = () => { try { return JSON.parse(fs.readFileSync(reportFile, "utf8")); } catch { return {}; } };
    const waitFile = async (fn, ms = 15000) => { for (let t = 0; t < ms; t += 150) { if (fn()) return true; await sleep(150); } return false; };
    const railBtn = `document.querySelector('[data-testid="rail-plugin"][data-id="${pid}"]')`;
    const mkConn = (name, env, machine, url) => ev(`window.harness.connectionSave(${JSON.stringify({ kind: "xxljob", name, env, machine, fields: { url, username: "admin", adminVersion: "3.4" }, secrets: { password: "pw-xyz" } })}).then(r => r.conn.id)`);

    await ev("window.dispatchEvent(new Event('harness:plugins-changed')); true");
    await until(railBtn);
    await ev(`${railBtn}.click()`);
    await until(`document.querySelector('[data-testid="plugin-consent"]:not([hidden])')`);
    await ev(click("plugin-trust"));
    await until(`document.querySelector('[data-testid="plugin-noconn"]')`);
    ok("连接类插件没有连接时，显示「去添加连接」，不加载插件界面（也不再提示要从 DBX 打开）", await ev(`!document.querySelector('[data-testid="plugin-frame"]') && document.querySelector('[data-testid="plugin-noconn"]').innerText.includes('设置') && !document.body.innerText.includes('DBX')`));
    await shot("0s-plugin-noconn");
    await ev(click("plugin-noconn-add"));
    await until(`document.querySelector('[data-testid="connections-page"]')`);
    ok("点「去添加连接」直接进设置里的连接页", await ev(`document.querySelector('[data-testid="settings-title"]').innerText === '连接'`));
    ok("连接类型列表在内容区最左边，紧挨设置导航，右边才是连接内容", await ev(`(() => { const k = document.querySelector('[data-testid="conn-kinds"]').getBoundingClientRect(); const c = document.querySelector('.conn-content').getBoundingClientRect(); const n = document.querySelector('.settings-nav').getBoundingClientRect(); return k.left - n.right < 60 && c.left > k.right && k.width >= 130; })()`));
    await shot("0s-conn-layout");

    const c1 = await mkConn("调度-生产", "生产", "A", "http://127.0.0.1:18080/xxl-job-admin");
    const c2 = await mkConn("调度-测试", "测试", "B", "https://job.test.local:8443/");
    await ev(`${railBtn}.click()`);
    await until(`document.querySelector('[data-testid="plugin-conn-select"]')`);
    ok("有连接后，顶部出现连接选择，每项带环境和机器", await ev(`[...document.querySelectorAll('[data-testid="plugin-conn-select"] option')].map(o => o.innerText).join('|') === '调度-生产 · 生产 · A|调度-测试 · 测试 · B'`));
    ok("插件界面加载，拿到第一个连接，后台已用它连好（地址、账号、环境都对，密码在主进程里交给了后台）", await waitFile(() => report().last?.cid === c1 && report().last.host === "127.0.0.1" && report().last.port === 18080 && report().last.path === "/xxl-job-admin" && report().last.user === "admin" && report().last.pw === "pw-xyz" && report().last.env === "生产"));
    await shot("0s-plugin-conn");
    await ev(setVal('[data-testid="plugin-conn-select"]', c2, "HTMLSelectElement", "change"));
    ok("换一个连接，插件界面按新连接重新加载（https、端口、根路径）", await waitFile(() => report().last?.cid === c2 && report().last.host === "job.test.local" && report().last.port === 8443 && report().last.path === "/" && report().last.env === "测试"));
    await ev(click("plugin-conn-manage"));
    await until(`document.querySelector('[data-testid="connections-page"]')`);
    ok("「管理连接」进设置里的连接页", true);
    for (const id of [c1, c2]) await ev(`window.harness.connectionRemove(${JSON.stringify(id)}).then(r => r.ok)`);
    await ev(`${railBtn}.click()`);
    await until(`document.querySelector('[data-testid="plugin-noconn"]')`);
    ok("连接都删掉后，回到插件页又是「去添加连接」", true);
    await ev(`window.harness.pluginUninstall(${JSON.stringify(pid)}).then(r => { window.dispatchEvent(new Event('harness:plugins-changed')); return r.ok; })`);
    await until(`!${railBtn}`);
    await ev(click("nav-workbench"));
  }

  // 标题栏的「数据库」入口：没有数据库连接时提示去添加；有连接的情况在下面连真 PostgreSQL 时测
  {
    await ev(click("nav-database"));
    await until(`document.querySelector('[data-testid="database-page"]')`);
    ok("标题栏有「数据库」入口；没有数据库连接时提示去添加", await ev(`!!document.querySelector('.titlebar [data-testid="nav-database"]') && (!!document.querySelector('[data-testid="db-empty"]') || !!document.querySelector('[data-testid="db-tree"]'))`));
    await ev(click("nav-workbench"));
  }

  // 数据库类插件（SQL Notebook / Visual Query Builder 这类）：首次要选哪些库给它用；只读；写语句被拦
  {
    const pid = "com.fake.dbplug";
    const vdir = path.join(localDir, pid, "versions", "1.0.0");
    fs.mkdirSync(path.join(vdir, "ui"), { recursive: true });
    fs.mkdirSync(path.join(vdir, "bin", "x"), { recursive: true });
    fs.writeFileSync(path.join(vdir, "manifest.json"), JSON.stringify({ id: pid, name: "数据库插件", version: "1.0.0", permissions: ["host.data:read", "host.schema:read", "host.connections:read"], entrypoints: { backend: { executable: "bin/x/sidecar.js" }, ui: { root: "ui", entry: "ui/index.html" } }, contributions: [{ type: "workbench", id: pid + ".workbench" }] }));
    fs.writeFileSync(path.join(vdir, "ui", "index.html"), '<!doctype html><html><head><meta charset="utf-8"></head><body><h1>db plugin</h1><script src="app.js"></script></body></html>');
    fs.writeFileSync(path.join(vdir, "ui", "app.js"), [
      'dbxPlugin.ready.then(async ctx => {',
      '  const c = dbxPlugin.capabilities;',
      '  const o = { cid: ctx.connectionId || "", dbType: ctx.dbType, name: ctx.name, caps: [c.dataApi, c.schemaMetadataApi, c.connectionsApi] };',
      '  if (ctx.connectionId) {',
      '    try { const r = await dbxPlugin.queryData({ connectionId: ctx.connectionId, sql: "select 1 as n, \'x\' as s" }); o.rows = r.rows; o.cols = r.columns.map(x => x.name + ":" + x.dataType); o.rdb = r.dbType; } catch (e) { o.qerr = String(e.message); }',
      '    try { const w = await dbxPlugin.queryData({ connectionId: ctx.connectionId, sql: "insert into smoke_t(name) values (\'a\')" }); o.iaff = w.affectedRows; } catch (e) { o.ierr = String(e.message); }',
      '    try { await dbxPlugin.queryData({ connectionId: ctx.connectionId, sql: "drop database postgres" }); o.dropped = true; } catch (e) { o.derr = String(e.message); }',
      '    try { const m = await dbxPlugin.getTableMetadata({ connectionId: ctx.connectionId, table: "smoke_t" }); o.meta = m.columns.map(x => x.name + ":" + x.dataType); } catch (e) { o.merr = String(e.message); }',
      '    try { o.conns = (await dbxPlugin.getConnections()).map(x => x.name); } catch (e) { o.cerr = String(e.message); }',
      '  }',
      '  await dbxPlugin.invoke("report", { last: o });',
      '});',
    ].join("\n"));
    fs.writeFileSync(path.join(vdir, "bin", "x", "sidecar.js"), [
      'const fs = require("node:fs"), path = require("node:path");',
      'const f = path.join(process.env.DBX_PLUGIN_DATA_DIR, "report.json");',
      'const send = o => process.stdout.write(JSON.stringify(o) + "\\n");',
      'require("node:readline").createInterface({ input: process.stdin }).on("line", l => {',
      '  const m = JSON.parse(l);',
      '  const ok = r => send({ jsonrpc: "2.0", id: m.id, result: r });',
      '  if (m.method === "plugin/initialize") return ok({ protocolVersion: 1, plugin: { id: process.env.DBX_PLUGIN_ID }, capabilities: [] });',
      '  if (m.method === "report") { fs.writeFileSync(f, JSON.stringify(m.params)); return ok(true); }',
      '  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });',
      '});',
    ].join("\n"));
    const reportFile = path.join(home, "plugin-data", pid, "report.json");
    const report = () => { try { return JSON.parse(fs.readFileSync(reportFile, "utf8")); } catch { return {}; } };
    const waitFile = async (fn, ms = 20000) => { for (let t = 0; t < ms; t += 150) { if (fn()) return true; await sleep(150); } return false; };
    const railBtn = `document.querySelector('[data-testid="rail-plugin"][data-id="${pid}"]')`;

    // 有真 PostgreSQL（out/pgtest 里装了 embedded-postgres）就连真的；没有就连一个没人监听的端口，只验证到错误提示
    let pg = null;
    let port = "54399";
    const pgLib = path.join(root, "out", "pgtest", "node_modules", "embedded-postgres", "dist", "index.js");
    const pgDir = fs.mkdtempSync(path.join(os.tmpdir(), "smoke-pg-"));
    if (fs.existsSync(pgLib)) {
      try {
        const EP = (await import(pathToFileURL(pgLib).href)).default;
        pg = new EP({ databaseDir: pgDir, user: "tester", password: "secret", port: 54331, persistent: false, onLog: () => {}, onError: () => {} });
        await pg.initialise();
        await pg.start();
        const c = pg.getPgClient();
        await c.connect();
        await c.query("create table smoke_t(id serial primary key, name varchar(20) not null default 'x')");
        await c.end();
        port = "54331";
      } catch { pg = null; }
    }
    const mkDb = (name, env) => ev(`window.harness.connectionSave(${JSON.stringify({ kind: "database", name, env, machine: "", fields: { dbType: "postgresql", host: "127.0.0.1", port, username: "tester", database: "postgres" }, secrets: { password: "secret" } })}).then(r => r.conn.id)`);
    const dTest = await mkDb("测试库", "测试");
    const dProd = await mkDb("生产库", "生产");

    await ev("window.dispatchEvent(new Event('harness:plugins-changed')); true");
    await until(railBtn);
    await ev(`${railBtn}.click()`);
    await until(`document.querySelector('[data-testid="plugin-consent"]:not([hidden])')`);
    ok("要读数据库的插件，确认卡里列出所有数据库连接，测试库默认勾上、生产库默认不勾；测试库标可读写，生产库标只读", await ev(`document.querySelector('[data-testid="plugin-db-${dTest}"]').checked === true && document.querySelector('[data-testid="plugin-db-${dProd}"]').checked === false && document.querySelector('[data-testid="plugin-db-${dTest}"]').parentElement.innerText.includes('可读写') && document.querySelector('[data-testid="plugin-db-${dProd}"]').parentElement.innerText.includes('只读')`));
    await shot("0s-plugin-db-consent");
    await ev(click("plugin-trust"));
    await until(`document.querySelector('[data-testid="plugin-conn-select"]')`);
    ok("确认后，顶部连接选择只有已授权的测试库，生产库不在里面", await ev(`[...document.querySelectorAll('[data-testid="plugin-conn-select"] option')].map(o => o.innerText.split(' · ')[0]).join('|') === '测试库'`));
    ok("插件拿到了数据库能力和当前连接（库类型 postgres）", await waitFile(() => report().last?.cid === dTest && report().last.dbType === "postgres" && report().last.name === "测试库" && report().last.caps?.join() === "true,true,true"));
    ok("授权列表里只有测试库（getConnections 看不到没授权的）", await waitFile(() => report().last?.conns?.join() === "测试库"));
    ok("危险语句（DROP DATABASE）连测试库也被拦下，插件拿到「已拦截」", await waitFile(() => report().last?.dropped !== true && /已拦截/.test(report().last?.derr || "")));
    if (pg) ok("测试库可以写：插入一行，返回影响行数 1", await waitFile(() => report().last?.iaff === 1));
    if (pg) {
      ok("真 PostgreSQL：插件查询拿到结果（列名、类型、行）", await waitFile(() => report().last?.rdb === "postgres" && JSON.stringify(report().last.rows) === '[[1,"x"]]' && report().last.cols?.join() === "n:int4,s:text"));
      ok("真 PostgreSQL：表结构能取到（列名和类型）", await waitFile(() => report().last?.meta?.join() === "id:integer,name:character varying"));
    } else {
      ok("（本机没有 PostgreSQL）连不上时给出清楚的错误", await waitFile(() => /连接被拒绝|超时|找不到/.test(report().last?.qerr || "")));
    }
    await shot("0s-plugin-db");

    await ev(click("plugin-db-access"));
    await until(`document.querySelector('[data-testid="plugin-db-panel"]')`);
    await ev(`document.querySelector('[data-testid="plugin-db-${dProd}"]').click()`);
    await until(`document.querySelectorAll('[data-testid="plugin-conn-select"] option').length === 2`);
    ok("在「数据库访问」里勾上生产库，连接选择里立刻多出一项", true);
    await shot("0s-plugin-db-access");
    await ev(setVal('[data-testid="plugin-conn-select"]', dProd, "HTMLSelectElement", "change"));
    ok("换到生产库，插件按新连接重新加载", await waitFile(() => report().last?.cid === dProd && report().last.name === "生产库"));
    ok("生产库只读：同样的插入被拦下，并说明环境", await waitFile(() => report().last?.cid === dProd && report().last.iaff === undefined && /只读/.test(report().last.ierr || "")));

    // 数据库页（工作台）：连真 PostgreSQL 走一遍 连接树 → 看表 → 筛选排序 → 改 / 增 / 删 → 结构 → SQL 查询 → 只读环境
    if (pg) {
      const c2 = pg.getPgClient();
      await c2.connect();
      await c2.query("create table wb_t(id int primary key, name varchar(20), note text); insert into wb_t values (1,'alpha','x'),(2,'beta',null),(3,'gamma','z'); create table wb_nopk(a int)");
      await c2.end();
      await ev("window.confirm = () => true; true");
      const tv = s => `document.querySelector('[data-testid="db-table-view"]:not([hidden]) ${s}')`;
      const tvAll = s => `document.querySelectorAll('[data-testid="db-table-view"]:not([hidden]) ${s}')`;
      const rowsN = `${tvAll('[data-testid="tv-grid"] tbody tr')}.length`;
      const cellAt = (r, c) => tv(`[data-testid="tv-grid"] tbody tr:nth-child(${r}) td:nth-child(${c + 2})`);
      const dbl = sel => ev(`(() => { const el = ${sel}; el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); return true; })()`);
      const typeCell = async text => {
        await until(`document.querySelector('.dg-edit input')`);
        await ev(setVal(".dg-edit input", text, "HTMLInputElement", "input"));
        await ev(`document.querySelector('.dg-edit input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
      };
      const rows = sql => ev(`window.harness.dbQuery({ connectionId: ${JSON.stringify(dTest)}, sql: ${JSON.stringify(sql)} }).then(r => r.ok ? JSON.stringify(r.data.rows) : r.error)`);
      const openTable = async (cid, table) => {
        const conn = `[data-testid="dt-conn"][data-id="${cid}"]`;
        if (!(await ev(`!!document.querySelector('${conn} [data-testid="dt-db"]')`))) await ev(`document.querySelector('${conn} .dt-row.conn').click()`);
        await until(`document.querySelector('${conn} [data-testid="dt-table"][data-table="${table}"]')`);
        await ev(`document.querySelector('${conn} [data-testid="dt-table"][data-table="${table}"]').click()`);
      };

      await ev(click("nav-database"));
      await until(`document.querySelector('[data-testid="db-tree"]')`);
      ok("数据库页左侧列出全部数据库连接，带环境；生产库标只读", await ev(`(() => { const r = [...document.querySelectorAll('[data-testid="dt-conn"]')]; return r.length === 2 && r.some(x => x.innerText.includes('测试库')) && r.some(x => x.innerText.includes('生产库') && x.innerText.includes('只读')); })()`));
      await openTable(dTest, "wb_t");
      ok("展开连接后自动展开默认库和 public，点表就在右边开一个标签", await until(`${rowsN} === 3`) && (await ev(`document.querySelectorAll('[data-testid="db-tab"]').length === 1 && !!document.querySelector('[data-testid="dt-table"][data-table="wb_t"]')`)));
      await until(tv(".dg-key"));
      ok("表头显示字段类型，主键有 PK 标记", await ev(`${tv('[data-testid="tv-grid"] th:nth-child(2)')}.innerText.includes('integer') && !!${tv('[data-testid="tv-grid"] th:nth-child(2) .dg-key')}`));
      await shot("0s-db-workbench");
      const treeOf = `document.querySelector('[data-testid="dt-conn"][data-id="${dTest}"]')`;
      ok("连接树：默认库带「默认库」标记，schema 旁显示备注，库下有「扩展」「事件触发器」，连接下有「查询」", await ev(`(() => { const t = ${treeOf}; return !!t.querySelector('[data-testid="dt-default"]') && t.querySelector('[data-testid="dt-schema"][data-schema="public"]').innerText.includes('standard public schema') && !!t.querySelector('[data-testid="dt-ext"]') && !!t.querySelector('[data-testid="dt-evt"]') && !!t.querySelector('[data-testid="dt-queries"]'); })()`));
      await ev(`${treeOf}.querySelector('[data-testid="dt-ext"]').click()`);
      await until(`[...${treeOf}.querySelectorAll('.dt-row.leaf')].some(x => x.innerText.includes('plpgsql'))`);
      ok("展开「扩展」能看到已装的扩展", true);
      await shot("0s-db-tree");

      await ev(setVal('[data-testid="db-table-view"]:not([hidden]) [data-testid="tv-where"]', "id > 1", "HTMLInputElement", "input"));
      await ev(`${tv('[data-testid="tv-apply"]')}.click()`);
      await until(`${rowsN} === 2`);
      ok("WHERE 条件生效：只剩 2 行", true);
      await ev(`${tv('[data-testid="tv-grid"] th:nth-child(3)')}.click()`);
      await until(`${tv('[data-testid="tv-order"]')}.value === '"name" ASC'`);
      await until(`${cellAt(1, 1)}.innerText.trim() === 'beta'`);
      await ev(`${tv('[data-testid="tv-grid"] th:nth-child(3)')}.click()`);
      await until(`${cellAt(1, 1)}.innerText.trim() === 'gamma'`);
      ok("点表头排序：升序再点降序，ORDER BY 框同步", await ev(`${tv('[data-testid="tv-order"]')}.value === '"name" DESC'`));
      // 可视化筛选：字段下拉（带搜索）+ 运算符 + 值
      await ev(setVal('[data-testid="db-table-view"]:not([hidden]) [data-testid="tv-order"]', "", "HTMLInputElement", "input"));
      await ev(setVal('[data-testid="db-table-view"]:not([hidden]) [data-testid="tv-where"]', "", "HTMLInputElement", "input"));
      await ev(`${tv('[data-testid="tv-apply"]')}.click()`);
      await until(`${rowsN} === 3`);
      await ev(click("tv-filter-btn"));
      await until(`document.querySelector('[data-testid="fb-where"]')`);
      await ev(click("fb-add"));
      await ev(click("fb-col"));
      await until(`document.querySelector('[data-testid="fb-menu"]')`);
      ok("筛选面板：字段下拉列出全部字段", await ev(`document.querySelectorAll('[data-testid="fb-opt"]').length === 3`));
      await ev(setVal('[data-testid="fb-menu"] input', "na", "HTMLInputElement", "input"));
      await until(`document.querySelectorAll('[data-testid="fb-opt"]').length === 1`);
      ok("在字段下拉里搜索能过滤", true);
      await ev(click("fb-opt"));
      await ev(setVal('[data-testid="fb-op"]', "contains", "HTMLSelectElement", "change"));
      await ev(setVal('[data-testid="fb-val"]', "et", "HTMLInputElement", "input"));
      await shot("0s-db-filter");
      await ev(click("fb-apply"));
      await until(`${rowsN} === 1`);
      ok("应用筛选：name 包含 et 只剩 beta，WHERE 框里生成了对应条件", (await ev(`${cellAt(1, 1)}.innerText.trim()`)) === "beta" && (await ev(`${tv('[data-testid="tv-where"]')}.value`)) === `"name"::text ILIKE '%et%'`);
      await ev(click("tv-filter-btn"));
      await until(`document.querySelector('[data-testid="fb-where"]')`);
      await ev(click("fb-clear"));
      await until(`${rowsN} === 3 && ${tv('[data-testid="tv-where"]')}.value === ''`);
      ok("清除筛选：回到全部 3 行", true);
      // 可视化排序
      await ev(click("tv-sort-btn"));
      await until(`document.querySelector('[data-testid="fb-order"]')`);
      await ev(click("fb-sort-add"));
      await ev(click("fb-sort-col"));
      await until(`document.querySelector('[data-testid="fb-menu"]')`);
      await ev(`[...document.querySelectorAll('[data-testid="fb-opt"]')].find(o => o.innerText.startsWith('id')).click()`);
      await ev(setVal('[data-testid="fb-sort-dir"]', "desc", "HTMLSelectElement", "change"));
      await shot("0s-db-sort");
      await ev(click("fb-sort-apply"));
      await until(`${tv('[data-testid="tv-order"]')}.value === '"id" DESC' && ${cellAt(1, 0)}.innerText.trim() === '3'`);
      ok("排序面板：id 降序，第一行是 3", true);
      await ev(click("tv-sort-btn"));
      await until(`document.querySelector('[data-testid="fb-order"]')`);
      await ev(click("fb-sort-clear"));
      await until(`${tv('[data-testid="tv-order"]')}.value === ''`);
      ok("清除排序", true);
      await ev(setVal('[data-testid="db-table-view"]:not([hidden]) [data-testid="tv-where"]', "", "HTMLInputElement", "input"));
      await ev(setVal('[data-testid="db-table-view"]:not([hidden]) [data-testid="tv-order"]', "id", "HTMLInputElement", "input"));
      await ev(`${tv('[data-testid="tv-apply"]')}.click()`);
      await until(`${rowsN} === 3 && ${cellAt(1, 1)}.innerText.trim() === 'alpha'`);
      // 应用会重新查一次；等它回来再动手，不然双击出来的编辑框会被刷新冲掉
      await sleep(500);
      await until(`!${tv('[data-testid="tv-refresh"]')}.disabled`);

      // 改一格：双击 → 输入 → 回车，进「待提交」，提交后真的写进库
      await dbl(cellAt(1, 1));
      await typeCell("ALPHA");
      await until(tv('[data-testid="tv-pending"]'));
      ok("改了一格：出现「待提交」条，这一格高亮，库里还没变", (await ev(`${cellAt(1, 1)}.classList.contains('changed')`)) && (await rows("select name from wb_t where id = 1")) === '[["alpha"]]');
      await ev(click("tv-commit"));
      await until(`!${tv('[data-testid="tv-pending"]')} && ${cellAt(1, 1)}.innerText.trim() === 'ALPHA'`);
      ok("提交后写进库，表格刷新", (await rows("select name from wb_t where id = 1")) === '[["ALPHA"]]');
      // 设为 NULL
      await dbl(cellAt(1, 2));
      await until(`document.querySelector('.dg-edit .dg-null')`);
      await ev(`document.querySelector('.dg-edit .dg-null').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true })); true`);
      await until(tv('[data-testid="tv-pending"]'));
      await ev(click("tv-commit"));
      await until(`!${tv('[data-testid="tv-pending"]')}`);
      ok("把一格设成 NULL 并提交", (await rows("select note from wb_t where id = 1")) === "[[null]]");

      // 新增一行
      await ev(click("tv-add"));
      await until(`${rowsN} === 4`);
      await dbl(cellAt(4, 0));
      await typeCell("4");
      await dbl(cellAt(4, 1));
      await typeCell("delta");
      await ev(click("tv-commit"));
      await until(`!${tv('[data-testid="tv-pending"]')} && ${rowsN} === 4`);
      ok("新增一行：填 id 和 name 后提交，其余字段用默认（空）", (await rows("select id, name, note from wb_t where id = 4")) === '[[4,"delta",null]]');

      // 删一行：点行号选中 → 删除行 → 提交
      await ev(`${tv('[data-testid="tv-grid"] tbody tr:nth-child(2) td.dg-no')}.click()`);
      await ev(click("tv-del"));
      await until(tv('[data-testid="tv-pending"]'));
      ok("删除行先标记（划线），库里还在", (await ev(`${tv('[data-testid="tv-grid"] tbody tr:nth-child(2)')}.classList.contains('deleted')`)) && (await rows("select count(*) from wb_t")) === '[["4"]]');
      await ev(click("tv-commit"));
      await until(`!${tv('[data-testid="tv-pending"]')} && ${rowsN} === 3`);
      ok("提交后这一行真的被删了", (await rows("select id from wb_t order by id")) === "[[1],[3],[4]]");

      // 撤销
      await dbl(cellAt(1, 1));
      await typeCell("zzz");
      await until(tv('[data-testid="tv-pending"]'));
      await ev(`${tv('[data-testid="tv-pending"] button')}.click()`);
      await until(`!${tv('[data-testid="tv-pending"]')}`);
      ok("撤销：修改被丢掉，库没动", (await ev(`${cellAt(1, 1)}.innerText.trim()`)) === "ALPHA" && (await rows("select name from wb_t where id = 1")) === '[["ALPHA"]]');

      // 统计总数、翻页按钮状态、结构
      await ev(`${tv('.tv-foot .link-btn')}.click()`);
      await until(`${tv('.tv-foot')}.innerText.includes('共 3 行')`);
      ok("统计总数", true);
      await ev(click("tv-mode-structure"));
      await until(tv('[data-testid="tv-structure"]'));
      ok("表上方有路径：连接名 › schema@库 › 表名", await ev(`(() => { const t = ${tv('[data-testid="tv-crumb"]')}; return t.querySelector('[data-testid="tv-crumb-conn"]').innerText === '测试库' && t.querySelector('[data-testid="tv-crumb-scope"]').innerText === 'public@postgres' && t.querySelector('[data-testid="tv-crumb-table"]').innerText === 'wb_t'; })()`));
      ok("结构视图的表格铺满整个宽度，不会只占左边一小块", await ev(`(() => { const s = ${tv('[data-testid="tv-structure"]')}; const t = s.querySelector('.st-table'); return t.getBoundingClientRect().width >= s.clientWidth - 40; })()`));
      await shot("0s-db-structure");
      // AI 助手：数据库页输入框上方有 连接 / 库 / schema 选择，提问时带上库和表结构
      await ev(click("nav-assistant"));
      await until(`document.querySelector('[data-testid="ai-ctx"]')`);
      await until(`document.querySelector('[data-testid="ai-ctx-schema"]') && document.querySelector('[data-testid="ai-ctx-schema"]').value === 'public'`);
      ok("数据库页的助手：输入框上方跟着当前表选好了 连接 / 库 / schema", await ev(`(() => { const sel = n => document.querySelector('[data-testid="' + n + '"]'); return sel('ai-ctx-conn').selectedOptions[0].innerText === '测试库' && sel('ai-ctx-db').value === 'postgres' && sel('ai-ctx-schema').value === 'public'; })()`));
      await shot("0s-db-assistant");
      await ev(setVal('[data-testid="assistant-input"]', "统计 wb_t 有几行", "HTMLTextAreaElement", "input"));
      await ev(click("assistant-send"));
      await until(`document.querySelector('[data-testid="assistant-panel"] [data-testid="msg-assistant"][data-status="done"]')`);
      const aiText = await ev(`document.querySelector('[data-testid="assistant-panel"] [data-testid="msg-assistant"]').textContent`);
      ok("提问时带上了库的上下文：连接、schema、表清单、当前表的字段；密码不在里面", ["【数据库上下文】", "连接：测试库", "PostgreSQL", "schema：public", "wb_t", "id integer 主键 非空", "name character varying(20)", "统计 wb_t 有几行"].every(s => aiText.includes(s)) && !aiText.includes("secret"));
      ok("聊天里显示的还是用户打的那句话，上下文只发给 AI 不显示", await ev(`document.querySelector('[data-testid="assistant-panel"] .msg-u-card')?.textContent.trim() === '统计 wb_t 有几行'`));
      await ev(click("assistant-delete"));
      await ev(click("nav-workbench"));
      await sleep(300);
      ok("离开数据库页，库选择就没了", await ev(`!document.querySelector('[data-testid="ai-ctx"]')`));
      await ev(click("assistant-close"));
      await ev(click("nav-database"));
      await until(`document.querySelectorAll('[data-testid="db-tab"]').length >= 1`);
      ok("结构视图：字段、类型、主键、索引", await ev(`(() => { const t = ${tv('[data-testid="tv-structure"]')}.innerText; return t.includes('name') && t.includes('character varying(20)') && t.includes('PK') && t.includes('wb_t_pkey'); })()`));
      await shot("0s-db-structure");
      await ev(click("tv-mode-data"));

      // 无主键的表：能看，也能加行，不能改 / 删已有行
      await openTable(dTest, "wb_nopk");
      await until(`document.querySelectorAll('[data-testid="db-tab"]').length === 2`);
      await until(`document.querySelector('[data-testid="db-table-view"]:not([hidden]) .tv-msg.warn')`);
      ok("没有主键的表提示只能新增、不能改删已有行", await ev(`${tv('.tv-msg.warn')}.innerText.includes('没有主键')`));

      // SQL 编辑器
      await ev(click("db-new-query"));
      await until(`document.querySelector('[data-testid="db-query-view"]:not([hidden]) [data-testid="qv-editor-input"]')`);
      const qin = '[data-testid="db-query-view"]:not([hidden]) [data-testid="qv-editor-input"]';
      await ev(setVal(qin, 'SELECT "id", name\nFROM public.wb_t\nWHERE id >= 1 -- 全部\nORDER BY id;\n', "HTMLTextAreaElement", "input"));
      await until(`document.querySelectorAll('[data-testid="db-query-view"]:not([hidden]) .sql-hl span').length >= 6`);
      ok("SQL 编辑器：行号和语法高亮", await ev(`(() => { const v = document.querySelector('[data-testid="db-query-view"]:not([hidden])'); return v.querySelector('.sql-gutter').innerText.startsWith('1') && !!v.querySelector('.sq-kw') && !!v.querySelector('.sq-id') && !!v.querySelector('.sq-com'); })()`));
      await ev(`document.querySelector('[data-testid="db-query-view"]:not([hidden]) [data-testid="qv-run"]').click(); true`);
      await until(`document.querySelector('[data-testid="db-query-view"]:not([hidden]) [data-testid="qv-count"]')`);
      ok("运行查询：结果表格 + 行数", (await ev(`document.querySelector('[data-testid="db-query-view"]:not([hidden]) [data-testid="qv-count"]').innerText.startsWith('3 行') && document.querySelectorAll('[data-testid="db-query-view"]:not([hidden]) [data-testid="qv-grid"] tbody tr').length === 3`)));
      await shot("0s-db-query");
      // 保存查询：出现在左边「查询」里，点它切回这个标签，能删
      await ev(click("qv-save"));
      await until(`document.querySelector('[data-testid="qv-name"]')`);
      await ev(setVal('[data-testid="qv-name"]', "全部数据", "HTMLInputElement", "input"));
      await ev(click("qv-name-ok"));
      await until(`[...document.querySelectorAll('[data-testid="db-tab"]')].some(t => t.innerText.includes('全部数据'))`);
      ok("保存查询：标签改成查询名", true);
      await ev(`${treeOf}.querySelector('[data-testid="dt-queries"]').click()`);
      await until(`${treeOf}.querySelector('[data-testid="dt-saved"]')`);
      ok("左边「查询」里出现保存的查询", await ev(`${treeOf}.querySelector('[data-testid="dt-saved"]').innerText.includes('全部数据')`));
      await ev(`${treeOf}.querySelector('[data-testid="dt-saved"]').click()`);
      await sleep(300);
      ok("点已经开着的查询：切过去，不重复开标签", await ev(`document.querySelectorAll('[data-testid="db-tab"]').length === 3`));
      await shot("0s-db-saved");
      await ev(`${treeOf}.querySelector('[data-testid="dt-saved-del"]').click()`);
      await until(`!${treeOf}.querySelector('[data-testid="dt-saved"]')`);
      ok("删除保存的查询", true);

      // 右键菜单：新建查询 / 打开默认查询 / 粘贴 SQL
      const ctx = sel => ev(`${sel}.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 220 })); true`);
      const tabsN = `document.querySelectorAll('[data-testid="db-tab"]').length`;
      await ctx(`${treeOf}.querySelector('[data-testid="dt-queries"]')`);
      await until(`document.querySelector('[data-testid="dt-menu"]')`);
      ok("右键「查询」：菜单有 新建查询 / 打开默认查询 / 粘贴 SQL，带快捷键", await ev(`(() => { const m = document.querySelector('[data-testid="dt-menu"]'); const t = m.innerText.replace(/\\s+/g, ' '); return t.includes('新建查询') && t.includes('打开默认查询') && t.includes('粘贴 SQL') && t.includes('Ctrl') && !!m.querySelector('[data-testid="dt-menu-paste"]'); })()`));
      await shot("0s-db-ctxmenu");
      await ev(click("dt-menu-default"));
      await until(`${tabsN} === 4`);
      ok("打开默认查询：新开一个「默认查询」标签", await ev(`[...document.querySelectorAll('[data-testid="db-tab"]')].some(t => t.innerText.includes('默认查询'))`));
      await ctx(`${treeOf}.querySelector('[data-testid="dt-queries"]')`);
      await until(`document.querySelector('[data-testid="dt-menu"]')`);
      await ev(click("dt-menu-default"));
      await sleep(300);
      ok("再点一次打开默认查询：切过去，不重复开", (await ev(tabsN)) === 4);
      await ctx(`${treeOf}.querySelector('[data-testid="dt-schema"][data-schema="public"]')`);
      await until(`document.querySelector('[data-testid="dt-menu"]')`);
      await ev(click("dt-menu-new"));
      await until(`${tabsN} === 5`);
      ok("右键 schema → 新建查询：开一个新标签，位置是这个 schema", true);
      for (let i = 0; i < 2; i++) await ev(`(() => { const xs = [...document.querySelectorAll('.dbw-tab .dbw-tab-x')]; xs[xs.length - 1].click(); return true; })()`);
      await until(`${tabsN} === 3`);

      // 联想补齐：关键字 / 片段、表名、别名后的字段
      const typeInto = async text => {
        for (let i = 1; i <= text.length; i++) await ev(setVal(qin, text.slice(0, i), "HTMLTextAreaElement", "input"));
      };
      const qEl = `document.querySelector(${JSON.stringify(qin)})`;
      const comp = `document.querySelector('[data-testid="sql-comp"]')`;
      const compItems = `[...document.querySelectorAll('[data-testid="sql-comp-item"]')]`;
      await typeInto("sel");
      await until(comp);
      ok("写 SQL 时有联想：输入 sel，第一个是 select * 片段，后面有 SELECT 等关键字", await ev(`(() => { const l = ${compItems}; return l[0].dataset.kind === 'snippet' && l[0].innerText.includes('select *') && l[0].innerText.includes('SELECT * FROM table LIMIT 100;') && l.some(x => x.dataset.kind === 'keyword' && x.querySelector('.sql-comp-label').innerText === 'SELECT'); })()`));
      await shot("0s-db-complete-kw");
      await ev(`${qEl}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
      await until(`!${comp}`);
      ok("Esc 收起联想", true);
      await ev(setVal(qin, "select * from wb", "HTMLTextAreaElement", "input"));
      await ev(setVal(qin, "select * from wb_", "HTMLTextAreaElement", "input"));
      await until(`${comp} && ${compItems}.some(x => x.dataset.kind === 'table')`);
      ok("FROM 后面输入 wb_：候选里是这个库的表（wb_t、wb_nopk），表排最前", await ev(`(() => { const l = ${compItems}; return l[0].dataset.kind === 'table' && l.some(x => x.innerText.includes('wb_nopk')) && l[0].innerText.includes('wb_t'); })()`));
      await shot("0s-db-complete-table");
      await ev(`${qEl}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); true`);
      await until(`!${comp}`);
      ok("回车选中：表名写进编辑器", (await ev(`${qEl}.value`)) === "select * from wb_t");
      await typeInto("select * from wb_t t where t.");
      await until(`${comp} && ${compItems}.length === 3`);
      ok("别名 t. 后面给这张表的字段（id / name / note），带类型", await ev(`(() => { const l = ${compItems}; return l.every(x => x.dataset.kind === 'column') && l.map(x => x.querySelector('.sql-comp-label').innerText).join() === 'id,name,note' && l[0].innerText.includes('integer'); })()`));
      await shot("0s-db-complete-col");
      await ev(`${qEl}.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true`);
      await ev(setVal(qin, "update wb_t set note = 'viaq' where id = 3;\n", "HTMLTextAreaElement", "input"));
      await ev(`document.querySelector('[data-testid="db-query-view"]:not([hidden]) [data-testid="qv-run"]').click(); true`);
      await until(`document.querySelector('[data-testid="db-query-view"]:not([hidden]) [data-testid="qv-ok"]')`);
      ok("测试库里的写语句：提示影响 1 行，真的写进去了", (await ev(`document.querySelector('[data-testid="qv-ok"]').innerText.includes('影响 1 行')`)) && (await rows("select note from wb_t where id = 3")) === '[["viaq"]]');
      await ev(setVal(qin, "drop database postgres;\n", "HTMLTextAreaElement", "input"));
      await ev(`document.querySelector('[data-testid="db-query-view"]:not([hidden]) [data-testid="qv-run"]').click(); true`);
      await until(`document.querySelector('[data-testid="db-query-view"]:not([hidden]) [data-testid="qv-err"]')`);
      ok("危险语句被拦下并说明原因", await ev(`document.querySelector('[data-testid="qv-err"]').innerText.includes('已拦截')`));

      // 工具栏图标按钮 + 提示文字；每条完整语句行首的运行按钮
      const vq = `document.querySelector('[data-testid="db-query-view"]:not([hidden])')`;
      const hover = async q => {
        const r = await ev(`(() => { const b = ${vq}.querySelector(${JSON.stringify(q)}).getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
        await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x - 3, y: r.y - 3 });
        await cdp("Input.dispatchMouseEvent", { type: "mouseMoved", x: r.x, y: r.y });
        await sleep(600);
      };
      ok("工具栏是图标按钮：运行 / 运行全部 / 执行计划 / 格式化 / 注释 / 保存，都带提示文字", await ev(`(() => { const ids = ['qv-run','qv-run-all','qv-explain','qv-format','qv-comment','qv-save']; return ids.every(i => { const b = ${vq}.querySelector('[data-testid="' + i + '"]'); return b && b.classList.contains('qv-ib') && b.dataset.tip && !b.innerText.trim(); }); })()`));
      await hover('[data-testid="qv-run"]');
      ok("鼠标停在「运行」上：弹出提示文字（Ctrl + Enter）", await ev(`(() => { const b = ${vq}.querySelector('[data-testid="qv-run"]'); const s = getComputedStyle(b, '::after'); return s.content.includes('Ctrl + Enter') && s.opacity === '1' && s.visibility === 'visible'; })()`));
      await shot("0s-db-toolbar-tip");
      const multi = "select 1 as a;\n\nselect id from wb_t order by id;\n-- 注释\nselect 3 as c";
      await ev(setVal(qin, multi, "HTMLTextAreaElement", "input"));
      await until(`${vq}.querySelectorAll('[data-testid="sql-run-stmt"]').length === 3`);
      ok("自动识别完整语句：3 条语句、行首各有一个运行按钮（空行、注释行没有）", await ev(`(() => { const g = ${vq}.querySelector('.sql-gutter'); const rows = [...g.children]; return [0,2,4].every(i => rows[i].querySelector('[data-testid="sql-run-stmt"]')) && [1,3].every(i => !rows[i].querySelector('[data-testid="sql-run-stmt"]')); })()`));
      await hover('.sql-gutter > div:nth-child(3) [data-testid="sql-run-stmt"]');
      await shot("0s-db-stmt-run");
      await ev(`${vq}.querySelectorAll('[data-testid="sql-run-stmt"]')[1].click(); true`);
      await until(`${vq}.querySelector('[data-testid="qv-count"]')`);
      ok("点第二条语句行首的按钮：只运行这一条（3 行 id）", (await ev(`${vq}.querySelector('[data-testid="qv-count"]').innerText.startsWith('3 行') && ${vq}.querySelector('.qv-ran').innerText.startsWith('select id from wb_t')`)));
      await ev(`${vq}.querySelectorAll('[data-testid="sql-run-stmt"]')[0].click(); true`);
      await until(`${vq}.querySelector('[data-testid="qv-ran"], .qv-ran').innerText.startsWith('select 1')`);
      ok("点第一条的按钮：结果换成 select 1", await ev(`${vq}.querySelector('[data-testid="qv-count"]').innerText.startsWith('1 行')`));
      await ev(click("qv-run-all"));
      await until(`${vq}.querySelector('.qv-ran').innerText.includes('共执行 3 条')`);
      ok("运行全部：依次执行 3 条，表格是最后一条（select 3）的结果", await ev(`${vq}.querySelector('[data-testid="qv-grid"] tbody td:last-child, [data-testid="qv-grid"] tbody td').innerText.length > 0 && ${vq}.querySelector('[data-testid="qv-grid"] thead').innerText.includes('c')`));
      await ev(setVal(qin, "select 1;\nselect * from no_such_table_x;\nselect 3;", "HTMLTextAreaElement", "input"));
      await ev(click("qv-run-all"));
      await until(`${vq}.querySelector('[data-testid="qv-err"]')`);
      ok("运行全部遇到错误就停，并说明是第几条", await ev(`${vq}.querySelector('[data-testid="qv-err"]').innerText.includes('第 2 条')`));
      await ev(setVal(qin, "select id from wb_t where id = 1;", "HTMLTextAreaElement", "input"));
      await ev(click("qv-explain"));
      await until(`${vq}.querySelector('[data-testid="qv-grid"]')`);
      ok("执行计划：前面加 EXPLAIN，看到计划（不真的执行）", await ev(`${vq}.querySelector('[data-testid="qv-grid"]').innerText.includes('Scan') && ${vq}.querySelector('.qv-ran').innerText.startsWith('select id')`));
      await ev(setVal(qin, "select a,b from wb_t where x=1 and y>2 order by a desc", "HTMLTextAreaElement", "input"));
      await ev(click("qv-format"));
      await until(`${qEl}.value.includes('\\n')`);
      ok("格式化：关键字大写、子句换行", (await ev(`${qEl}.value`)) === "SELECT\n  a,\n  b\nFROM wb_t\nWHERE x=1\n  AND y>2\nORDER BY a DESC");
      await ev(`${qEl}.focus(); ${qEl}.setSelectionRange(0, 0); true`);
      await ev(click("qv-comment"));
      await until(`${qEl}.value.startsWith('-- SELECT')`);
      ok("注释按钮：给光标所在行加 --，再点取消", true);
      await ev(click("qv-comment"));
      await until(`${qEl}.value.startsWith('SELECT')`);
      ok("再点一次取消注释", true);

      // 切走再回来：打开的标签还在
      await ev(click("nav-workbench"));
      await ev(click("nav-database"));
      await until(`document.querySelectorAll('[data-testid="db-tab"]').length === 3`);
      ok("切到别的页面再回来，打开的标签和写好的 SQL 都还在", await ev(`document.querySelectorAll('[data-testid="db-tab"]').length === 3`));

      // 生产库：只读，不能改
      await openTable(dProd, "wb_t");
      await until(`document.querySelectorAll('[data-testid="db-tab"]').length === 4`);
      await until(`${rowsN} === 3`);
      ok("生产库的表：标「只读」，没有新增 / 删除按钮，双击单元格不能编辑", (await ev(`!!${tv('.db-rw.ro')} && !${tv('[data-testid="tv-add"]')} && !${tv('[data-testid="tv-del"]')}`)) && (await dbl(cellAt(1, 1)), !(await ev(`!!document.querySelector('.dg-edit input')`))));
      ok("就算绕过界面直接调接口，生产库的修改也被拦下", await ev(`window.harness.dbApply({ connectionId: ${JSON.stringify(dProd)}, schema: 'public', table: 'wb_t', ops: [{ kind: 'delete', key: { id: 1 } }] }).then(r => !r.ok && r.error.includes('只读'))`));
      ok("生产库数据没动", (await rows("select count(*) from wb_t")) === '[["3"]]');
      await ev(click("nav-workbench"));
    }

    for (const id of [dTest, dProd]) await ev(`window.harness.connectionRemove(${JSON.stringify(id)}).then(r => r.ok)`);
    await ev(`window.harness.pluginUninstall(${JSON.stringify(pid)}).then(r => { window.dispatchEvent(new Event('harness:plugins-changed')); return r.ok; })`);
    await until(`!${railBtn}`);
    await ev(click("nav-workbench"));
    if (pg) {
      await pg.stop().catch(() => {});
    }
    try { fs.rmSync(pgDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}
  }
  // 首页「今日待办」：来自「待办 Todo」插件，没信任时给提示，很多时折叠
  {
    const pid = "com.lwai.todo";
    const vdir = path.join(localDir, pid, "versions", "1.0.0");
    fs.mkdirSync(path.join(vdir, "ui"), { recursive: true });
    fs.mkdirSync(path.join(vdir, "bin", "x"), { recursive: true });
    fs.writeFileSync(path.join(vdir, "manifest.json"), JSON.stringify({ id: pid, name: "待办 Todo", version: "1.0.0", permissions: [], entrypoints: { backend: { executable: "bin/x/sidecar.js" }, ui: { root: "ui", entry: "ui/index.html" } } }));
    fs.writeFileSync(path.join(vdir, "ui", "index.html"), "<!doctype html><html><head><meta charset=\"utf-8\"></head><body>todo</body></html>");
    fs.writeFileSync(path.join(vdir, "bin", "x", "sidecar.js"), [
      'const send = o => process.stdout.write(JSON.stringify(o) + "\\n");',
      'const fs = require("node:fs"), path = require("node:path");',
      'const at = (days, h, m) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, m, 0, 0); return d.toISOString(); };',
      'const T = (title, o) => ({ id: title, groupId: "g", title, priority: "medium", done: false, subtasks: [], ...o });',
      'const data = { groups: [{ id: "g", name: "工作" }], tasks: [',
      '  T("逾期一", { dueAt: at(-3, 18, 0) }), T("逾期二", { dueAt: at(-1, 9, 0), priority: "high" }),',
      '  T("今天一", { dueAt: at(0, 23, 58) }), T("今天二", { dueAt: at(0, 23, 59), subtasks: [{ done: true }, { done: false }] }), T("今天三", { dueAt: at(0, 23, 57), priority: "low" }),',
      '  T("今天开始", { startAt: at(0, 0, 1) }), T("明天", { dueAt: at(1, 10, 0) }), T("做完了", { dueAt: at(-2, 10, 0), done: true }) ] };',
      'require("node:readline").createInterface({ input: process.stdin }).on("line", l => {',
      '  const m = JSON.parse(l);',
      '  if (m.method === "plugin/initialize") return send({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: 1, plugin: { id: process.env.DBX_PLUGIN_ID }, capabilities: [] } });',
      '  if (m.method === "todos/load") return send({ jsonrpc: "2.0", id: m.id, result: { ok: true, data: fs.existsSync(path.join(process.env.DBX_PLUGIN_DATA_DIR, "empty")) ? { ...data, tasks: [] } : data, rev: 1, dir: "x", configured: true } });',
      '  send({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "no" } });',
      '});',
    ].join("\n"));
    const railBtn = `document.querySelector('[data-testid="rail-plugin"][data-id="${pid}"]')`;
    const rows = () => ev(`document.querySelectorAll('[data-testid="todo-row"]').length`);

    await ev(click("nav-workbench"));
    await ev("document.querySelector('.titlebar .brand').click(); window.dispatchEvent(new Event('harness:plugins-changed')); true");
    await until(`document.querySelector('[data-testid="home-todos"][data-state="untrusted"]')`);
    ok("装了待办插件但还没信任：首页给提示，不显示事项", await ev(`document.querySelector('[data-testid="todos-untrusted"]').innerText.includes('信任') && !document.querySelector('[data-testid="todo-row"]')`));
    await ev(`window.harness.pluginTrust(${JSON.stringify(pid)})`);
    await ev("window.dispatchEvent(new Event('harness:plugins-changed')); window.dispatchEvent(new Event('focus')); true");
    await until(`document.querySelector('[data-testid="home-todos"][data-state="ok"]')`);
    ok("信任后，首页「今日待办」显示逾期 + 今天到期 + 今天开始的未完成事项（明天的、做完的不算）", (await ev(`document.querySelector('[data-testid="home-todos"]').dataset.count`)) === "6");
    ok("逾期的排最前，标着逾期天数；高优先级在前", await ev(`(() => { const r = [...document.querySelectorAll('[data-testid="todo-row"]')]; return r[0].dataset.kind === 'overdue' && r[0].innerText.includes('逾期二') && r[0].innerText.includes('逾期 1 天') && r[1].innerText.includes('逾期一'); })()`));
    ok("事项很多时折叠：先显示 5 条，按钮写着还有几项", (await rows()) === 5 && (await ev(`document.querySelector('[data-testid="todos-fold"]').innerText.includes('还有 1 项')`)));
    await shot("0t-home-todos");
    await ev(click("todos-fold"));
    ok("展开后显示全部，再点收起", (await rows()) === 6 && (await ev(click("todos-fold")), (await rows()) === 5));
    // 今天没有事项：整块不显示；有了再出现
    const flag = path.join(home, "plugin-data", pid, "empty");
    fs.writeFileSync(flag, "1");
    await ev("window.dispatchEvent(new Event('focus')); true");
    await until(`!document.querySelector('[data-testid="home-todos"]')`);
    ok("今天没有待办事项时，首页这块整个不显示", true);
    await shot("0t-home-no-todos");
    fs.rmSync(flag);
    await ev("window.dispatchEvent(new Event('focus')); true");
    await until(`document.querySelector('[data-testid="home-todos"][data-state="ok"]')`);
    ok("有了事项又出现", true);
    await ev(`document.querySelector('[data-testid="todo-row"]').click()`);
    await until(`document.querySelector('[data-testid="plugin-view"][data-plugin="${pid}"]:not([hidden])')`);
    ok("点事项或「打开待办」，直接打开待办插件", true);
    await ev(`document.querySelector('.titlebar .brand').click(); true`);
    await ev(`window.harness.pluginUninstall(${JSON.stringify(pid)}).then(r => { window.dispatchEvent(new Event('harness:plugins-changed')); return r.ok; })`);
    await until(`!${railBtn}`);
    ok("卸载插件后，首页不再有这块", await ev(`!document.querySelector('[data-testid="home-todos"]')`) || (await sleep(800), await ev(`!document.querySelector('[data-testid="home-todos"]')`)));
  }

  // 自动化任务：右上角入口，新建 / 立即运行 / 暂停 / 按时触发 / 删除
  await ev(click("nav-automation"));
  await until(`document.querySelector('[data-testid="automations"]')`);
  ok("右上角有自动化任务入口，进去是空状态", await ev(`document.querySelector('[data-testid="nav-automation"]').closest('.titlebar-tools') !== null && document.querySelector('[data-testid="automations"] h1').innerText === '自动化任务' && !!document.querySelector('[data-testid="auto-empty"]') && ['on','paused','ended','all'].every(k => !!document.querySelector('[data-testid="auto-tab-' + k + '"]'))`));
  await shot("0n-automation-empty");
  await ev(click("auto-new"));
  await until(`document.querySelector('[data-testid="auto-editor"]')`);
  await ev(click("auto-f-save"));
  await until(`document.querySelector('[data-testid="auto-f-err"]')`);
  ok("没填名称不能保存，并提示原因", await ev(`document.querySelector('[data-testid="auto-f-err"]').innerText.includes('名称')`));
  await ev(setVal('[data-testid="auto-f-name"]', "每日巡检", "HTMLInputElement", "input"));
  await ev(setVal('[data-testid="auto-f-prompt"]', "总结一下今天的工作", "HTMLTextAreaElement", "input"));
  await ev(setVal('[data-testid="auto-f-kind"]', "weekly", "HTMLSelectElement", "change"));
  await until(`document.querySelector('[data-testid="auto-f-days"]')`);
  ok("选每周会出现星期几，并预告下次运行时间", await ev(`document.querySelectorAll('[data-testid="auto-f-days"] button').length === 7 && document.querySelector('[data-testid="auto-f-preview"]').innerText.startsWith('下次运行')`));
  await ev(setVal('[data-testid="auto-f-kind"]', "daily", "HTMLSelectElement", "change"));
  await ev(setVal('[data-testid="auto-f-time"]', "09:30", "HTMLInputElement", "input"));
  await shot("0n-automation-editor");
  await ev(click("auto-f-save"));
  await until(`document.querySelector('[data-testid="auto-item"]')`);
  ok("保存后出现在「已开启」里：名称、每天 09:30、下次运行时间", await ev(`(() => { const c = document.querySelector('[data-testid="auto-item"]'); return c.dataset.status === 'on' && c.querySelector('[data-testid="auto-name"]').innerText === '每日巡检' && c.querySelector('[data-testid="auto-schedule"]').innerText === '每天 09:30' && c.innerText.includes('下次'); })()`));
  await ev(click("auto-run"));
  await until(`document.querySelector('[data-testid="auto-item"] .auto-meta .ph.ok')`, 30000);
  await ev(click("auto-runs-toggle"));
  await until(`document.querySelector('[data-testid="auto-run-row"]')`);
  ok("立即运行：用 Agent 跑完，运行记录里有一条成功的手动记录", await ev(`(() => { const r = document.querySelector('[data-testid="auto-run-row"]'); return r.dataset.status === 'done' && r.innerText.includes('手动'); })()`));
  await ev(`document.querySelector('.auto-run-head').click()`);
  await until(`document.querySelector('[data-testid="auto-run-text"]')`);
  ok("展开能看到 Agent 的回答", await ev(`document.querySelector('[data-testid="auto-run-text"]').innerText.trim().length > 0`));
  await shot("0n-automation-list");
  await ev(click("auto-switch"));
  await until(`!document.querySelector('[data-testid="auto-item"]')`);
  ok("暂停后从「已开启」消失，在「已暂停」里", (await ev(`document.querySelector('[data-testid="auto-tab-paused"] .auto-count')?.innerText`)) === "1");
  await ev(click("auto-tab-paused"));
  await until(`document.querySelector('[data-testid="auto-item"][data-status="paused"]')`);
  ok("已暂停的任务没有「下次运行」", await ev(`!document.querySelector('[data-testid="auto-item"]').innerText.includes('下次')`));
  // 按时触发：用接口建一个 2 秒后运行一次的任务，到点应自动运行并变成已结束
  await ev(`window.harness.automationSave({ name: '定时一次', prompt: '报个到', schedule: { kind: 'once', at: Date.now() + 2000 } })`);
  await until(`window.harness.automationList().then(l => { const a = l.find(x => x.name === '定时一次'); return a && a.ended && a.runs.length === 1 && a.runs[0].status === 'done' && !a.runs[0].manual; })`, 40000);
  ok("到点自动运行：一次性任务跑完变成已结束，记录不是手动触发", true);
  await ev(click("auto-tab-ended"));
  await until(`document.querySelector('[data-testid="auto-item"][data-status="ended"]')`);
  ok("已结束的任务出现在「已结束」里，不再有开关", await ev(`!document.querySelector('[data-testid="auto-item"][data-status="ended"] [data-testid="auto-switch"]')`));
  await ev(click("auto-tab-all"));
  await ev(`document.querySelector('[data-testid="auto-edit"]').click()`);
  await until(`document.querySelector('[data-testid="auto-editor"]')`);
  ok("编辑：带出原来的内容", await ev(`document.querySelector('[data-testid="auto-f-name"]').value.length > 0 && document.querySelector('[data-testid="auto-f-prompt"]').value.length > 0`));
  await ev(click("auto-f-cancel"));
  while (await ev(`!!document.querySelector('[data-testid="auto-del"]')`)) {
    await ev(click("auto-del"));
    await ev(click("auto-del-confirm"));
    await sleep(300);
  }
  ok("删除后回到空状态", await ev(`!!document.querySelector('[data-testid="auto-empty"]')`));
  await ev(click("nav-automation"));
  ok("再点一次右上角图标回到原来的页面", await ev(`!document.querySelector('[data-testid="automations"]')`));

  // 设置 · 连接：英文侧栏标题、五类连接、环境/机器分组、密码不外泄、测试连接
  {
    const f = (k, v, proto = "HTMLInputElement", evt = "input") => ev(setVal(`[data-testid="conn-f-${k}"]`, v, proto, evt));
    const sel = (k, v) => f(k, v, "HTMLSelectElement", "change");
    const cards = () => ev(`[...document.querySelectorAll('[data-testid="conn-card"]')].map(c => ({ name: c.querySelector('[data-testid="conn-name"]').innerText, env: c.dataset.env, machine: c.querySelector('[data-testid="conn-machine"]')?.innerText.trim() ?? '' }))`);
    const saveConn = async () => {
      await ev(click("conn-f-save"));
      await until(`!document.querySelector('[data-testid="conn-editor"]')`);
    };
    await ev(click("nav-settings"));
    await until(`document.querySelector('[data-testid="settings-connections"]')`);
    ok("设置侧栏的标题是英文：SKILLS、RULES、ACTIONS", await ev(`['skills', 'rules', 'actions'].every(k => document.querySelector('[data-testid="settings-' + k + '"]').innerText.trim() === k.toUpperCase())`));
    ok("设置里多了「连接」，在办公集成后面", await ev(`(() => { const ids = [...document.querySelectorAll('[data-testid^="settings-"]')].map(b => b.dataset.testid); return ids.indexOf('settings-connections') === ids.indexOf('settings-office') + 1; })()`));
    await ev(click("settings-connections"));
    await until(`document.querySelector('[data-testid="connections-page"]')`);
    ok("连接页有五类：XXL-JOB、数据库、Redis、服务器、内嵌终端", (await ev(`['xxljob', 'database', 'redis', 'server', 'terminal'].map(k => document.querySelector('[data-testid="conn-kind-' + k + '"]')?.innerText.replace(/\\d+$/, '').trim()).join('|')`)) === "XXL-JOB|数据库|Redis|服务器|内嵌终端");
    ok("还没有连接时显示空状态", await ev(`!!document.querySelector('[data-testid="conn-empty"]')`));
    await shot("0r-connections-empty");

    // 数据库：生产 / 测试，两台机器
    await ev(click("conn-kind-database"));
    await ev(click("conn-new"));
    await until(`document.querySelector('[data-testid="conn-editor"]')`);
    await ev(click("conn-f-save"));
    await until(`document.querySelector('[data-testid="conn-f-err"]')`);
    ok("没填名称不能保存，并提示原因", await ev(`document.querySelector('[data-testid="conn-f-err"]').innerText.includes('名称')`));
    await f("name", "订单库");
    await sel("env", "生产");
    await f("machine", "主库-A");
    await sel("dbType", "clickhouse");
    ok("换数据库类型会带出默认端口", (await ev(`document.querySelector('[data-testid="conn-f-port"]').value`)) === "9000");
    await f("host", "127.0.0.1");
    await f("port", String(LLM_PORT));
    await f("username", "root");
    await f("password", "s3cret-pw-123");
    await ev(click("conn-ed-test"));
    await until(`document.querySelector('[data-testid="conn-ed-result"].ok')`);
    ok("编辑框里「测试连接」能连上本机端口", true);
    await shot("0r-connections-editor");
    await saveConn();
    await until(`document.querySelector('[data-testid="conn-card"]')`);

    await ev(click("conn-new"));
    await until(`document.querySelector('[data-testid="conn-editor"]')`);
    await f("name", "订单库");
    await sel("env", "测试");
    await sel("dbType", "clickhouse");
    await f("host", "127.0.0.1");
    await f("port", "1");
    await ev(click("conn-f-save"));
    await until(`document.querySelector('[data-testid="conn-f-err"]')`);
    ok("同一类里名称重复保存不了", await ev(`document.querySelector('[data-testid="conn-f-err"]').innerText.includes('已经有')`));
    await f("name", "订单库-测试");
    await f("machine", "测试机-1");
    await saveConn();
    await until(`document.querySelectorAll('[data-testid="conn-card"]').length === 2`);
    const cs = await cards();
    ok("同一类可以有多个，按环境分组，每个有机器", cs.length === 2 && cs[0].env === "测试" && cs[0].machine === "测试机-1" && cs[1].env === "生产" && cs[1].machine === "主库-A");
    ok("环境筛选：有全部、生产、测试", await ev(`['all', '生产', '测试'].every(e => !!document.querySelector('[data-testid="conn-env-' + e + '"]'))`));
    await ev(click("conn-env-测试"));
    await until(`document.querySelectorAll('[data-testid="conn-card"]').length === 1`);
    ok("按环境筛选只剩这个环境的连接", (await cards())[0].name === "订单库-测试");
    await ev(click("conn-env-all"));
    await until(`document.querySelectorAll('[data-testid="conn-card"]').length === 2`);
    await ev(click("conn-test-all"));
    await until(`document.querySelectorAll('[data-testid="conn-result"].ok').length === 1 && document.querySelectorAll('[data-testid="conn-result"].bad').length === 1`, 30000);
    ok("全部测试：能连上的显示成功，连不上的显示失败原因", await ev(`document.querySelector('[data-testid="conn-card"][data-env="测试"] [data-testid="conn-result"]').innerText.length > 4`));
    await shot("0r-connections-list");

    // 密码不外泄
    const listJson = await ev(`window.harness.connectionList().then(l => JSON.stringify(l))`);
    ok("接口返回里没有密码，只有「已设置」标记", !listJson.includes("s3cret-pw-123") && listJson.includes('"password":true'));
    const connFile = fs.readFileSync(path.join(home, "connections.json"), "utf8");
    const secFile = fs.readFileSync(path.join(home, "connection-secrets.json"), "utf8");
    ok("连接配置文件和密码文件里都没有明文密码，都在本软件数据目录", !connFile.includes("s3cret-pw-123") && !secFile.includes("s3cret-pw-123"));
    await ev(`document.querySelector('[data-testid="conn-card"][data-env="生产"] [data-testid="conn-edit"]').click()`);
    await until(`document.querySelector('[data-testid="conn-editor"]')`);
    ok("编辑时密码框不回显，提示已设置", await ev(`(() => { const p = document.querySelector('[data-testid="conn-f-password"]'); return p.value === '' && p.placeholder.includes('已设置'); })()`));
    await f("password", "eye-test-1");
    ok("密码框默认隐藏，点眼睛能显示，再点又隐藏", (await ev(`document.querySelector('[data-testid="conn-f-password"]').type`)) === "password" && (await ev(`(document.querySelector('[data-testid="conn-f-password-eye"]').click(), 0)`), await ev(`document.querySelector('[data-testid="conn-f-password"]').type`)) === "text" && (await ev(`(document.querySelector('[data-testid="conn-f-password-eye"]').click(), 0)`), await ev(`document.querySelector('[data-testid="conn-f-password"]').type`)) === "password");
    await f("password", "");
    await f("note", "只读账号");
    await saveConn();
    ok("编辑时不改密码就保留原密码", await ev(`window.harness.connectionList().then(l => l.find(c => c.name === '订单库').secretSet.password === true)`));

    // 服务器 + 内嵌终端（引用服务器）
    await ev(click("conn-kind-server"));
    await ev(click("conn-new"));
    await until(`document.querySelector('[data-testid="conn-editor"]')`);
    await f("name", "应用服务器");
    await sel("env", "__custom");
    await f("env-custom", "灰度");
    await f("machine", "app-01");
    await f("host", "10.0.0.8");
    await f("username", "deploy");
    ok("服务器：选密钥登录时出现私钥路径，没有密码框", (await sel("authType", "key"), await until(`document.querySelector('[data-testid="conn-f-keyPath"]')`), await ev(`!document.querySelector('[data-testid="conn-f-password"]')`)));
    await f("keyPath", "C:/keys/id_ed25519");
    await saveConn();
    await until(`document.querySelector('[data-testid="conn-card"]')`);
    ok("自定义环境名「灰度」会出现在环境筛选里", await ev(`!!document.querySelector('[data-testid="conn-env-灰度"]') || document.querySelector('[data-testid="conn-group"]').dataset.env === '灰度'`));

    await ev(click("conn-kind-terminal"));
    await ev(click("conn-new"));
    await until(`document.querySelector('[data-testid="conn-editor"]')`);
    await f("name", "灰度终端");
    await sel("env", "测试");
    await sel("mode", "server");
    await until(`document.querySelector('[data-testid="conn-f-serverId"]')`);
    ok("内嵌终端：选「通过服务器」后可以挑一个服务器连接", await ev(`[...document.querySelectorAll('[data-testid="conn-f-serverId"] option')].some(o => o.innerText.includes('应用服务器'))`));
    await ev(click("conn-f-save"));
    await until(`document.querySelector('[data-testid="conn-f-err"]')`);
    ok("通过服务器却没选服务器时，提示要选", await ev(`document.querySelector('[data-testid="conn-f-err"]').innerText.includes('服务器')`));
    const sid = await ev(`window.harness.connectionList().then(l => l.find(c => c.kind === 'server').id)`);
    await sel("serverId", sid);
    await saveConn();
    await until(`document.querySelector('[data-testid="conn-card"]')`);
    ok("内嵌终端的摘要里显示它用的服务器", await ev(`document.querySelector('[data-testid="conn-summary"]').innerText.includes('应用服务器')`));

    await ev(click("conn-kind-server"));
    await until(`document.querySelector('[data-testid="conn-card"]')`);
    await ev(click("conn-del"));
    await ev(click("conn-del-confirm"));
    await until(`document.querySelector('[data-testid="conn-err"]')`);
    ok("被终端连接引用的服务器删不掉，并说明被谁用", await ev(`document.querySelector('[data-testid="conn-err"]').innerText.includes('灰度终端')`));

    // Redis / XXL-JOB 表单字段
    await ev(click("conn-kind-redis"));
    await ev(click("conn-new"));
    await until(`document.querySelector('[data-testid="conn-editor"]')`);
    ok("Redis 表单：主机、端口、库号、密码、TLS", await ev(`['host', 'port', 'db', 'password', 'tls'].every(k => !!document.querySelector('[data-testid="conn-f-' + k + '"]'))`));
    await ev(click("conn-f-cancel"));
    await ev(click("conn-kind-xxljob"));
    await ev(click("conn-new"));
    await until(`document.querySelector('[data-testid="conn-editor"]')`);
    ok("XXL-JOB 表单：调度中心地址、用户名、密码", await ev(`['url', 'username', 'password'].every(k => !!document.querySelector('[data-testid="conn-f-' + k + '"]'))`));
    await f("name", "调度中心");
    await f("url", "ftp://x");
    await f("username", "admin");
    await f("password", "pw");
    await ev(click("conn-f-save"));
    await until(`document.querySelector('[data-testid="conn-f-err"]')`);
    ok("XXL-JOB 地址不是 http(s) 时不收", await ev(`document.querySelector('[data-testid="conn-f-err"]').innerText.includes('http')`));
    await ev(click("conn-f-cancel"));
    await ev(click("conn-kind-database"));
    await ev(`document.querySelectorAll('[data-testid="conn-del"]').forEach(b => b.click())`);
  }

  if (log.includes("[renderer exception]")) out.push("FAIL 渲染进程出现未捕获异常\n" + log.slice(-1500));
} catch (e) {
  out.push("ERROR " + e.message + "\n" + log.slice(-1500));
} finally {
  console.log(out.join("\n"));
  const failed = out.some(l => l.startsWith("FAIL") || l.startsWith("ERROR"));
  try { ws?.close(); } catch {}
  child.kill();
  llm.close();
  setTimeout(() => {
    try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 15, retryDelay: 300 }); } catch {}
    process.exit(failed ? 1 : 0);
  }, 800);
}

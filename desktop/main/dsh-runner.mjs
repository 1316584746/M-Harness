// DSH 插件兼容运行器：由 M-Harness 用 Node 子进程启动（不是 Electron 界面进程）。
// 用真正的 Cordis 加载 DSH 插件，只实现 `tools`（插件注册的 AI 工具）和 `commands` 两个宿主服务；
// DSH 的其他核心服务（设置页、系统提示词、网页界面……）给一个什么都不做的占位，让插件能启动，但这些功能在本软件里没有。
// 协议：stdin / stdout 一行一条 JSON（{id, method, params} → {id, result | error}），日志走 stderr。
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const [, , runtimeRoot, pluginDir] = process.argv;
const out = line => process.stdout.write(JSON.stringify(line) + "\n");
const log = (...a) => process.stderr.write(a.map(x => (typeof x === "string" ? x : x instanceof Error ? x.stack || x.message : JSON.stringify(x))).join(" ") + "\n");
// 插件不小心打到 stdout 的日志会破坏协议，统一改走 stderr
console.log = console.info = console.debug = (...a) => log(...a);

const requireFrom = async name => import(pathToFileURL(path.join(runtimeRoot, "node_modules", ...name.split("/"), "lib", name === "@deepseek-ai/schemastery" ? "index.mjs" : "index.js")).href);

/** 插件注册的工具 */
const tools = new Map();
/** 插件注册的命令（斜杠命令），也当工具给 AI 用 */
const commands = new Map();
const warnings = [];

/** 把 DSH 工具的参数声明（简写的 { name: {type, required, ...} } 或标准 JSON Schema）转成 JSON Schema */
function toJsonSchema(params) {
  if (!params) return { type: "object", properties: {} };
  if (typeof params.toJSON === "function") {
    try {
      const j = params.toJSON();
      if (j && typeof j === "object" && (j.type || j.properties)) return j.type ? j : { type: "object", ...j };
    } catch {
      /* 落到下面 */
    }
  }
  if (params.type === "object" && params.properties) return params;
  if (params.properties && typeof params.properties === "object") return { type: "object", ...params };
  const properties = {};
  const required = [];
  const conv = d => {
    if (!d || typeof d !== "object") return {};
    const { required: _r, optional: _o, ...rest } = d;
    if (rest.properties && typeof rest.properties === "object") {
      const o = { ...rest, properties: {} };
      const req = [];
      for (const [k, v] of Object.entries(rest.properties)) {
        o.properties[k] = conv(v);
        if (v && v.required) req.push(k);
      }
      if (req.length && !Array.isArray(rest.required)) o.required = req;
      return o;
    }
    return rest.items ? { ...rest, items: conv(rest.items) } : rest;
  };
  for (const [k, v] of Object.entries(params)) {
    properties[k] = conv(v);
    if (v && typeof v === "object" && v.required === true) required.push(k);
  }
  return { type: "object", properties, ...(required.length ? { required } : {}) };
}

/** 工具的返回值转成给模型看的文字 */
function renderResult(def, value) {
  try {
    const r = def.output?.render?.(undefined, value);
    if (Array.isArray(r)) {
      const t = r.map(x => (x && x.type === "text" ? String(x.text ?? "") : x && x.type === "image" ? "[图片，已省略]" : JSON.stringify(x))).join("\n");
      if (t) return t;
    }
  } catch {
    /* 渲染失败就用原值 */
  }
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value, null, 2);
}

function permissive(name) {
  const fn = () => {};
  const self = new Proxy(fn, {
    get: (_t, k) => {
      if (k === "then" || k === "toJSON" || typeof k === "symbol") return undefined;
      return self;
    },
    apply: () => self,
    construct: () => self,
    has: () => true,
    set: () => true,
  });
  return self;
}

async function boot() {
  const cordis = await requireFrom("@deepseek-ai/cordis");
  const { Context, Service } = cordis;

  const guardName = d => (typeof d?.name === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(d.name) ? d.name : "");

  class HostTools extends Service {
    constructor(ctx) {
      super(ctx, "tools");
    }
    register(def, _opts) {
      const name = guardName(def);
      if (!name || typeof def.execute !== "function") {
        warnings.push("有一个工具的声明不合规（缺少 name 或 execute），已忽略");
        return () => {};
      }
      return this.ctx.effect(() => {
        const rec = { name, def };
        tools.set(name, rec);
        return () => {
          if (tools.get(name) === rec) tools.delete(name);
        };
      }, `tool ${name}`);
    }
    // 下面这些 DSH 的工具管理接口，本软件没有对应功能：接受调用但什么都不做
    restrict() {
      return () => {};
    }
    guard() {
      return () => {};
    }
    get() {
      return undefined;
    }
    definitions() {
      return [...tools.values()].map(t => t.def);
    }
    schemas() {
      return [...tools.values()].map(t => ({ name: t.name, description: t.def.description, parameters: toJsonSchema(t.def.parameters) }));
    }
  }

  class HostCommands extends Service {
    constructor(ctx) {
      super(ctx, "commands");
    }
    register(def) {
      const name = guardName(def);
      if (!name || typeof def.handler !== "function") return () => {};
      return this.ctx.effect(() => {
        const rec = { name, def };
        commands.set(name, rec);
        return () => {
          if (commands.get(name) === rec) commands.delete(name);
        };
      }, `command ${name}`);
    }
  }

  const root = new Context();
  // 插件通过 ctx.logger 打的日志：警告和错误写到 stderr（本软件会留最近一段给用户看）
  root.logger.exporter({
    colors: false,
    export: m => {
      if (m.type === "error" || m.type === "warn" || process.env.DSH_DEBUG) log(`[${m.name}] ${m.type}:`, ...m.args.map(a => (a instanceof Error ? a.stack || a.message : typeof a === "string" ? a : JSON.stringify(a))));
    },
  });
  await root.plugin(HostTools);
  await root.plugin(HostCommands);
  const stubs = ["web", "settings", "systemPrompt", "session", "scope", "agent", "llm", "userApproval", "credentials", "webServer", "webStartup", "attachment", "http", "i18n", "locale", "console"];
  for (const s of stubs) root.provide(s, permissive(s));
  return { root, provided: new Set(["tools", "commands", ...stubs]), cordis };
}

function resolveEntry(dir, pkg) {
  const ex = pkg.exports;
  let rel;
  const pick = v => (typeof v === "string" ? v : v && typeof v === "object" ? pick(v.import ?? v.node ?? v.default ?? v.require) : undefined);
  if (typeof ex === "string") rel = ex;
  else if (ex && typeof ex === "object") rel = pick(ex["."] ?? ex);
  rel ??= pkg.main ?? "index.js";
  return path.resolve(dir, rel);
}

let state;

async function load() {
  const pkg = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8"));
  const { root, provided } = await boot();
  const entry = resolveEntry(pluginDir, pkg);
  if (!fs.existsSync(entry)) throw new Error(`找不到插件入口文件：${path.relative(pluginDir, entry)}（插件没有带编译好的文件）`);
  const mod = await import(pathToFileURL(entry).href);
  const plugin = mod.default && (typeof mod.default === "function" || typeof mod.default.apply === "function") ? mod.default : mod;
  const name = plugin.name ?? mod.name ?? pkg.name;
  const need = [].concat(plugin.inject?.required ?? plugin.inject ?? []).filter(x => typeof x === "string");
  const missing = need.filter(x => !provided.has(x));
  if (missing.length) warnings.push(`插件要求的 DSH 宿主服务本软件没有：${missing.join("、")}，所以它没有被启动`);
  if (!missing.length) {
    // 配置交给 Cordis 按插件自己的 Config 补默认值，和 DSH 加载器的做法一致
    const fiber = root.plugin(plugin, {});
    // 等插件的异步初始化和 inject 回调跑完
    await Promise.race([Promise.resolve(fiber).catch(() => {}), new Promise(r => setTimeout(r, 4000))]);
    await new Promise(r => setTimeout(r, 300));
  }
  state = { root, name, version: pkg.version };
  return listing();
}

function listing() {
  const toolList = [...tools.values()].map(({ name, def }) => ({
    name,
    description: String(def.description ?? "").slice(0, 1500),
    inputSchema: toJsonSchema(def.parameters),
    readOnly: def.readOnly === true || def.sideEffects === false,
  }));
  for (const { name, def } of commands.values())
    toolList.push({
      name: `command_${name}`,
      description: `${String(def.description ?? `执行命令 /${name}`)}${def.input?.hint ? `（参数：${def.input.hint}）` : ""}`.slice(0, 1500),
      inputSchema: { type: "object", properties: { input: { type: "string", description: def.input?.hint ?? "命令后面跟的文字" } } },
      readOnly: false,
    });
  return { name: state?.name, version: state?.version, tools: toolList, warnings };
}

async function call({ tool, args }) {
  if (tool.startsWith("command_") && commands.has(tool.slice(8))) {
    const { def } = commands.get(tool.slice(8));
    const raw = String(args?.input ?? "");
    const r = await def.handler({ rawInput: raw, input: raw, args: raw.split(/\s+/).filter(Boolean), signal: new AbortController().signal });
    if (r && typeof r === "object") return String(r.text ?? r.message ?? JSON.stringify(r));
    return String(r ?? "");
  }
  const rec = tools.get(tool);
  if (!rec) throw new Error(`插件没有这个工具：${tool}`);
  const ac = new AbortController();
  const value = await rec.def.execute(args ?? {}, { signal: ac.signal, arguments: args ?? {}, callId: `call-${Date.now()}`, agent: undefined, log: undefined });
  return renderResult(rec.def, value);
}

const methods = {
  load,
  list: async () => listing(),
  call,
  shutdown: async () => {
    setTimeout(() => process.exit(0), 20);
    return {};
  },
};

process.on("unhandledRejection", e => log("unhandledRejection:", e));
process.on("uncaughtException", e => log("uncaughtException:", e));

readline.createInterface({ input: process.stdin }).on("line", async line => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  try {
    const f = methods[m.method];
    if (!f) throw new Error(`未知方法 ${m.method}`);
    out({ id: m.id, result: await f(m.params ?? {}) });
  } catch (e) {
    out({ id: m.id, error: { message: e instanceof Error ? e.message : String(e) } });
  }
});

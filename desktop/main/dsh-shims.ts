import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import RUNNER from "./dsh-runner.mjs?raw";
import { installDeps, type NpmOpts } from "./dsh-npm";

/**
 * DSH 插件的运行环境（装在 <数据目录>/dsh/ 下，所有 DSH 插件共用）：
 *   node_modules/@deepseek-ai/cordis、schemastery   真的 Cordis 框架，插件的加载、依赖注入、生命周期都靠它
 *   node_modules/@deepseek-ai/dsh-tools 等          本软件自己写的「宿主包」：插件 import 它们拿 defineTool 之类的接口
 *   runner.mjs                                     兼容运行器（见 dsh-runner.mjs）
 * DSH 官方把这些宿主包（dsh-tools、dsh-llm…）都当「对等依赖」，由宿主提供；这里提供插件常用的几个，别的没有，
 * 插件 import 不到时会报「缺少宿主包」，不会装一份旧的去顶替。
 */

/** 真正的 Cordis 和它要用的包：优先从本软件自带的 node_modules 复制，没有再从 npm 下载 */
export const HOST_PACKAGES: Array<{ name: string; range: string }> = [
  { name: "@deepseek-ai/cordis", range: "4.1.0" },
  { name: "@deepseek-ai/schemastery", range: "~3.19.0" },
];
const COPY_PACKAGES = ["@deepseek-ai/cordis", "@deepseek-ai/schemastery", "@deepseek-ai/cosmokit", "@standard-schema/spec"];

const SHIM_VERSION = "0.2.2-rc.5";

const SHIM_FILES: Record<string, string> = {
  "dsh-tools": `// M-Harness 的 DSH 宿主包（兼容层）：只有 defineTool 等插件声明工具要用的部分
export function defineTool(def) {
  if (!def || typeof def !== "object" || typeof def.name !== "string" || typeof def.execute !== "function") throw new TypeError("defineTool: 需要 name 和 execute");
  return def;
}
export class ToolsService {}
export const RUN_CODE_NAME = "run_code";
export default ToolsService;
`,
  "dsh-settings": `// M-Harness 的 DSH 宿主包（兼容层）：本软件没有 DSH 的设置服务，只留插件可能 import 的错误类型
export class SettingsConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = "SettingsConflictError";
  }
}
export default {};
`,
  "dsh-llm": `// M-Harness 的 DSH 宿主包（兼容层）：本软件没有 DSH 的 LLM 服务，只留插件可能 import 的错误类型
export class HarnessError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = "HarnessError";
    this.code = options && options.code;
  }
}
export default {};
`,
};

/** 本软件提供的宿主包名（@deepseek-ai/ 后面的部分） */
export const SHIM_NAMES = Object.keys(SHIM_FILES);

/** 兼容层的内容指纹：运行器或宿主包改了，下次启动会重新写 */
export const RUNTIME_STAMP = crypto
  .createHash("sha256")
  .update(RUNNER + JSON.stringify(SHIM_FILES) + JSON.stringify(HOST_PACKAGES))
  .digest("hex")
  .slice(0, 16);

/** 递归复制目录。不用 fs.cpSync：软件打包后 node_modules 在 asar 里，只有 readdir / readFile 这类基础调用一定能读 */
const copyDir = (from: string, to: string): void => {
  fs.rmSync(to, { recursive: true, force: true });
  const walk = (a: string, b: string) => {
    fs.mkdirSync(b, { recursive: true });
    for (const e of fs.readdirSync(a, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      if (e.isDirectory()) walk(path.join(a, e.name), path.join(b, e.name));
      else fs.writeFileSync(path.join(b, e.name), fs.readFileSync(path.join(a, e.name)));
    }
  };
  walk(from, to);
};

export interface RuntimeOpts {
  /** 找本软件自带的 node_modules 的候选位置（里面有 @deepseek-ai/cordis） */
  appModuleRoots?: string[];
  npm?: NpmOpts;
}

export interface Runtime {
  root: string;
  runner: string;
}

/** 准备好运行环境（已经准备好且没有变化就什么都不做） */
export async function ensureRuntime(root: string, o: RuntimeOpts = {}): Promise<Runtime> {
  const runner = path.join(root, "runner.mjs");
  const stampFile = path.join(root, ".runtime-stamp");
  const nm = path.join(root, "node_modules");
  const have = (n: string) => fs.existsSync(path.join(nm, ...n.split("/"), "package.json"));
  const stamp = (() => {
    try {
      return fs.readFileSync(stampFile, "utf8").trim();
    } catch {
      return "";
    }
  })();
  if (stamp === RUNTIME_STAMP && fs.existsSync(runner) && COPY_PACKAGES.every(have)) return { root, runner };

  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "harness-dsh-runtime", private: true, type: "module" }));
  fs.writeFileSync(runner, RUNNER);
  for (const [n, src] of Object.entries(SHIM_FILES)) {
    const dir = path.join(nm, "@deepseek-ai", n);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: `@deepseek-ai/${n}`, version: SHIM_VERSION, type: "module", main: "index.js", exports: { ".": "./index.js", "./package.json": "./package.json" }, harnessShim: true }));
    fs.writeFileSync(path.join(dir, "index.js"), src);
  }
  // 真的 Cordis：先从本软件自带的复制
  for (const n of COPY_PACKAGES) {
    if (have(n)) continue;
    for (const r of o.appModuleRoots ?? []) {
      const from = path.join(r, ...n.split("/"));
      if (fs.existsSync(path.join(from, "package.json"))) {
        copyDir(from, path.join(nm, ...n.split("/")));
        break;
      }
    }
  }
  // 还缺的从 npm 下载（连同它们的依赖）
  if (!COPY_PACKAGES.every(have)) await installDeps(root, Object.fromEntries(HOST_PACKAGES.map(p => [p.name, p.range])), { ...o.npm, skipScope: "" });
  if (!COPY_PACKAGES.every(have)) throw new Error("准备 DSH 运行环境失败：没有拿到 Cordis。请检查网络后重试");
  fs.writeFileSync(stampFile, RUNTIME_STAMP);
  return { root, runner };
}

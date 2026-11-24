import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bundledCliDir, ensureBundledCliOnPath, findBin, resolveBin, spawnCli } from "../src/tools/cli-spawn";

const WIN = process.platform === "win32";
let dir: string;
const oldPath = process.env.PATH;

/** 模拟 npm 全局安装：Windows 生成 npm 同款 .cmd 垫片（指向 node_modules 里的脚本），其它系统生成可执行脚本 */
beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "npmglobal-"));
  const script = path.join(dir, "node_modules", "fakepkg", "bin.js");
  fs.mkdirSync(path.dirname(script), { recursive: true });
  fs.writeFileSync(script, `let i = "";\nprocess.stdin.on("data", d => (i += d));\nprocess.stdin.on("end", () => console.log(JSON.stringify({ args: process.argv.slice(2), stdin: i })));\n`);
  if (WIN) {
    fs.writeFileSync(
      path.join(dir, "fakecli.cmd"),
      `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\n\r\nIF EXIST "%dp0%\\node.exe" (\r\n  SET "_prog=%dp0%\\node.exe"\r\n) ELSE (\r\n  SET "_prog=node"\r\n  SET PATHEXT=%PATHEXT:;.JS;=;%\r\n)\r\n\r\nendLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\fakepkg\\bin.js" %*\r\n`,
    );
  } else {
    fs.writeFileSync(path.join(dir, "fakecli"), `#!/bin/sh\nexec node "${script}" "$@"\n`, { mode: 0o755 });
  }
});

afterAll(() => {
  process.env.PATH = oldPath;
});

const run = (bin: string, args: string[], stdin = "") =>
  new Promise<{ out: string; err?: string }>(resolve => {
    const c = spawnCli(bin, args);
    let out = "";
    c.stdout.on("data", d => (out += d));
    c.on("error", e => resolve({ out, err: e.message }));
    c.on("close", () => resolve({ out }));
    c.stdin.end(stdin);
  });

describe("spawnCli：npm 装出来的 CLI 要能被找到并正确启动", () => {
  it("PATH 里没有时找不到（会报 ENOENT，而不是崩溃）", async () => {
    process.env.PATH = oldPath;
    expect(findBin("fakecli")).toBeUndefined();
    expect((await run("fakecli", [])).err).toMatch(/ENOENT/);
  });

  it("目录在 PATH 里：Windows 下能识别 .cmd 垫片，参数里的引号和中文不丢", async () => {
    process.env.PATH = `${dir}${path.delimiter}${oldPath}`;
    expect(findBin("fakecli")).toBeTruthy();
    expect(resolveBin("fakecli")).toContain(dir);
    const json = '{"a":1,"名称":"x y"}';
    const r = await run("fakecli", ["workitem", "--params", json, "50%&x"], "来自 stdin");
    expect(r.err).toBeUndefined();
    expect(JSON.parse(r.out)).toEqual({ args: ["workitem", "--params", json, "50%&x"], stdin: "来自 stdin" });
  });

  it("也支持传完整路径", async () => {
    process.env.PATH = oldPath;
    const full = resolveBin(path.join(dir, "fakecli"));
    expect(full).toContain(dir);
    expect(JSON.parse((await run(path.join(dir, "fakecli"), ["hi"])).out).args).toEqual(["hi"]);
  });
});

describe("随包 CLI（resources/cli）：不用装 Node / npm 也能用，且排在用户自己装的后面", () => {
  const exe = WIN ? ".exe" : "";
  let bundled: string;
  let npmDir: string;
  const oldEnv = process.env.HARNESS_CLI_DIR;

  beforeAll(() => {
    bundled = fs.mkdtempSync(path.join(os.tmpdir(), "bundled-cli-"));
    npmDir = fs.mkdtempSync(path.join(os.tmpdir(), "npm-cli-"));
    fs.writeFileSync(path.join(bundled, `onlybundled${exe}`), "x", { mode: 0o755 });
    fs.writeFileSync(path.join(bundled, `both${exe}`), "bundled", { mode: 0o755 });
    fs.writeFileSync(path.join(npmDir, `both${exe}`), "npm", { mode: 0o755 });
  });
  afterAll(() => {
    process.env.PATH = oldPath;
    if (oldEnv === undefined) delete process.env.HARNESS_CLI_DIR;
    else process.env.HARNESS_CLI_DIR = oldEnv;
  });

  it("HARNESS_CLI_DIR 指向的目录：PATH 里没有也能找到", () => {
    process.env.PATH = oldPath;
    process.env.HARNESS_CLI_DIR = bundled;
    expect(bundledCliDir()).toBe(bundled);
    expect(findBin("onlybundled")).toContain(bundled);
  });

  it("同名时用户自己装的优先，随包版本只兜底（即使随包目录被加进了 PATH）", () => {
    process.env.HARNESS_CLI_DIR = bundled;
    process.env.PATH = [bundled, npmDir, oldPath].join(path.delimiter);
    expect(resolveBin("both")).toContain(npmDir);
  });

  it("ensureBundledCliOnPath 追加到 PATH 末尾，重复调用不重复添加", () => {
    process.env.HARNESS_CLI_DIR = bundled;
    process.env.PATH = oldPath;
    expect(ensureBundledCliOnPath()).toBe(bundled);
    ensureBundledCliOnPath();
    const parts = (process.env.PATH ?? "").split(path.delimiter);
    expect(parts.filter(p => p === bundled)).toHaveLength(1);
    expect(parts[parts.length - 1]).toBe(bundled);
  });

  it("目录不存在时当作没有随包 CLI", () => {
    process.env.HARNESS_CLI_DIR = path.join(bundled, "nope");
    process.env.PATH = oldPath;
    expect(findBin("onlybundled")).toBeUndefined();
  });
});

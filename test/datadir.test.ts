import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { defaultDataDir, ensureDirs, migrateData, pointerFile, readPointer, requestDataDir, resolveLayout, writePointer } from "../desktop/main/datadir";

const tmp: string[] = [];
const mk = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "dd-"));
  tmp.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmp.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe("默认数据目录", () => {
  it("Windows 有 D 盘 → D:\\M-Harness-data；没有 D 盘 → 用户目录下", () => {
    expect(defaultDataDir({ platform: "win32", exists: () => true, homedir: "C:\\Users\\a" })).toBe("D:\\M-Harness-data");
    expect(defaultDataDir({ platform: "win32", exists: () => false, homedir: path.join(os.tmpdir(), "u") })).toBe(path.join(os.tmpdir(), "u", "M-Harness-data"));
  });
  it("macOS / Linux → 用户目录下的 M-Harness-data", () => {
    const h = path.join(os.tmpdir(), "mac-user");
    expect(defaultDataDir({ platform: "darwin", homedir: h })).toBe(path.join(h, "M-Harness-data"));
    expect(defaultDataDir({ platform: "linux", homedir: h })).toBe(path.join(h, "M-Harness-data"));
  });
});

describe("resolveLayout", () => {
  it("打包后没改过 → 默认目录；自动创建，浏览器存储在 app-state 里", () => {
    const base = mk();
    const appData = path.join(base, "appdata");
    const l = resolveLayout({ packaged: true, cwd: base, appData, platform: "linux", homedir: path.join(base, "home") });
    expect(l.source).toBe("default");
    expect(l.home).toBe(path.join(base, "home", "M-Harness-data"));
    expect(fs.existsSync(l.home)).toBe(false);
    ensureDirs(l);
    expect(fs.statSync(l.home).isDirectory()).toBe(true);
    expect(fs.statSync(l.userData!).isDirectory()).toBe(true);
  });
  it("开发模式没改过 → 同样用默认目录（设置里「当前」与「默认」一致），不再用项目根", () => {
    const base = mk();
    const l = resolveLayout({ packaged: false, cwd: base, appData: path.join(base, "a"), platform: "linux", homedir: path.join(base, "home") });
    expect(l).toMatchObject({ source: "default", home: path.join(base, "home", "M-Harness-data"), defaultDir: path.join(base, "home", "M-Harness-data") });
    expect(l.userData).toBe(path.join(l.home, "app-state"));
  });
  it("强制指定（自动化测试）→ 用指定目录，忽略记录", () => {
    const base = mk();
    const l = resolveLayout({ packaged: true, cwd: base, appData: path.join(base, "a"), forced: path.join(base, "f") });
    expect(l).toMatchObject({ source: "dev", home: path.join(base, "f") });
    expect(l.userData).toBeUndefined();
  });
  it("改过位置 → 按记录的目录（开发 / 打包都一样）", () => {
    const base = mk();
    const appData = path.join(base, "a");
    writePointer(appData, { dir: path.join(base, "mydata") });
    for (const packaged of [true, false]) {
      const l = resolveLayout({ packaged, cwd: base, appData });
      expect(l.source).toBe("pointer");
      expect(l.home).toBe(path.join(base, "mydata"));
      expect(l.userData).toBe(path.join(base, "mydata", "app-state"));
    }
  });
  it("记录文件坏了 → 当作没改过", () => {
    const base = mk();
    const appData = path.join(base, "a");
    fs.mkdirSync(path.dirname(pointerFile(appData)), { recursive: true });
    fs.writeFileSync(pointerFile(appData), "{oops");
    expect(readPointer(appData)).toEqual({});
  });
});

describe("换目录与迁移", () => {
  const seed = (home: string, state: string) => {
    fs.mkdirSync(path.join(home, "tasks", "t1"), { recursive: true });
    fs.writeFileSync(path.join(home, "harness.config.json"), '{"a":1}');
    fs.writeFileSync(path.join(home, ".env"), "K=v");
    fs.writeFileSync(path.join(home, "tasks", "t1", "x.txt"), "hi");
    fs.mkdirSync(path.join(home, "node_modules", "p"), { recursive: true });
    fs.writeFileSync(path.join(home, "src.ts"), "code");
    fs.mkdirSync(path.join(state, "Local Storage"), { recursive: true });
    fs.writeFileSync(path.join(state, "Local Storage", "chat"), "history");
    fs.mkdirSync(path.join(state, "Cache"), { recursive: true });
    fs.writeFileSync(path.join(state, "Cache", "junk"), "x");
  };

  it("只复制用户数据：配置 / 令牌 / 任务 / 对话记录；不带源码、node_modules、浏览器缓存；旧文件保留", () => {
    const base = mk();
    const oldHome = path.join(base, "old");
    const oldState = path.join(base, "oldstate");
    seed(oldHome, oldState);
    const to = resolveLayout({ packaged: true, cwd: base, appData: path.join(base, "a"), platform: "linux", homedir: path.join(base, "h") });
    ensureDirs(to);
    const got = migrateData({ home: oldHome, userData: oldState }, to);
    expect(got).toEqual(expect.arrayContaining(["harness.config.json", ".env", "tasks", "Local Storage"]));
    expect(fs.readFileSync(path.join(to.home, "tasks", "t1", "x.txt"), "utf8")).toBe("hi");
    expect(fs.readFileSync(path.join(to.userData!, "Local Storage", "chat"), "utf8")).toBe("history");
    expect(fs.existsSync(path.join(to.home, "node_modules"))).toBe(false);
    expect(fs.existsSync(path.join(to.home, "src.ts"))).toBe(false);
    expect(fs.existsSync(path.join(to.userData!, "Cache"))).toBe(false);
    expect(fs.existsSync(path.join(oldHome, ".env"))).toBe(true);
  });

  it("新目录里已有的不覆盖", () => {
    const base = mk();
    const oldHome = path.join(base, "old");
    seed(oldHome, path.join(base, "s"));
    const to = resolveLayout({ packaged: true, cwd: base, appData: path.join(base, "a"), platform: "linux", homedir: path.join(base, "h") });
    ensureDirs(to);
    fs.writeFileSync(path.join(to.home, ".env"), "KEEP=1");
    migrateData({ home: oldHome, userData: path.join(base, "s") }, to);
    expect(fs.readFileSync(path.join(to.home, ".env"), "utf8")).toBe("KEEP=1");
  });

  it("requestDataDir：不存在的目录会自动创建并登记待迁移", () => {
    const base = mk();
    const appData = path.join(base, "a");
    const cur = { home: path.join(base, "cur"), userData: path.join(base, "cur", "app-state") };
    const target = path.join(base, "deep", "new", "dir");
    const r = requestDataDir(appData, cur, target);
    expect(r).toEqual({ ok: true });
    expect(fs.statSync(target).isDirectory()).toBe(true);
    expect(readPointer(appData)).toEqual({ dir: target, migrate: cur });
  });

  it("requestDataDir：相对路径 / 当前目录 / 当前目录里面 / 文件 都拒绝或不动", () => {
    const base = mk();
    const appData = path.join(base, "a");
    const cur = { home: path.join(base, "cur"), userData: path.join(base, "cur", "s") };
    fs.mkdirSync(cur.home);
    expect(requestDataDir(appData, cur, "relative/dir").ok).toBe(false);
    expect(requestDataDir(appData, cur, "").ok).toBe(false);
    expect(requestDataDir(appData, cur, cur.home)).toEqual({ ok: true, same: true });
    expect(requestDataDir(appData, cur, path.join(cur.home, "inside")).ok).toBe(false);
    const file = path.join(base, "f.txt");
    fs.writeFileSync(file, "x");
    expect(requestDataDir(appData, cur, file).ok).toBe(false);
    expect(readPointer(appData)).toEqual({});
  });
});

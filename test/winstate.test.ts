import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadWinState, saveWinState, usableWinState } from "../desktop/main/winstate";

const min = { width: 960, height: 600 };
const def = { width: 1280, height: 820 };
const screens = [
  { x: 0, y: 0, width: 1920, height: 1040 },
  { x: 1920, y: 0, width: 1920, height: 1040 },
];

describe("窗口状态：记住位置和大小", () => {
  it("存下来再读回；坏文件当没有", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "winstate-"));
    expect(loadWinState(dir)).toBeUndefined();
    saveWinState(dir, { x: 10, y: 20, width: 1100, height: 700, maximized: true });
    expect(loadWinState(dir)).toEqual({ x: 10, y: 20, width: 1100, height: 700, maximized: true });
    fs.writeFileSync(path.join(dir, "window-state.json"), "{坏的");
    expect(loadWinState(dir)).toBeUndefined();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("没有记录 → 默认大小", () => {
    expect(usableWinState(undefined, screens, min, def)).toEqual(def);
  });

  it("位置还在某个屏幕里：原样恢复", () => {
    expect(usableWinState({ x: 2000, y: 100, width: 1200, height: 800, maximized: false }, screens, min, def)).toMatchObject({ x: 2000, y: 100, width: 1200, height: 800 });
  });

  it("上次在外接屏、现在拔掉了：不用旧位置（免得窗口跑到看不见的地方），大小保留", () => {
    const r = usableWinState({ x: 2000, y: 100, width: 1200, height: 800 }, [screens[0]], min, def);
    expect(r.x).toBeUndefined();
    expect(r).toMatchObject({ width: 1200, height: 800 });
  });

  it("大小不能小于最小尺寸", () => {
    expect(usableWinState({ width: 300, height: 200 }, screens, min, def)).toMatchObject({ width: 960, height: 600 });
  });

  it("最大化状态也记住", () => {
    expect(usableWinState({ x: 0, y: 0, width: 1200, height: 800, maximized: true }, screens, min, def).maximized).toBe(true);
  });
});

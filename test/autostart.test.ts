import { describe, expect, it } from "vitest";
import { getAutostart, setAutostart, type LoginApp } from "../desktop/main/autostart";

function fake(opts: { packaged?: boolean; on?: boolean; refuse?: boolean; throws?: boolean } = {}) {
  let on = opts.on ?? false;
  const app: LoginApp & { calls: boolean[] } = {
    isPackaged: opts.packaged ?? true,
    calls: [],
    getLoginItemSettings: () => ({ openAtLogin: on }),
    setLoginItemSettings: s => {
      if (opts.throws) throw new Error("denied");
      app.calls.push(s.openAtLogin);
      if (!opts.refuse) on = s.openAtLogin;
    },
  };
  return app;
}

describe("开机自启动", () => {
  it("安装版 Windows：读到系统里的状态，开 / 关都生效", () => {
    const app = fake();
    expect(getAutostart(app, "win32")).toEqual({ supported: true, enabled: false });
    expect(setAutostart(app, true, "win32")).toEqual({ supported: true, enabled: true });
    expect(setAutostart(app, false, "win32")).toEqual({ supported: true, enabled: false });
    expect(app.calls).toEqual([true, false]);
  });
  it("开发模式不能设：不会去写登录项，并说明原因", () => {
    const app = fake({ packaged: false });
    const r = setAutostart(app, true, "win32");
    expect(r.supported).toBe(false);
    expect(r.reason).toContain("开发模式");
    expect(app.calls).toEqual([]);
  });
  it("Linux 不支持", () => {
    expect(getAutostart(fake(), "linux").supported).toBe(false);
  });
  it("系统没接受设置（被策略拦）：返回真实状态并提示", () => {
    const r = setAutostart(fake({ refuse: true }), true, "win32");
    expect(r.enabled).toBe(false);
    expect(r.reason).toContain("没有接受");
  });
  it("设置时系统报错：不崩，带上原因", () => {
    const r = setAutostart(fake({ throws: true }), true, "darwin");
    expect(r.reason).toContain("denied");
  });
});

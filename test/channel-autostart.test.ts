import { describe, expect, it } from "vitest";
import { MH_PROFILE, autoStartDecision, isBound } from "../src/channels/lark-cli";

const BOUND = ["--profile", MH_PROFILE];

describe("isBound：有没有绑定 M-Harness 自己的飞书机器人", () => {
  it("binArgs 里指定了专属 profile 才算", () => {
    expect(isBound({ binArgs: BOUND })).toBe(true);
    expect(isBound({ binArgs: ["--foo", "--profile", MH_PROFILE] })).toBe(true);
  });
  it("没配 / 默认配置 / 指向别的 profile → 没绑定（不借用本机别的软件的机器人）", () => {
    expect(isBound(undefined)).toBe(false);
    expect(isBound({ binArgs: [] })).toBe(false);
    expect(isBound({ binArgs: ["--profile", "cli_aad2160690f75bd5"] })).toBe(false);
    expect(isBound({ binArgs: ["--profile"] })).toBe(false);
  });
});

describe("打开软件时是否自动启动飞书通道", () => {
  it("没配飞书通道 → 不启动，也不提示", () => {
    expect(autoStartDecision(undefined)).toEqual({ start: false });
  });
  it("绑定了专属机器人 + 设了允许的用户，默认自动启动", () => {
    expect(autoStartDecision({ binArgs: BOUND, allowUsers: ["ou_a"], allowChats: [] })).toEqual({ start: true });
  });
  it("只设了允许的群也算", () => {
    expect(autoStartDecision({ binArgs: BOUND, allowUsers: [], allowChats: ["oc_x"] })).toEqual({ start: true });
  });
  it("没绑定专属机器人 → 不自动启动，哪怕允许名单有人（要先创建，不能用本机别人的机器人）", () => {
    const d = autoStartDecision({ binArgs: [], allowUsers: ["ou_a"], allowChats: [] });
    expect(d.start).toBe(false);
    expect(d.reason).toContain("一键创建智能体");
  });
  it("绑定了但没设允许的用户 / 群 → 不自动启动（避免被陌生人驱动）", () => {
    const d = autoStartDecision({ binArgs: BOUND, allowUsers: [], allowChats: [] });
    expect(d.start).toBe(false);
    expect(d.reason).toContain("允许的用户");
  });
  it("设置里关了 → 不启动", () => {
    const d = autoStartDecision({ autoStart: false, binArgs: BOUND, allowUsers: ["ou_a"], allowChats: [] });
    expect(d.start).toBe(false);
    expect(d.reason).toContain("关闭");
  });
});

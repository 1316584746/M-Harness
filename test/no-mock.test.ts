import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Backend, DEFAULT_CONFIG_TEXT } from "../desktop/main/backend";
import { ProviderRegistry, dropMockProviders, parseConfig } from "../src/config";

describe("产品里不再有 mock 假模型", () => {
  it("默认配置里没有任何提供方、也没有默认模型", () => {
    const c = parseConfig({});
    expect(c.providers).toEqual({});
    expect(c.defaultProvider).toBe("");
  });

  it("旧配置里残留的 mock 提供方被丢掉，默认模型改成剩下的第一个", () => {
    const c = parseConfig({ defaultProvider: "mock", providers: { mock: { type: "mock" }, ds: { type: "openai-compat", baseURL: "http://x", apiKey: "k", model: "m" } } });
    expect(Object.keys(c.providers)).toEqual(["ds"]);
    expect(c.defaultProvider).toBe("ds");
  });

  it("默认模型本来就不是 mock 的，保持不变", () => {
    const c = parseConfig({ defaultProvider: "ds", providers: { mock: { type: "mock" }, ds: { type: "openai-compat", baseURL: "http://x", apiKey: "k", model: "m" } } });
    expect(c.defaultProvider).toBe("ds");
    expect(Object.keys(c.providers)).toEqual(["ds"]);
  });

  it("只有 mock 的旧配置：清空，不报错", () => {
    const c = parseConfig({ defaultProvider: "mock", providers: { mock: { type: "mock" } } });
    expect(c.providers).toEqual({});
    expect(c.defaultProvider).toBe("");
  });

  it("dropMockProviders 返回有没有改动", () => {
    expect(dropMockProviders({ providers: { a: { type: "cli", preset: "codex" } } })).toBe(false);
    expect(dropMockProviders({ providers: { m: { type: "mock" } } })).toBe(true);
    expect(dropMockProviders(null)).toBe(false);
  });

  it("没有配置模型时给出明确的提示，而不是「未知 provider」", () => {
    const reg = new ProviderRegistry(parseConfig({}));
    expect(() => reg.get("")).toThrow("还没有配置模型");
    const reg2 = new ProviderRegistry(parseConfig({ providers: { a: { type: "cli", preset: "codex" } } }));
    expect(() => reg2.get("zzz")).toThrow("未知 provider：zzz");
  });

  it("桌面端启动时把配置文件里的 mock 清掉；全新安装的默认配置里没有 mock", () => {
    expect(DEFAULT_CONFIG_TEXT).not.toMatch(/mock/i);
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "no-mock-"));
    try {
      fs.writeFileSync(path.join(home, "harness.config.json"), JSON.stringify({ defaultProvider: "mock", workspace: ".", providers: { mock: { type: "mock" }, cur: { type: "cursor-sdk", apiKey: "k" } } }));
      const b = new Backend(home, { send() {} });
      const text = fs.readFileSync(path.join(home, "harness.config.json"), "utf8");
      expect(text).not.toMatch(/mock/i);
      expect(b.getState().defaultProvider).toBe("cur");
      expect(b.getState().providers.map(p => p.name)).toEqual(["cur"]);
      expect(b.getState().configError).toBeUndefined();
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it("全新安装：默认配置能解析，提供方都是真实的", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "no-mock-"));
    try {
      const b = new Backend(home, { send() {} });
      const s = b.getState();
      expect(s.configError).toBeUndefined();
      expect(s.providers.map(p => p.name)).toEqual(["deepseek", "openai", "claude", "codex", "cursor"]);
      expect(s.defaultProvider).toBe("deepseek");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

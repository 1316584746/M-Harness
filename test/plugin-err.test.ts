import { describe, expect, it } from "vitest";
import { isBenignPluginError } from "../desktop/renderer/src/lib/pluginErr";

describe("isBenignPluginError：哪些插件失败不弹红条", () => {
  it("接口 / 资源不存在（404）不弹", () => {
    expect(isBenignPluginError("not_found: 404 Not Found")).toBe(true);
    expect(isBenignPluginError("NOT_FOUND: 404")).toBe(true);
    expect(isBenignPluginError("404 Not Found")).toBe(true);
    expect(isBenignPluginError("HTTP 404")).toBe(true);
  });
  it("真正的故障照常弹", () => {
    expect(isBenignPluginError("unauthorized: 401 Unauthorized")).toBe(false);
    expect(isBenignPluginError("timeout: request timed out")).toBe(false);
    expect(isBenignPluginError("后台进程已退出")).toBe(false);
    expect(isBenignPluginError("connection refused (port 4040)")).toBe(false);
  });
  it("空串不算", () => {
    expect(isBenignPluginError("")).toBe(false);
  });
});

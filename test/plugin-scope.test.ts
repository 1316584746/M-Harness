import { describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanScope, prepareScopeHome, sanitizeConfig, sweepScopeRoot } from "../desktop/main/plugin-scope";
import { runIdsOf, scopeKeyOf } from "../desktop/renderer/src/lib/pluginFocus";

describe("cleanScope", () => {
  it("合法范围原样保留（运行 id 去重）", () => {
    expect(cleanScope({ key: "chat-1", runs: ["a", "b", "a"] })).toEqual({ key: "chat-1", runs: ["a", "b"] });
  });
  it("key / 运行 id 里有路径分隔符、..、非字符串：拒绝或丢掉", () => {
    expect(cleanScope({ key: "../x", runs: [] })).toBeUndefined();
    expect(cleanScope({ key: "a/b", runs: [] })).toBeUndefined();
    expect(cleanScope({ key: "ok", runs: ["../../etc/passwd", "a\\b", 3, "good"] })).toEqual({ key: "ok", runs: ["good"] });
    expect(cleanScope(null)).toBeUndefined();
    expect(cleanScope({ key: "ok" })).toBeUndefined();
  });
});

describe("sanitizeConfig", () => {
  it("只留 providers / limits，去掉任何像密钥的字段", () => {
    const out = sanitizeConfig({ providers: { a: { model: "m", apiKey: "sk-1", headers: { Authorization: "Bearer x" } } }, limits: { contextTokens: 100 }, mcpServers: { s: { token: "t" } } });
    expect(out).toEqual({ traceDir: ".traces", providers: { a: { model: "m", headers: {} } }, limits: { contextTokens: 100 } });
    expect(JSON.stringify(out)).not.toMatch(/sk-1|Bearer|"t"/);
  });
});

describe("prepareScopeHome", () => {
  it("只复制这段对话的运行，别的运行不会出现，多出来的会被清掉", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "scope-"));
    try {
      const src = path.join(tmp, "src");
      fs.mkdirSync(src);
      for (const r of ["r1", "r2", "r3"]) fs.writeFileSync(path.join(src, `${r}.jsonl`), `{"run":"${r}"}\n`);
      const root = path.join(tmp, "scope");
      const home = prepareScopeHome(root, { key: "k", runs: ["r1", "r3", "missing"] }, src, { limits: { contextTokens: 5 }, apiKey: "x" }, "context-insight");
      expect(fs.readdirSync(path.join(home, ".traces")).sort()).toEqual(["r1.jsonl", "r3.jsonl"]);
      expect(JSON.parse(fs.readFileSync(path.join(home, "harness.config.json"), "utf8"))).toEqual({ traceDir: ".traces", limits: { contextTokens: 5 } });
      expect(fs.existsSync(path.join(home, "plugin-data", "context-insight"))).toBe(true);
      // 又多了一轮、少了一轮：再同步一次
      prepareScopeHome(root, { key: "k", runs: ["r1", "r2"] }, src, {}, "context-insight");
      expect(fs.readdirSync(path.join(home, ".traces")).sort()).toEqual(["r1.jsonl", "r2.jsonl"]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("runIdsOf / scopeKeyOf", () => {
  it("取每轮的运行 id，旧记录用 trace 文件名，去重保序", () => {
    expect(runIdsOf([{ runId: "a" }, { traceFile: "D:\\data\\.traces\\b.jsonl" }, { traceFile: "/x/.traces/c.jsonl" }, { runId: "a" }, {}])).toEqual(["a", "b", "c"]);
  });
  it("对话标识变成合法的目录名", () => {
    expect(scopeKeyOf("task-t_1/2 x")).toBe("task-t_1_2_x");
  });
});

describe("sweepScopeRoot", () => {
  it("只清掉过期的临时目录，新的留着；目录不存在也不报错", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sweep-"));
    try {
      fs.mkdirSync(path.join(tmp, "context-insight", "old"), { recursive: true });
      fs.mkdirSync(path.join(tmp, "context-insight", "new"), { recursive: true });
      const old = new Date(Date.now() - 3 * 24 * 3600_000);
      fs.utimesSync(path.join(tmp, "context-insight", "old"), old, old);
      sweepScopeRoot(tmp, 24 * 3600_000);
      expect(fs.readdirSync(path.join(tmp, "context-insight"))).toEqual(["new"]);
      expect(() => sweepScopeRoot(path.join(tmp, "nope"), 1)).not.toThrow();
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** 约束：所有连接 / 密码 / 授权 / 令牌等用户数据只存本机，不得进仓库（.gitignore 必须一直覆盖这些文件）。 */
describe("用户数据不上传仓库", () => {
  const ignore = fs.readFileSync(path.join(__dirname, "..", ".gitignore"), "utf8").split(/\r?\n/).map(s => s.trim());
  const must = [
    "connections.json",
    "connection-secrets.json",
    "plugin-consent.json",
    "plugin-db-grants.json",
    "plugin-repos.json",
    "db-audit.jsonl",
    "harness.config.json",
    ".env",
    "automations.json",
    "defects.json",
    "home-cache.json",
    "models-cache.json",
    "plugin-data/",
    ".host-storage.json",
  ];
  it.each(must)("%s 被 .gitignore 忽略", name => {
    expect(ignore).toContain(name);
  });
  it("示例模板不被忽略", () => {
    expect(ignore).toContain("!.env.example");
    expect(ignore).toContain("!harness.config.example.json");
  });
});
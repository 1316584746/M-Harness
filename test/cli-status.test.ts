import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { dwsCheckUpdate, dwsStatus, larkCheckUpdate, larkStatus, olderThan, parseVersion } from "../src/tools/cli-status";

let script: string;
const spec = () => ({ bin: process.execPath, binArgs: [script] });

beforeAll(() => {
  script = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fakecli-")), "cli.js");
  // 同一个假 CLI 按第一个参数和 FAKE_MODE 环境变量扮演 lark-cli / dws
  fs.writeFileSync(
    script,
    `const a = process.argv.slice(2).join(" ");
const mode = process.env.FAKE_MODE;
if (a === "--version") console.log(mode === "dws" ? "dws version v1.0.68 (abc)" : "lark-cli version 1.0.98");
else if (mode === "lark" && a === "auth status") console.log(JSON.stringify({ identities: { bot: { status: "ready" }, user: { openId: "ou_x", available: true, userName: "测试用户" } } }));
else if (mode === "lark" && a === "update --check --json") console.log(JSON.stringify({ ok: true, action: "update_available", current_version: "1.0.98", latest_version: "1.0.100", url: "u" }));
else if (mode === "dws" && a === "auth status") console.log(JSON.stringify({ version_check: { current: "v1.0.68", latest: "1.0.70", status: "update_available" }, authenticated: true, user: { name: "测试用户" } }));
else if (mode === "nologin" && a === "auth status") console.log(JSON.stringify({ identities: { bot: { status: "not_configured" }, user: { available: false } } }));
else { console.error("unknown " + a); process.exit(2); }
`,
  );
});

describe("版本解析", () => {
  it("parseVersion / olderThan", () => {
    expect(parseVersion("lark-cli version 1.0.98")).toBe("1.0.98");
    expect(parseVersion("Version: v1.0.68")).toBe("1.0.68");
    expect(parseVersion("无")).toBeUndefined();
    expect(olderThan("1.0.98", "1.0.100")).toBe(true);
    expect(olderThan("1.0.100", "1.0.98")).toBe(false);
    expect(olderThan("1.2.0", "1.2.0")).toBe(false);
  });
});

describe("集成状态", () => {
  it("lark：版本、登录用户、可用更新", async () => {
    process.env.FAKE_MODE = "lark";
    const s = await larkStatus(spec());
    expect(s).toMatchObject({ installed: true, version: "1.0.98", authenticated: true, user: "测试用户" });
    const u = await larkCheckUpdate(spec());
    expect(u).toMatchObject({ ok: true, hasUpdate: true, latest: "1.0.100" });
    expect(u.message).toContain("lark-cli update");
  });

  it("lark：未登录给出提示", async () => {
    process.env.FAKE_MODE = "nologin";
    const s = await larkStatus(spec());
    expect(s.authenticated).toBe(false);
    expect(s.detail).toContain("auth login");
  });

  it("dws：从 auth status 读出版本、登录与更新", async () => {
    process.env.FAKE_MODE = "dws";
    const s = await dwsStatus(spec());
    expect(s).toMatchObject({ installed: true, version: "1.0.68", authenticated: true, user: "测试用户", hasUpdate: true, latest: "1.0.70" });
    expect((await dwsCheckUpdate(spec())).message).toContain("dws upgrade");
  });

  it("没安装：给出安装提示而不是抛错", async () => {
    const s = await larkStatus({ bin: "definitely-not-a-real-cli-xyz" });
    expect(s.installed).toBe(false);
    expect(s.detail).toContain("没有找到");
    const d = await dwsStatus({ bin: "definitely-not-a-real-cli-xyz" });
    expect(d.detail).toContain("npm install -g dingtalk-workspace-cli");
  });
});

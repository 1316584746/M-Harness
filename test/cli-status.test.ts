import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CLI_PACKAGES, dwsCheckUpdate, dwsStatus, installCli, larkCheckUpdate, larkStatus, loginCli, olderThan, parseVersion } from "../src/tools/cli-status";

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
else if (mode === "notcfg" && a === "auth status") { console.error(JSON.stringify({ ok: false, error: { subtype: "not_configured", message: "not configured" } })); process.exit(1); }
else if (mode === "nologin" && a === "auth status") console.log(JSON.stringify({ identities: { bot: { status: "not_configured" }, user: { available: false } } }));
else if (mode === "lark" && a === "auth login --no-wait --json") {
  if (!require("node:fs").existsSync(process.env.FAKE_MARK)) { console.error(JSON.stringify({ ok: false, error: { subtype: "not_configured", message: "not configured" } })); process.exit(1); }
  else console.log(JSON.stringify({ verification_url: "https://open.feishu.cn/device?c=1", device_code: "dc123", user_code: "AB-12" }));
}
else if (mode === "lark" && a === "config init --new") { console.error("打开 https://open.feishu.cn/setup?x=1 完成配置"); require("node:fs").writeFileSync(process.env.FAKE_MARK, "1"); }
else if (mode === "lark" && a === "auth login --device-code dc123") { if (process.env.FAKE_PARTIAL) { console.error("scopes not granted: mail:user_mailbox.folder:read, okr:okr.comment.delete"); process.exit(1); } console.log("ok"); }
else if (mode === "meegle" && a === "auth login --device-code --phase init --host https://project.feishu.cn") console.log(JSON.stringify({ client_id: "cid", device_code: "dcm", user_code: "ERB-9", verification_uri_complete: "https://project.feishu.cn/b/auth/mcp?u=1" }));
else if (mode === "meegle" && a === "auth login --device-code --phase poll --client-id cid --device-code-value dcm --host https://project.feishu.cn") console.log(JSON.stringify({ status: "ok" }));
else if (mode === "dws" && a === "auth login --no-browser") console.log("请手动访问:\\n  https://login.dingtalk.com/oauth2/auth?client_id=x&redirect_uri=http%3A%2F%2F127.0.0.1%3A1%2Fcb\\n等待授权");
else if (mode === "fail" && a.startsWith("auth login")) { console.error("denied"); process.exit(1); }
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

  it("lark：首次未配置（错误 JSON 在 stderr）→ 给人话而不是原始 JSON", async () => {
    process.env.FAKE_MODE = "notcfg";
    const s = await larkStatus(spec());
    expect(s).toMatchObject({ installed: true, authenticated: false });
    expect(s.detail).toContain("首次配置");
    expect(s.detail).not.toContain("{");
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

describe("一键登录", () => {
  const collect = () => {
    const urls: string[] = [];
    return { urls, hooks: { onUrl: (u: string) => void urls.push(u) } };
  };

  it("lark：首次未配置 → 先 config init，再设备授权", async () => {
    process.env.FAKE_MODE = "lark";
    process.env.FAKE_MARK = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mark-")), "m");
    const { urls, hooks } = collect();
    const r = await loginCli("lark", spec(), hooks);
    expect(r).toMatchObject({ ok: true });
    expect(urls).toEqual(["https://open.feishu.cn/setup?x=1", "https://open.feishu.cn/device?c=1"]);
  });

  it("lark：部分权限没授予时退出码非零，但账号已登录 → 算成功", async () => {
    process.env.FAKE_MODE = "lark";
    process.env.FAKE_MARK = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mark-")), "m");
    fs.writeFileSync(process.env.FAKE_MARK, "1"); // 已配置过，直接走设备授权
    process.env.FAKE_PARTIAL = "1";
    try {
      const r = await loginCli("lark", spec(), collect().hooks);
      expect(r.ok).toBe(true);
      expect(r.message).toContain("已登录");
    } finally {
      delete process.env.FAKE_PARTIAL;
    }
  });

  it("meegle：init 拿链接 → poll 等授权", async () => {
    process.env.FAKE_MODE = "meegle";
    const { urls, hooks } = collect();
    expect((await loginCli("meegle", spec(), hooks)).ok).toBe(true);
    expect(urls).toEqual(["https://project.feishu.cn/b/auth/mcp?u=1"]);
  });

  it("dws：从输出里抓出授权链接", async () => {
    process.env.FAKE_MODE = "dws";
    const { urls, hooks } = collect();
    expect((await loginCli("dws", spec(), hooks)).ok).toBe(true);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain("login.dingtalk.com");
  });

  it("授权失败 / 没装 CLI / 未知类型：给出原因而不是抛错", async () => {
    process.env.FAKE_MODE = "fail";
    const failed = await loginCli("dws", spec(), collect().hooks);
    expect(failed.ok).toBe(false);
    expect(failed.message).toContain("denied");
    const none = await loginCli("lark", { bin: "definitely-not-a-real-cli-xyz" }, collect().hooks);
    expect(none.ok).toBe(false);
    expect((await loginCli("nope", spec(), collect().hooks)).message).toContain("未知");
  });
});

describe("安装", () => {
  it("只认固定的包名，未知类型直接拒绝", async () => {
    expect(CLI_PACKAGES.lark).toBe("@larksuite/cli");
    expect((await installCli("evil && calc")).ok).toBe(false);
  });
});


import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runGit } from "../src/tools/git";
import { authEnvFor, hostEnabled, hostOriginsFromUrls, probeHost } from "../src/tools/git-hosts";

let server: http.Server;
let base: string;
const seen: Array<{ url?: string; headers: http.IncomingHttpHeaders }> = [];

beforeAll(async () => {
  server = http.createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    res.setHeader("content-type", "application/json");
    const ok = req.headers["private-token"] === "glpat-good-token" || req.headers.authorization === "Bearer ghp_good_token" || req.headers.authorization === "token gitee-good-token";
    if (!ok) {
      res.statusCode = 401;
      return res.end("{}");
    }
    res.setHeader("x-oauth-scopes", "repo, read:org");
    res.end(JSON.stringify({ name: "Test User", username: "tester", login: "tester", email: "w@example.com", created_at: "2026-07-10T08:00:00Z" }));
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => server.close());

describe("probeHost", () => {
  it("GitLab：用 PRIVATE-TOKEN 查 /api/v4/user，返回账号信息", async () => {
    const r = await probeHost({ platform: "gitlab", baseURL: base + "/", token: "glpat-good-token" });
    expect(r.ok).toBe(true);
    expect(r.user).toMatchObject({ name: "Test User", username: "tester", email: "w@example.com" });
    expect(seen.at(-1)?.url).toBe("/api/v4/user");
  });

  it("GitHub Enterprise：走 /api/v3/user，带权限范围", async () => {
    const r = await probeHost({ platform: "github", baseURL: base, token: "ghp_good_token" });
    expect(r.ok).toBe(true);
    expect(seen.at(-1)?.url).toBe("/api/v3/user");
    expect(r.user?.note).toContain("repo");
  });

  it("令牌无效 / 为空 / 地址非法 / 平台未知", async () => {
    expect((await probeHost({ platform: "gitlab", baseURL: base, token: "nope-nope-nope" })).error).toContain("无效");
    expect((await probeHost({ platform: "gitlab", baseURL: base, token: "" })).ok).toBe(false);
    expect((await probeHost({ platform: "gitlab", baseURL: "ftp://x", token: "abcdefgh" })).ok).toBe(false);
    expect((await probeHost({ platform: "svn", token: "abcdefgh" })).ok).toBe(false);
  });

  it("云效暂不校验，只返回说明", async () => {
    const r = await probeHost({ platform: "codeup", token: "abcdefgh" });
    expect(r.ok).toBe(true);
    expect(r.user?.note).toContain("暂不支持");
  });
});

describe("authEnvFor", () => {
  const env = { GITLAB_TOKEN: "glpat-xyz", GITHUB_TOKEN: "ghp_abc" } as NodeJS.ProcessEnv;

  it("匹配默认站点：用 GIT_CONFIG_* 注入 Basic 认证头", () => {
    const e = authEnvFor("https://github.com/acme/demo.git", {}, env);
    expect(e.GIT_CONFIG_KEY_0).toBe("http.https://github.com/.extraHeader");
    expect(e.GIT_CONFIG_VALUE_0).toBe("Authorization: Basic " + Buffer.from("x-access-token:ghp_abc").toString("base64"));
  });

  it("匹配自建实例地址", () => {
    const e = authEnvFor("https://git.corp.com:8443/g/p.git", { gitlab: { baseURL: "https://git.corp.com:8443/" } }, env);
    expect(e.GIT_CONFIG_KEY_0).toBe("http.https://git.corp.com:8443/.extraHeader");
    expect(e.GIT_CONFIG_VALUE_0).toContain(Buffer.from("oauth2:glpat-xyz").toString("base64"));
  });

  it("真实 git 会带上认证头（令牌不出现在命令行参数里）", async () => {
    const got: string[] = [];
    const srv = http.createServer((req, res) => {
      got.push(String(req.headers.authorization));
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>(r => srv.listen(0, "127.0.0.1", r));
    const origin = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
    try {
      const e = authEnvFor(`${origin}/g/p.git`, { gitlab: { baseURL: origin } }, env);
      await runGit(["ls-remote", `${origin}/g/p.git`], process.cwd(), undefined, 20, e);
      expect(got[0]).toBe("Basic " + Buffer.from("oauth2:glpat-xyz").toString("base64"));
    } finally {
      srv.close();
    }
  });

  it("停用的平台不注入令牌，没写 enabled 或写 true 都算启用", () => {
    expect(authEnvFor("https://github.com/a/b.git", { github: { enabled: false } }, env)).toEqual({});
    expect(authEnvFor("https://github.com/a/b.git", { github: { enabled: true } }, env).GIT_CONFIG_KEY_0).toBeTruthy();
    // 只停用 github，gitlab 仍然可用
    expect(authEnvFor("https://gitlab.com/a/b.git", { github: { enabled: false } }, env).GIT_CONFIG_KEY_0).toBeTruthy();
    expect(hostEnabled({ gitlab: { enabled: false } }, "gitlab")).toBe(false);
    expect(hostEnabled({}, "gitlab")).toBe(true);
  });

  it("ssh 地址、未知站点、没有令牌都不注入", () => {
    expect(authEnvFor("git@github.com:a/b.git", {}, env)).toEqual({});
    expect(authEnvFor("https://example.org/a/b.git", {}, env)).toEqual({});
    expect(authEnvFor("https://gitee.com/a/b.git", {}, env)).toEqual({});
    expect(authEnvFor(undefined, {}, env)).toEqual({});
  });
});

describe("hostOriginsFromUrls：从仓库地址猜自建实例", () => {
  it("ssh / https 都能认，默认站点和别的平台不算，结果去重", () => {
    const urls = ["git@gitlab.corp.net:g/a.git", "https://gitlab.corp.net/g/b.git", "https://gitlab.com/x/y.git", "https://github.com/x/y.git", undefined, "http://gitlab.lan:8080/g/c.git"];
    expect(hostOriginsFromUrls(urls, "gitlab")).toEqual(["https://gitlab.corp.net", "http://gitlab.lan:8080"]);
    expect(hostOriginsFromUrls(urls, "github")).toEqual([]);
    expect(hostOriginsFromUrls(urls, "gitee")).toEqual([]);
  });
});

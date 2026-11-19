/**
 * 代码托管平台（GitHub / GitLab / Gitee / 云效 Codeup）的访问令牌：
 * - 令牌保存在 .env（变量见 tokenEnv），配置文件里只存实例地址；
 * - probeHost：用令牌向平台查"我是谁"，让用户确认填对了；
 * - authEnvFor：git 拉取 / 推送 / 克隆 https 仓库时，把令牌通过环境变量（不是命令行参数）交给 git；停用的平台不注入。
 */

export interface HostDef {
  id: string;
  label: string;
  tokenLabel: string;
  tokenHint: string;
  tokenEnv: string;
  /** 默认站点（无自建实例时） */
  defaultBase: string;
  /** 是否允许自建 / 企业版实例地址 */
  selfHosted: boolean;
  /** 能否自动校验令牌 */
  verifiable: boolean;
  /** git over https 时使用的用户名（令牌当密码） */
  gitUser?: string;
}

export const HOSTS: HostDef[] = [
  {
    id: "github",
    label: "GitHub",
    tokenLabel: "GitHub Token",
    tokenHint: "Personal Access Token，需要 repo 权限",
    tokenEnv: "GITHUB_TOKEN",
    defaultBase: "https://github.com",
    selfHosted: true,
    verifiable: true,
    gitUser: "x-access-token",
  },
  {
    id: "gitlab",
    label: "GitLab",
    tokenLabel: "GitLab Token",
    tokenHint: "Personal Access Token、需要 api 权限",
    tokenEnv: "GITLAB_TOKEN",
    defaultBase: "https://gitlab.com",
    selfHosted: true,
    verifiable: true,
    gitUser: "oauth2",
  },
  {
    id: "gitee",
    label: "Gitee",
    tokenLabel: "Gitee Token",
    tokenHint: "私人令牌，需要 projects 权限",
    tokenEnv: "GITEE_TOKEN",
    defaultBase: "https://gitee.com",
    selfHosted: false,
    verifiable: true,
    gitUser: "oauth2",
  },
  {
    id: "codeup",
    label: "云效 Codeup",
    tokenLabel: "云效个人访问令牌",
    tokenHint: "个人访问令牌，需要代码仓库读写权限",
    tokenEnv: "CODEUP_TOKEN",
    defaultBase: "https://codeup.aliyun.com",
    selfHosted: false,
    verifiable: false,
  },
];

export const hostDef = (id: string) => HOSTS.find(h => h.id === id);

export type HostsConfig = Record<string, { baseURL?: string; enabled?: boolean } | undefined>;

/** 这个平台的令牌是否启用（没写过就是启用；停用后不会再用于 git 拉取 / 推送 / 克隆） */
export const hostEnabled = (hosts: HostsConfig | undefined, id: string) => hosts?.[id]?.enabled !== false;

export interface HostUser {
  name?: string;
  username?: string;
  email?: string;
  createdAt?: string;
  note?: string;
}

export interface HostProbe {
  ok: boolean;
  user?: HostUser;
  error?: string;
}

const TIMEOUT_MS = 12_000;

function trimBase(s?: string): string {
  return (s ?? "").trim().replace(/\/+$/, "");
}

export async function probeHost(req: { platform: string; baseURL?: string; token?: string }): Promise<HostProbe> {
  const def = hostDef(req.platform);
  if (!def) return { ok: false, error: `不支持的平台：${req.platform}` };
  const token = (req.token ?? "").trim();
  if (!token) return { ok: false, error: "请先填写令牌" };
  if (!def.verifiable) return { ok: true, user: { note: `${def.label} 暂不支持自动校验令牌，保存后将在 git 拉取 / 推送时使用` } };
  const base = trimBase(req.baseURL) || def.defaultBase;
  if (!/^https?:\/\//i.test(base)) return { ok: false, error: "实例地址必须以 http:// 或 https:// 开头" };

  let url: string;
  const headers: Record<string, string> = { "user-agent": "m-harness", accept: "application/json" };
  if (def.id === "github") {
    url = base === "https://github.com" ? "https://api.github.com/user" : `${base}/api/v3/user`;
    headers.authorization = `Bearer ${token}`;
  } else if (def.id === "gitlab") {
    url = `${base}/api/v4/user`;
    headers["private-token"] = token;
  } else {
    url = `${base}/api/v5/user`;
    headers.authorization = `token ${token}`;
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers, signal: ac.signal });
    if (res.status === 401 || res.status === 403) {
      const usedDefault = !trimBase(req.baseURL);
      return { ok: false, error: usedDefault && def.selfHosted ? `令牌无效、已过期或权限不足。没填实例地址，这里校验的是 ${def.defaultBase}；如果是公司自建的 ${def.label}，请先填下面的「实例地址」` : "令牌无效、已过期或权限不足" };
    }
    if (!res.ok) return { ok: false, error: `平台返回 HTTP ${res.status}` };
    const j: any = await res.json();
    const scopes = res.headers.get("x-oauth-scopes");
    return {
      ok: true,
      user: {
        name: j.name || undefined,
        username: j.username ?? j.login ?? undefined,
        email: j.email || j.public_email || undefined,
        createdAt: j.created_at || undefined,
        note: scopes ? `权限范围：${scopes}` : undefined,
      },
    };
  } catch (e: any) {
    return { ok: false, error: e?.name === "AbortError" ? "请求超时" : (e?.message ?? String(e)) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 给 git 子进程用的环境变量：当远端地址是已配置令牌的平台时，用 GIT_CONFIG_* 注入针对该站点的认证头
 * （不出现在命令行参数里；ssh 地址不处理，走本机 SSH Key）。
 */
export function authEnvFor(remoteUrl: string | undefined, hosts: HostsConfig = {}, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  if (!remoteUrl || !/^https?:\/\//i.test(remoteUrl)) return {};
  let u: URL;
  try {
    u = new URL(remoteUrl);
  } catch {
    return {};
  }
  for (const def of HOSTS) {
    if (!def.gitUser) continue;
    if (!hostEnabled(hosts, def.id)) continue;
    const token = env[def.tokenEnv];
    if (!token) continue;
    const bases = [def.defaultBase, trimBase(hosts[def.id]?.baseURL)].filter(Boolean);
    const match = bases.find(b => {
      try {
        return new URL(b).host.toLowerCase() === u.host.toLowerCase();
      } catch {
        return false;
      }
    });
    if (!match) continue;
    const cred = Buffer.from(`${def.gitUser}:${token}`).toString("base64");
    return {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `http.${u.protocol}//${u.host}/.extraHeader`,
      GIT_CONFIG_VALUE_0: `Authorization: Basic ${cred}`,
    };
  }
  return {};
}

/** 从已登记仓库的远端地址里找出该平台的自建实例地址（比如 git@gitlab.xx.net:g/p.git → https://gitlab.xx.net），不含默认站点 */
export function hostOriginsFromUrls(urls: Array<string | undefined>, platform: string): string[] {
  const def = hostDef(platform);
  if (!def?.selfHosted) return [];
  const defaultHost = new URL(def.defaultBase).host.toLowerCase();
  const out = new Set<string>();
  for (const raw of urls) {
    const u = (raw ?? "").trim();
    if (!u) continue;
    let host = "";
    let proto = "https:";
    const scp = /^[\w.-]+@([\w.-]+):/.exec(u);
    if (scp) host = scp[1];
    else {
      try {
        const x = new URL(u);
        host = x.hostname;
        proto = x.protocol === "http:" ? "http:" : "https:";
        if (x.port && x.protocol !== "ssh:") host = x.host;
      } catch {
        continue;
      }
    }
    if (!host || host.toLowerCase() === defaultHost) continue;
    if (detectPlatformFromHost(host) !== platform) continue;
    out.add(`${proto}//${host}`);
  }
  return [...out];
}

function detectPlatformFromHost(host: string): string {
  if (/github/i.test(host)) return "github";
  if (/gitlab/i.test(host)) return "gitlab";
  return "other";
}

/** 探测 API Key：校验有效性、拉取可用模型列表、尽可能取回 Key 所属账号信息。 */

export interface KeyUser {
  /** 账号姓名 */
  name?: string;
  email?: string;
  /** Key 的名称 */
  keyName?: string;
  /** ISO 时间 */
  createdAt?: string;
  /** 其它说明（如余额、"Key 有效"） */
  note?: string;
}

export interface ProbeRequest {
  type?: string;
  baseURL?: string;
  apiKey?: string;
  /** 只要模型列表：不查账号信息 / 余额（对话框里的模型选择用，少一次网络往返） */
  skipUser?: boolean;
}

export interface ProbeResult {
  ok: boolean;
  models?: string[];
  /** 模型 id → 展示名（有的服务商才提供） */
  labels?: Record<string, string>;
  user?: KeyUser;
  error?: string;
}

const TIMEOUT_MS = 12_000;

export async function probeKey(req: ProbeRequest): Promise<ProbeResult> {
  if (req.type === "cursor-sdk") return probeCursor(req.apiKey ?? "", !!req.skipUser);
  if (req.type === "anthropic" || req.type === "openai-compat") return probeHttp(req);
  return { ok: false, error: "该类型不支持获取模型列表" };
}

async function probeCursor(apiKey: string, skipUser = false): Promise<ProbeResult> {
  if (!apiKey) return { ok: false, error: "请先填写 API Key" };
  const pkg = "@cursor/sdk";
  let mod: any;
  try {
    mod = await import(/* @vite-ignore */ pkg);
  } catch (e: any) {
    return { ok: false, error: `无法加载 @cursor/sdk：${e?.message ?? e}` };
  }
  const Cursor = mod.Cursor ?? mod.default?.Cursor;
  if (!Cursor?.me || !Cursor?.models?.list) return { ok: false, error: "当前 @cursor/sdk 版本不支持查询账号/模型" };
  const withTimeout = <T>(p: Promise<T>): Promise<T> =>
    Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("请求超时")), TIMEOUT_MS * 2))]);
  try {
    const [me, list] = await withTimeout(Promise.all([skipUser ? undefined : Cursor.me({ apiKey }), Cursor.models.list({ apiKey })]));
    const labels: Record<string, string> = {};
    const ids: string[] = [];
    for (const m of list ?? []) {
      if (!m?.id) continue;
      ids.push(m.id);
      if (m.displayName && m.displayName !== m.id) labels[m.id] = m.displayName;
    }
    return {
      ok: true,
      models: [...new Set(ids)],
      labels,
      user: skipUser ? undefined : {
        name: [me?.userFirstName, me?.userLastName].filter(Boolean).join(" ") || undefined,
        email: me?.userEmail || undefined,
        keyName: me?.apiKeyName || undefined,
        createdAt: me?.createdAt || undefined,
        note: me?.userEmail || me?.userFirstName ? undefined : "团队 / 服务账号 Key（未绑定个人用户）",
      },
    };
  } catch (e: any) {
    return { ok: false, error: friendly(e?.message ?? String(e)) };
  }
}

function friendly(msg: string): string {
  if (/unauthenticated|unauthorized|invalid.*key|401/i.test(msg)) return "API Key 无效或已过期";
  return msg;
}

async function probeHttp(req: ProbeRequest): Promise<ProbeResult> {
  const key = req.apiKey ?? "";
  if (!key) return { ok: false, error: "请先填写 API Key" };
  const headers: Record<string, string> = {};
  let base: string;
  let url: string;
  if (req.type === "anthropic") {
    base = (req.baseURL || "https://api.anthropic.com").replace(/\/+$/, "");
    url = base + (base.endsWith("/v1") ? "" : "/v1") + "/models";
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    if (!req.baseURL) return { ok: false, error: "请先填写 Base URL" };
    base = req.baseURL.replace(/\/+$/, "");
    url = base + "/models";
    headers["authorization"] = `Bearer ${key}`;
  }
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "Base URL 必须以 http:// 或 https:// 开头" };

  try {
    const res = await timedFetch(url, headers);
    if (res.status === 401 || res.status === 403) return { ok: false, error: "API Key 无效或没有权限" };
    if (!res.ok) return { ok: false, error: `服务商返回 HTTP ${res.status}` };
    const json: any = await res.json();
    const arr: any[] = Array.isArray(json) ? json : (json.data ?? json.models ?? []);
    const models = arr.map(m => (typeof m === "string" ? m : (m?.id ?? m?.name))).filter((x): x is string => typeof x === "string" && !!x);
    const labels: Record<string, string> = {};
    for (const m of arr) if (m && typeof m === "object" && m.id && typeof m.display_name === "string") labels[m.id] = m.display_name;
    const user = req.skipUser ? undefined : await accountInfo(req, base, headers);
    return { ok: true, models: [...new Set(models)].sort(), labels, user };
  } catch (e: any) {
    return { ok: false, error: e?.name === "AbortError" ? "请求超时" : (e?.message ?? String(e)) };
  }
}

async function timedFetch(url: string, headers: Record<string, string>): Promise<Response> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, { headers, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 通用的 OpenAI 兼容接口没有"查账号"的标准端点：能查到余额的服务商就带上余额，否则只说明 Key 有效。 */
async function accountInfo(req: ProbeRequest, base: string, headers: Record<string, string>): Promise<KeyUser> {
  try {
    const host = new URL(base).hostname;
    if (/(^|\.)deepseek\.com$/i.test(host)) {
      const r = await timedFetch(new URL("/user/balance", base).toString(), headers);
      if (r.ok) {
        const j: any = await r.json();
        const infos: any[] = Array.isArray(j?.balance_infos) ? j.balance_infos : [];
        if (infos.length) {
          const text = infos.map(b => `${b.total_balance} ${b.currency}`).join("，");
          return { note: `Key 有效 · 账户余额 ${text}${j.is_available === false ? "（余额不足，暂不可调用）" : ""}` };
        }
      }
    }
  } catch {
    /* 忽略，退回通用提示 */
  }
  return { note: req.type === "anthropic" ? "Key 有效（Anthropic 不提供查询账号信息的接口）" : "Key 有效（该服务商没有开放账号信息接口）" };
}

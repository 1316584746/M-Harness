/**
 * 模型接口地址的识别与规整：用户常把「类型」和「地址」配错（最常见：选了 OpenAI 兼容，却填了 …/anthropic 结尾的
 * Anthropic 兼容地址，请求会打到 /anthropic/chat/completions 然后 404）。这里按地址本身判断真正的协议，
 * 并去掉粘贴时多带的接口路径，运行、探测、保存都走同一套规则。
 */

export type ModelType = "openai-compat" | "anthropic";

export interface NormalizedEndpoint {
  type: ModelType;
  /** 规整后的地址：不带结尾斜杠、不带 /chat/completions /v1/messages /models；anthropic 类型也不带结尾 /v1 */
  baseURL: string;
  /** 做了什么调整（给用户看的一句话）；没调整就是空数组 */
  notes: string[];
}

const ANTHROPIC_HOST = /^api\.anthropic\.com$/i;

/** 去掉多带的接口路径、查询串和结尾斜杠 */
export function cleanBase(raw: string): string {
  let s = (raw ?? "").trim();
  s = s.replace(/[?#].*$/, "");
  s = s.replace(/\/+$/, "");
  // 用户把完整接口地址粘进来了
  s = s.replace(/\/(v1\/)?(chat\/completions|messages|models|completions)$/i, (m, v) => (v ? "/v1" : ""));
  return s.replace(/\/+$/, "");
}

/** 只看地址：能确定协议就返回，不确定返回 undefined */
export function detectProtocol(baseURL: string): ModelType | undefined {
  let u: URL;
  try {
    u = new URL(cleanBase(baseURL));
  } catch {
    return undefined;
  }
  const segs = u.pathname.toLowerCase().split("/").filter(Boolean);
  if (ANTHROPIC_HOST.test(u.hostname) || segs.includes("anthropic")) return "anthropic";
  // 各家的 OpenAI 兼容路径：智谱 /paas/v4、通义 /compatible-mode/v1、…/openai
  if (segs.includes("paas") || segs.includes("compatible-mode") || segs[segs.length - 1] === "openai") return "openai-compat";
  return undefined;
}

export function normalizeEndpoint(type: string | undefined, baseURL: string | undefined): NormalizedEndpoint {
  const want: ModelType = type === "anthropic" ? "anthropic" : "openai-compat";
  const notes: string[] = [];
  let base = cleanBase(baseURL ?? "");
  if (baseURL && base !== baseURL.trim().replace(/\/+$/, "")) notes.push("已去掉地址里多余的接口路径");

  const real = base ? (detectProtocol(base) ?? want) : want;
  if (real !== want) {
    notes.push(real === "anthropic" ? "这是 Anthropic 兼容地址，已按 Anthropic 协议处理" : "这是 OpenAI 兼容地址，已按 OpenAI 协议处理");
  }
  // Anthropic 适配器会自己补 /v1/messages，所以地址里不能再带 /v1
  if (real === "anthropic" && /\/v1$/i.test(base)) base = base.replace(/\/v1$/i, "");
  return { type: real, baseURL: base, notes };
}

/** 模型调用失败时给出可操作的说明（HTTP 状态 / 服务商正文里的错误码） */
export function explainModelError(status: number, detail: string, url: string): string {
  const tail = detail ? `（${detail.slice(0, 160)}）` : "";
  if (status === 404) return `请求地址不存在（404）：${url}。请检查 Base URL；OpenAI 兼容和 Anthropic 兼容是两种地址，类型要对得上${tail}`;
  if (status === 401 || status === 403) return `API Key 无效或没有权限（${status}）${tail}`;
  if (status === 402) return `账户余额不足或套餐已用完（402）${tail}`;
  if (status === 429) return `请求太频繁或额度用完（429）${tail}`;
  if (status === 400) return `请求被服务商拒绝（400）：多半是模型名不对或参数不支持${tail}`;
  return `服务商返回错误（${status}）${tail}`;
}

/** 有的服务商（如智谱）出错也回 HTTP 200，把错误放在正文 {code,msg,success:false} 里；识别出来就抛成可读的错误 */
export function bodyError(json: any, url: string): string | undefined {
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  if (json.choices || json.content || json.data || json.output) return undefined;
  if (json.error) {
    const e = json.error;
    const msg = typeof e === "string" ? e : (e.message ?? e.msg ?? JSON.stringify(e));
    return explainModelError(Number(e.code ?? e.status) || 0, String(msg), url);
  }
  const failed = json.success === false || (typeof json.code === "number" && json.code !== 0 && json.code !== 200);
  if (!failed) return undefined;
  const code = Number(json.code) || 0;
  const msg = String(json.msg ?? json.message ?? "");
  // 业务码 500 + 404 NOT_FOUND 这类：正文里的 404 才是真实原因
  const inner = /\b(40[0-9]|429|5\d\d)\b/.exec(msg)?.[1];
  return explainModelError(inner ? Number(inner) : code, msg, url);
}

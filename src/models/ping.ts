import { anthropic } from "./anthropic";
import { normalizeEndpoint } from "./endpoint";
import { openaiCompat } from "./openai-compat";

export interface PingRequest {
  type?: string;
  baseURL?: string;
  apiKey?: string;
  model?: string;
}

export interface PingResult {
  ok: boolean;
  error?: string;
  /** 实际使用的协议和地址（和填的不一样时，调用方可以据此纠正配置） */
  type?: "openai-compat" | "anthropic";
  baseURL?: string;
  notes?: string[];
  ms?: number;
}

/**
 * 真发一次很小的对话请求：列模型接口通不代表对话接口能用（地址、协议、模型名、套餐权限都可能不对），
 * 添加 / 保存模型前用它验证，问题当场暴露，不留到用户第一次提问才报错。
 */
export async function pingModel(req: PingRequest, timeoutMs = 25_000): Promise<PingResult> {
  const key = (req.apiKey ?? "").trim();
  const model = (req.model ?? "").trim();
  if (!key) return { ok: false, error: "请先填写 API Key" };
  if (!model) return { ok: false, error: "请先填写默认模型" };
  const n = normalizeEndpoint(req.type, req.baseURL);
  if (n.type === "openai-compat" && !n.baseURL) return { ok: false, error: "请先填写 Base URL" };
  if (n.baseURL && !/^https?:\/\//i.test(n.baseURL)) return { ok: false, error: "Base URL 必须以 http:// 或 https:// 开头" };

  const adapter =
    n.type === "anthropic"
      ? anthropic({ id: "ping", apiKey: key, model, baseURL: n.baseURL || undefined, maxTokens: 16 })
      : openaiCompat({ id: "ping", apiKey: key, model, baseURL: n.baseURL, extraBody: { max_tokens: 16 } });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  const t0 = Date.now();
  try {
    await adapter.chat([{ role: "user", content: "hi" }], [], ac.signal);
    return { ok: true, type: n.type, baseURL: n.baseURL, notes: n.notes, ms: Date.now() - t0 };
  } catch (e: any) {
    const error = ac.signal.aborted ? `测试调用超过 ${Math.round(timeoutMs / 1000)} 秒没有响应` : String(e?.message ?? e);
    return { ok: false, error, type: n.type, baseURL: n.baseURL, notes: n.notes };
  } finally {
    clearTimeout(timer);
  }
}

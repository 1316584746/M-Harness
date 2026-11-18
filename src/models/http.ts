import { z } from "zod";
import type { ToolSpec } from "../core/types";

/** POST JSON，对 429 / 5xx / 网络错误做指数退避重试 */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal: AbortSignal,
  retries = 2,
): Promise<any> {
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(body),
        signal,
      });
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      const err = new Error(`HTTP ${res.status}: ${text.slice(0, 500)}`);
      if (res.status !== 429 && res.status < 500) throw Object.assign(err, { fatal: true });
      lastErr = err;
    } catch (e: any) {
      if (signal.aborted || e?.fatal) throw e;
      lastErr = e;
    }
    if (i < retries) await new Promise(r => setTimeout(r, 800 * 2 ** i));
  }
  throw lastErr;
}

/** zod → JSON Schema（去掉模型 API 不需要的 $schema） */
export function toJsonSchema(spec: ToolSpec): Record<string, unknown> {
  if (spec.jsonSchema) return spec.jsonSchema;
  const js: any = z.toJSONSchema(spec.schema);
  delete js.$schema;
  return js;
}

export function safeParseArgs(raw: unknown): unknown {
  if (typeof raw !== "string") return raw ?? {};
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return { __invalidJson: raw };
  }
}

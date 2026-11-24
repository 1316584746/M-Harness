import { z } from "zod";
import { bodyError, explainModelError } from "./endpoint";
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
      if (res.ok) {
        let json: any;
        try {
          json = JSON.parse(text);
        } catch {
          throw Object.assign(new Error(`服务商返回的不是 JSON（多半是地址不对，打到了网页上）：${text.slice(0, 120)}`), { fatal: true });
        }
        const be = bodyError(json, url);
        if (be) throw Object.assign(new Error(be), { fatal: true });
        return json;
      }
      const err = new Error(explainModelError(res.status, brief(text), url));
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

/** 从错误正文里取一句话：JSON 里的 message / msg，否则截断原文 */
function brief(text: string): string {
  try {
    const j = JSON.parse(text);
    const m = j?.error?.message ?? j?.error ?? j?.message ?? j?.msg;
    if (m) return typeof m === "string" ? m : JSON.stringify(m);
  } catch {
    /* 不是 JSON */
  }
  return text.replace(/\s+/g, " ").slice(0, 200);
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

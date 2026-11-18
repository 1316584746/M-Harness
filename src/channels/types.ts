export interface IncomingMessage {
  channel: string;
  /** 会话标识：同一个群 / 单聊共享一份上下文 */
  conversationId: string;
  userId: string;
  text: string;
  reply: (text: string) => Promise<void>;
}

export interface RouteRequest {
  headers: Record<string, string | string[] | undefined>;
  rawBody: string;
  url: URL;
}

export interface RouteResponse {
  status: number;
  body: unknown;
}

export interface Channel {
  name: string;
  /** 挂在 HTTP 服务上的回调路径 */
  path: string;
  handle(req: RouteRequest, onMessage: (m: IncomingMessage) => void): Promise<RouteResponse>;
}

export function header(h: RouteRequest["headers"], name: string): string {
  const v = h[name.toLowerCase()];
  return Array.isArray(v) ? v[0] ?? "" : v ?? "";
}

/** 按字符数分段，避免超出各 OA 单条消息长度限制 */
export function chunkText(text: string, size = 3000): string[] {
  if (text.length <= size) return [text];
  const out: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.5) cut = size;
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest) out.push(rest);
  return out;
}

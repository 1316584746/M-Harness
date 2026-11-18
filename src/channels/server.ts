import http from "node:http";
import type { Runtime } from "../runtime";
import { DingtalkChannel } from "./dingtalk";
import { FeishuChannel } from "./feishu";
import { LarkCliChannel } from "./lark-cli";
import { SessionManager } from "./session";
import type { Channel, IncomingMessage } from "./types";

const MAX_BODY = 1024 * 1024;

export function buildChannels(rt: Runtime): Channel[] {
  const c = rt.config.channels;
  const list: Channel[] = [];
  if (c.feishu) list.push(new FeishuChannel(c.feishu));
  if (c.dingtalk) list.push(new DingtalkChannel(c.dingtalk));
  return list;
}

function isLoopback(host: string) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

/** 启动办公通道回调服务。额外提供 /healthz 与（仅本机监听时）/dev/chat 方便本地联调 */
export function startServer(rt: Runtime, channels = buildChannels(rt), log = console.log): http.Server {
  const sessions = new SessionManager(rt, log);
  const { port, host } = rt.config.channels.server;
  const routes = new Map(channels.map(c => [c.path, c]));
  const devEnabled = isLoopback(host);

  const server = http.createServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(body));
    };
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      if (req.method === "GET" && url.pathname === "/healthz") {
        return send(200, { ok: true, channels: channels.map(c => c.name), providers: rt.registry.names() });
      }
      if (req.method !== "POST") return send(404, { error: "not found" });
      const rawBody = await readBody(req);

      if (devEnabled && url.pathname === "/dev/chat") {
        const b = JSON.parse(rawBody || "{}");
        const replies: string[] = [];
        await sessions.handle({
          channel: "dev",
          conversationId: `dev:${b.conversationId ?? "default"}`,
          userId: "dev",
          text: String(b.text ?? ""),
          reply: async t => void replies.push(t),
        });
        return send(200, { replies });
      }

      const ch = routes.get(url.pathname);
      if (!ch) return send(404, { error: "not found" });
      const r = await ch.handle({ headers: req.headers, rawBody, url }, (m: IncomingMessage) => {
        void sessions.handle(m);
      });
      send(r.status, r.body);
    } catch (e: any) {
      log(`[server] ${e?.message ?? e}`);
      send(e?.code === "TOO_LARGE" ? 413 : 500, { error: "internal error" });
    }
  });

  // 飞书 CLI 长连接通道（不依赖 HTTP 回调与公网）
  const larkCfg = rt.config.channels.larkCli;
  const lark = larkCfg ? new LarkCliChannel(larkCfg, log) : undefined;
  server.on("close", () => lark?.stop());
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.once(sig, () => {
      lark?.stop();
      server.close();
      setTimeout(() => process.exit(0), 3500).unref(); // 给 consume 留时间清理服务端订阅
    });
  }

  server.listen(port, host, () => {
    log(`harness 通道服务已启动 http://${host}:${port}`);
    for (const c of channels) log(`  - ${c.name.padEnd(8)} POST ${c.path}`);
    if (lark) log(`  - feishu-cli  长连接（lark-cli event consume）`);
    if (devEnabled) log(`  - dev      POST /dev/chat  {"text":"你好","conversationId":"x"}`);
    if (!channels.length && !lark) log("  （配置里没有启用任何办公通道，只有 /dev/chat 可用）");
    lark?.start(m => void sessions.handle(m));
  });
  return server;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error("body too large"), { code: "TOO_LARGE" }));
        req.destroy();
      } else chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

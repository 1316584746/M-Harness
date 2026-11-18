import type { ConnKind, Connection } from "../shared/connections";

/**
 * 连接类插件（DBX 里叫 connection-provider）：插件自己不存连接，由宿主保存，用的时候把连接配置交给插件的后台程序。
 * 这里把本软件「设置 → 连接」里的连接，翻译成各插件认的配置。按插件清单里的 database_type 找适配器。
 */
export interface ConnAdapter {
  kind: ConnKind;
  /** 给插件后台 connection/connect 用的 connection 对象（含密码，只在主进程里流转） */
  toConnection(c: Connection, secrets: Record<string, string>): Record<string, unknown>;
}

function xxljob(c: Connection, secrets: Record<string, string>): Record<string, unknown> {
  const u = new URL(c.fields.url.trim());
  const https = u.protocol === "https:";
  const path = u.pathname.replace(/\/+$/, "") || "/";
  return {
    id: c.id,
    connectionId: c.id,
    name: c.name,
    display_name: c.name,
    host: u.hostname,
    port: Number(u.port || (https ? 443 : 80)),
    username: c.fields.username ?? "",
    password: secrets.password ?? "",
    config: {
      scheme: https ? "https" : "http",
      admin_version: c.fields.adminVersion || "3.4",
      context_path: path,
      environment: c.env,
      read_only: false,
      is_production: c.env === "生产",
    },
  };
}

function gitlab(c: Connection, secrets: Record<string, string>): Record<string, unknown> {
  const u = new URL(c.fields.url.trim());
  const https = u.protocol === "https:";
  const basePath = u.pathname.replace(/\/+$/, "");
  const password = c.fields.authMethod === "password";
  const readOnly = c.fields.readOnly !== "false";
  const ext = {
    scheme: https ? "https" : "http",
    base_path: basePath,
    auth_method: password ? "password" : "token",
    read_only: readOnly,
    insecure_skip_verify: c.fields.insecureSkipVerify === "true",
    connect_timeout_secs: 15,
    environment: c.env,
  };
  return {
    id: c.id,
    connectionId: c.id,
    name: c.name,
    display_name: c.name,
    host: u.hostname,
    port: Number(u.port || (https ? 443 : 80)),
    username: password ? (c.fields.username ?? "") : "",
    password: password ? (secrets.password ?? "") : "",
    api_token: password ? "" : (secrets.token ?? ""),
    read_only: readOnly,
    // DBX 里这份配置叫 external_config；插件两种拼写都认
    external_config: ext,
    externalConfig: ext,
    config: ext,
    secrets: password ? { password: secrets.password ?? "" } : { token: secrets.token ?? "" },
  };
}

export const CONN_ADAPTERS: Record<string, ConnAdapter> = {
  "xxl-job-dbx-plugin": { kind: "xxljob", toConnection: xxljob },
  gitlab: { kind: "gitlab", toConnection: gitlab },
};



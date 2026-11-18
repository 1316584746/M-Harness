/**
 * 连接：XXL-JOB / 数据库 / Redis / 服务器 / 内嵌终端。
 * 每一类可以有多个，用「环境」（开发、测试、预发、生产…）和「机器」（节点名、机房…）区分。
 * 密码、密钥口令这类秘密只存在主进程（加密落盘），界面里永远拿不到明文，只知道「有没有设置」。
 */

export type ConnKind = "xxljob" | "gitlab" | "database" | "redis" | "server" | "terminal";

export const CONN_KINDS: Array<{ kind: ConnKind; label: string; icon: string; color: string; hint: string }> = [
  { kind: "xxljob", label: "XXL-JOB", icon: "timer", color: "#f59e0b", hint: "调度中心（xxl-job-admin）的地址和账号" },
  { kind: "gitlab", label: "GitLab", icon: "branch", color: "#fc6d26", hint: "GitLab 实例的地址和访问令牌（Personal Access Token）" },
  { kind: "database", label: "数据库", icon: "box", color: "#3b82f6", hint: "MySQL、PostgreSQL、SQL Server、Oracle 等" },
  { kind: "redis", label: "Redis", icon: "spark", color: "#ef4444", hint: "单机 Redis，支持密码、库号和 TLS" },
  { kind: "server", label: "服务器", icon: "globe", color: "#10b981", hint: "通过 SSH 登录的服务器" },
  { kind: "terminal", label: "内嵌终端", icon: "terminal", color: "#8b5cf6", hint: "本机 shell，或者通过某个服务器连接打开的终端" },
];

export const ENV_PRESETS = ["开发", "测试", "预发", "生产"];

export const DB_TYPES: Array<{ value: string; label: string; port: number }> = [
  { value: "mysql", label: "MySQL / MariaDB", port: 3306 },
  { value: "postgresql", label: "PostgreSQL", port: 5432 },
  { value: "sqlserver", label: "SQL Server", port: 1433 },
  { value: "oracle", label: "Oracle", port: 1521 },
  { value: "mongodb", label: "MongoDB", port: 27017 },
  { value: "clickhouse", label: "ClickHouse", port: 9000 },
  { value: "other", label: "其他", port: 0 },
];

export type FieldKind = "text" | "number" | "select" | "password" | "bool" | "connection";

export interface FieldDef {
  key: string;
  label: string;
  kind: FieldKind;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  options?: Array<{ value: string; label: string }>;
  /** kind=connection 时，从哪一类连接里选 */
  of?: ConnKind;
  /** 只在满足条件时显示 / 校验 */
  when?: (f: Record<string, string>) => boolean;
}

/** 字段值统一用字符串存（数字、布尔也是），界面和校验都简单 */
export const CONN_FIELDS: Record<ConnKind, FieldDef[]> = {
  xxljob: [
    { key: "url", label: "调度中心地址", kind: "text", required: true, placeholder: "http://10.0.0.1:8080/xxl-job-admin", hint: "到 xxl-job-admin 这一层，不带 /login" },
    { key: "username", label: "用户名", kind: "text", required: true, placeholder: "admin" },
    { key: "password", label: "密码", kind: "password", required: true },
    {
      key: "adminVersion",
      label: "调度中心版本",
      kind: "select",
      hint: "给 XXL-JOB 插件用，不确定就保持默认",
      options: [
        { value: "3.5", label: "3.5.x" },
        { value: "3.4", label: "3.4.x" },
        { value: "2.3", label: "2.3.x" },
        { value: "2.2", label: "2.2.x" },
      ],
    },
  ],
  gitlab: [
    { key: "url", label: "GitLab 地址", kind: "text", required: true, placeholder: "https://gitlab.example.com", hint: "只填到站点根；如果挂在子路径下（如 /gitlab）一起写上，不带 /api/v4" },
    {
      key: "authMethod",
      label: "认证方式",
      kind: "select",
      required: true,
      options: [
        { value: "token", label: "访问令牌（推荐）" },
        { value: "password", label: "账号密码" },
      ],
    },
    { key: "token", label: "访问令牌", kind: "password", required: true, when: f => f.authMethod !== "password", hint: "GitLab → 头像 → 偏好设置 → 访问令牌，勾选 api（只读用 read_api 也行）" },
    { key: "username", label: "用户名 / 邮箱", kind: "text", required: true, when: f => f.authMethod === "password" },
    { key: "password", label: "密码", kind: "password", required: true, when: f => f.authMethod === "password", hint: "开了两步验证的账号不能用密码，请改用访问令牌" },
    { key: "readOnly", label: "只读模式", kind: "bool", hint: "打开后插件不能评论、合并、改状态，只能看" },
    { key: "insecureSkipVerify", label: "跳过 TLS 证书校验", kind: "bool", hint: "只给自签名证书的内网 GitLab 用" },
  ],
  database: [
    { key: "dbType", label: "类型", kind: "select", required: true, options: DB_TYPES.map(d => ({ value: d.value, label: d.label })) },
    { key: "host", label: "主机", kind: "text", required: true, placeholder: "10.0.0.2" },
    { key: "port", label: "端口", kind: "number", required: true },
    { key: "database", label: "库名 / 服务名", kind: "text", placeholder: "可选" },
    { key: "username", label: "用户名", kind: "text" },
    { key: "password", label: "密码", kind: "password" },
  ],
  redis: [
    { key: "host", label: "主机", kind: "text", required: true, placeholder: "10.0.0.3" },
    { key: "port", label: "端口", kind: "number", required: true },
    { key: "db", label: "库号", kind: "number", placeholder: "0" },
    { key: "username", label: "用户名", kind: "text", placeholder: "Redis 6+ ACL 用户，没有就留空" },
    { key: "password", label: "密码", kind: "password" },
    { key: "tls", label: "使用 TLS", kind: "bool" },
  ],
  server: [
    { key: "host", label: "主机", kind: "text", required: true, placeholder: "10.0.0.4" },
    { key: "port", label: "SSH 端口", kind: "number", required: true },
    { key: "username", label: "用户名", kind: "text", required: true, placeholder: "root" },
    {
      key: "authType",
      label: "登录方式",
      kind: "select",
      required: true,
      options: [
        { value: "password", label: "密码" },
        { value: "key", label: "私钥文件" },
      ],
    },
    { key: "password", label: "密码", kind: "password", when: f => f.authType !== "key" },
    { key: "keyPath", label: "私钥文件路径", kind: "text", required: true, placeholder: "C:\\Users\\me\\.ssh\\id_rsa", when: f => f.authType === "key", hint: "只记路径，私钥文件本身不会被复制" },
    { key: "passphrase", label: "私钥口令", kind: "password", when: f => f.authType === "key", hint: "私钥没有口令就留空" },
  ],
  terminal: [
    {
      key: "mode",
      label: "打开方式",
      kind: "select",
      required: true,
      options: [
        { value: "local", label: "本机 shell" },
        { value: "server", label: "通过服务器连接" },
      ],
    },
    {
      key: "shell",
      label: "Shell",
      kind: "select",
      when: f => f.mode !== "server",
      options: [
        { value: "", label: "系统默认" },
        { value: "powershell", label: "PowerShell" },
        { value: "cmd", label: "命令提示符 (cmd)" },
        { value: "bash", label: "bash" },
        { value: "zsh", label: "zsh" },
        { value: "custom", label: "自定义路径" },
      ],
    },
    { key: "shellPath", label: "Shell 路径", kind: "text", required: true, placeholder: "C:\\Program Files\\Git\\bin\\bash.exe", when: f => f.mode !== "server" && f.shell === "custom" },
    { key: "cwd", label: "起始目录", kind: "text", placeholder: "可选，默认用户主目录", when: f => f.mode !== "server" },
    { key: "serverId", label: "服务器连接", kind: "connection", of: "server", required: true, when: f => f.mode === "server" },
    { key: "remoteDir", label: "登录后进入的目录", kind: "text", placeholder: "可选", when: f => f.mode === "server" },
  ],
};

export const DEFAULTS: Record<ConnKind, Record<string, string>> = {
  xxljob: { url: "", username: "admin", adminVersion: "3.4" },
  gitlab: { url: "https://", authMethod: "token", readOnly: "true" },
  database: { dbType: "mysql", port: "3306" },
  redis: { port: "6379", db: "0" },
  server: { port: "22", authType: "password" },
  terminal: { mode: "local", shell: "" },
};

export const isSecretField = (f: FieldDef): boolean => f.kind === "password";

export interface Connection {
  id: string;
  kind: ConnKind;
  name: string;
  /** 环境：开发 / 测试 / 预发 / 生产，或自己填 */
  env: string;
  /** 机器：节点名、机房、实例名… */
  machine: string;
  note?: string;
  enabled: boolean;
  /** 非秘密字段 */
  fields: Record<string, string>;
  /** 哪些秘密字段已经设置过（不含内容） */
  secretSet: Record<string, boolean>;
  createdAt: number;
  updatedAt: number;
}

export interface ConnectionInput {
  id?: string;
  kind: ConnKind;
  name: string;
  env: string;
  machine: string;
  note?: string;
  enabled?: boolean;
  fields: Record<string, string>;
  /** 秘密字段：不传这个键 = 保持原值；传空字符串 = 清除；传内容 = 更新 */
  secrets?: Record<string, string>;
}

export interface ConnTestResult {
  ok: boolean;
  ms: number;
  message: string;
  /** 探测到的服务端信息（版本、协议），没有就不填 */
  detail?: string;
}

export const connKindOf = (k: ConnKind) => CONN_KINDS.find(x => x.kind === k)!;

/** 这个字段在当前取值下要不要显示 */
export const fieldVisible = (f: FieldDef, vals: Record<string, string>): boolean => !f.when || f.when(vals);

const isPort = (s: string) => /^\d{1,5}$/.test(s) && Number(s) >= 1 && Number(s) <= 65535;

/** 校验；返回错误文字，没问题返回空串。secretSet：已经保存过的秘密字段（编辑时留空表示不改） */
export function validateConnection(input: ConnectionInput, secretSet: Record<string, boolean> = {}): string {
  const name = input.name.trim();
  if (!name) return "请填写连接名称";
  if (name.length > 60) return "连接名称太长（最多 60 字）";
  if (!input.env.trim()) return "请选择或填写环境";
  if (input.env.trim().length > 20) return "环境名太长（最多 20 字）";
  if (input.machine.length > 60) return "机器名太长（最多 60 字）";
  const defs = CONN_FIELDS[input.kind];
  if (!defs) return "不支持的连接类型";
  const vals = input.fields;
  for (const d of defs) {
    if (!fieldVisible(d, vals)) continue;
    const secret = isSecretField(d);
    const v = (secret ? input.secrets?.[d.key] : vals[d.key]) ?? "";
    const has = secret ? v !== "" || (input.secrets?.[d.key] === undefined && !!secretSet[d.key]) : v.trim() !== "";
    if (d.required && !has) return `请填写「${d.label}」`;
    if (!secret && v.trim()) {
      if (d.kind === "number" && !/^\d+$/.test(v.trim())) return `「${d.label}」要填数字`;
      if (d.key === "port" && !isPort(v.trim())) return "端口要在 1 到 65535 之间";
      if (d.key === "db" && Number(v) > 1024) return "库号不合法";
      if (d.kind === "select" && d.options && !d.options.some(o => o.value === v)) return `「${d.label}」的取值不合法`;
      if (v.length > 500) return `「${d.label}」太长`;
    }
  }
  if (input.kind === "xxljob") {
    try {
      const u = new URL(vals.url.trim());
      if (u.protocol !== "http:" && u.protocol !== "https:") return "调度中心地址要以 http:// 或 https:// 开头";
    } catch {
      return "调度中心地址不合法";
    }
  }
  if (input.kind === "gitlab") {
    try {
      const u = new URL(vals.url.trim());
      if (u.protocol !== "http:" && u.protocol !== "https:") return "GitLab 地址要以 http:// 或 https:// 开头";
      if (/\/api\/v4/.test(u.pathname)) return "地址不要带 /api/v4，只填到站点根（或子路径）";
    } catch {
      return "GitLab 地址不合法";
    }
  }
  if ((input.kind === "database" || input.kind === "redis" || input.kind === "server") && /[\s/\\]/.test(vals.host.trim())) return "主机里不能有空格或斜杠，只填 IP 或域名";
  return "";
}

/** 列表里一行的摘要（不含秘密） */
export function connSummary(c: Pick<Connection, "kind" | "fields">, nameOfServer?: (id: string) => string | undefined): string {
  const f = c.fields;
  switch (c.kind) {
    case "xxljob":
      return `${f.url ?? ""}${f.username ? ` · ${f.username}` : ""}`;
    case "gitlab":
      return `${f.url ?? ""} · ${f.authMethod === "password" ? `账号 ${f.username ?? ""}` : "访问令牌"}${f.readOnly === "false" ? "" : " · 只读"}`;
    case "database": {
      const t = DB_TYPES.find(d => d.value === f.dbType)?.label ?? f.dbType;
      return `${t} · ${f.host}:${f.port}${f.database ? `/${f.database}` : ""}${f.username ? ` · ${f.username}` : ""}`;
    }
    case "redis":
      return `${f.host}:${f.port}${f.db && f.db !== "0" ? ` · 库 ${f.db}` : ""}${f.tls === "true" ? " · TLS" : ""}`;
    case "server":
      return `${f.username}@${f.host}:${f.port} · ${f.authType === "key" ? "私钥" : "密码"}`;
    case "terminal":
      return f.mode === "server" ? `服务器：${nameOfServer?.(f.serverId) ?? "（已删除）"}${f.remoteDir ? ` · ${f.remoteDir}` : ""}` : `本机 · ${f.shell === "custom" ? f.shellPath : f.shell || "系统默认"}${f.cwd ? ` · ${f.cwd}` : ""}`;
  }
}

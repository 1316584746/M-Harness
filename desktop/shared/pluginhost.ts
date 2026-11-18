/** 插件运行：右侧栏列出的、带界面的已装插件 */
export interface UiPlugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  /** 图标（data URL），没有就用名字首字 */
  icon?: string;
  /** 带不带本机后台程序 */
  backend: boolean;
  /** 清单里声明的权限，原样展示给用户 */
  permissions: string[];
  /** 用户是否已经确认信任并允许运行 */
  trusted: boolean;
  /** 连接类插件（如 XXL-JOB）：用「设置 → 连接」里的哪一类连接 */
  connKind?: import("./connections").ConnKind;
  /** 声明了读数据库的权限（host.data:read / host.schema:read / host.connections:read）：要用户选哪些数据库连接给它用 */
  dataAccess?: boolean;
}

export interface PluginReply {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export const PLUGIN_SCHEME = "harness-plugin";

/** 地址里的主机名会被转成小写，所以按小写比较插件 id */
export const pluginUrl = (id: string, entry = ""): string => `${PLUGIN_SCHEME}://${id.toLowerCase()}/${entry}`;

/** 给界面选连接用的一条（不含秘密） */
export interface PluginConn {
  id: string;
  name: string;
  env: string;
  machine: string;
  summary: string;
  /** 数据库类插件用：库类型（mysql / postgres）和默认库名 */
  dbType?: string;
  database?: string;
}

/** 给数据库类插件授权界面用：所有能用的数据库连接，和已经授权的 */
export interface PluginDbAccess {
  options: import("./db").DbConnOption[];
  granted: string[];
}

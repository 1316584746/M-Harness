/** 开机自启动：交给系统的「登录项」管（Windows 注册表 Run 项 / macOS 登录项），开关状态以系统里的为准 */

export interface LoginApp {
  isPackaged: boolean;
  setLoginItemSettings(s: { openAtLogin: boolean }): void;
  getLoginItemSettings(): { openAtLogin: boolean };
}

export interface AutostartState {
  /** 这台机器上、当前这种运行方式下能不能设置 */
  supported: boolean;
  enabled: boolean;
  /** 不能设置时的原因 */
  reason?: string;
}

function unsupported(app: LoginApp, platform: NodeJS.Platform): string | undefined {
  if (platform !== "win32" && platform !== "darwin") return "当前系统不支持（只支持 Windows 和 macOS）";
  // 开发模式下运行的是 electron 本体，写进登录项后开机只会启动一个空的 Electron，不是这个软件
  if (!app.isPackaged) return "开发模式（npm run desktop）下不能设置，请用安装好的版本";
  return undefined;
}

export function getAutostart(app: LoginApp, platform: NodeJS.Platform = process.platform): AutostartState {
  const reason = unsupported(app, platform);
  if (reason) return { supported: false, enabled: false, reason };
  try {
    return { supported: true, enabled: !!app.getLoginItemSettings().openAtLogin };
  } catch (e: any) {
    return { supported: false, enabled: false, reason: `读取系统登录项失败：${e?.message ?? e}` };
  }
}

export function setAutostart(app: LoginApp, on: boolean, platform: NodeJS.Platform = process.platform): AutostartState {
  const reason = unsupported(app, platform);
  if (reason) return { supported: false, enabled: false, reason };
  try {
    app.setLoginItemSettings({ openAtLogin: !!on });
  } catch (e: any) {
    return { supported: true, enabled: getAutostart(app, platform).enabled, reason: `设置失败：${e?.message ?? e}` };
  }
  // 以系统里实际生效的为准（可能被组策略 / 安全软件拦了）
  const now = getAutostart(app, platform);
  return now.enabled === !!on ? now : { ...now, reason: "系统没有接受这个设置（可能被安全软件或策略拦截）" };
}

import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, protocol, safeStorage, session, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { Backend } from "./backend";
import { HomeService } from "./home";
import { Updater, type AutoUpdaterLike } from "./updater";
import type { RunRequest } from "../shared/api";
import { PLUGIN_SCHEME } from "../shared/pluginhost";
import type { ConnectionInput } from "../shared/connections";

// 开发时数据放在项目根（与 CLI 共用 harness.config.json / .traces），打包后放用户数据目录
const home = app.isPackaged ? app.getPath("userData") : process.cwd();
process.chdir(home);

let win: BrowserWindow | null = null;
let backend: Backend;

function send(channel: string, payload: unknown) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

const OVERLAY = {
  dark: { color: "#141414", symbolColor: "#c8c8c8", height: 40 },
  light: { color: "#efeff2", symbolColor: "#333333", height: 40 },
};

const ICON = path.join(app.getAppPath(), "build", "icon.png");

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: "#181818",
    title: "M-Harness",
    // 开发时用项目里的图标；打包后由 electron-builder 把 build/icon.ico 写进 exe
    ...(fs.existsSync(ICON) ? { icon: ICON } : {}),
    // 无系统菜单栏；自绘标题栏，窗口按钮用系统覆盖层
    titleBarStyle: "hidden",
    ...(process.platform === "darwin" ? { trafficLightPosition: { x: 14, y: 14 } } : { titleBarOverlay: OVERLAY.dark }),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // 开发时 F12 打开开发者工具（菜单已去掉）
  if (!app.isPackaged) {
    win.webContents.on("before-input-event", (_e, input) => {
      if (input.type === "keyDown" && input.key === "F12") win?.webContents.toggleDevTools();
    });
  }

  // 只允许应用自身页面；外链交给系统浏览器
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, url) => {
    if (!url.startsWith("file://") && !url.startsWith(process.env["ELECTRON_RENDERER_URL"] ?? "\0")) e.preventDefault();
  });

  if (process.env["ELECTRON_RENDERER_URL"]) void win.loadURL(process.env["ELECTRON_RENDERER_URL"]);
  else void win.loadFile(path.join(__dirname, "../renderer/index.html"));
}

/** 新缺陷来了：弹系统通知，点击后回到软件并打开缺陷列表 */
function notifyDefects(title: string, body: string) {
  if (!Notification.isSupported() || process.env["HARNESS_NO_NOTIFY"]) return; // 自动化测试时不弹真的系统通知
  const n = new Notification({ title, body, silent: false });
  n.on("click", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
    send("defects:open", null);
  });
  n.show();
}

let updater: Updater;
let homeSvc: HomeService;

/** 只有打包后的 Windows 安装版才能应用内更新；其它情况打开 Release 页面 */
async function loadAutoUpdater(): Promise<AutoUpdaterLike> {
  const m: any = await import("electron-updater");
  return (m.autoUpdater ?? m.default?.autoUpdater) as AutoUpdaterLike;
}

function registerIpc() {
  ipcMain.handle("home:weather", (_e, opts) => homeSvc.weather({ refresh: !!opts?.refresh, city: typeof opts?.city === "string" ? opts.city.slice(0, 60) : undefined }));
  ipcMain.handle("home:daily", () => homeSvc.daily());
  ipcMain.handle("home:todos", () => backend.homeTodos());
  ipcMain.handle("update:state", () => updater.state);
  ipcMain.handle("update:check", () => updater.check());
  ipcMain.handle("update:download", () => updater.download());
  ipcMain.handle("update:install", () => updater.install());
  ipcMain.handle("state:get", () => backend.getState());
  ipcMain.handle("config:save", (_e, text: string) => backend.saveConfig(String(text)));
  ipcMain.handle("workspace:pick", async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory"], title: "选择工作区（沙箱根目录）" });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle("folder:pick", async (_e, title?: string) => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"], title: title ? String(title) : "选择文件夹" });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle("file:pick", async (_e, title?: string) => {
    const r = await dialog.showOpenDialog(win!, { properties: ["openFile"], title: title ? String(title) : "选择文件" });
    return r.canceled ? null : r.filePaths[0];
  });
  ipcMain.handle("repo:list", () => backend.listRepos());
  ipcMain.handle("automation:list", () => backend.automation.list());
  ipcMain.handle("automation:save", (_e, input: any) => backend.automation.saveItem(input));
  ipcMain.handle("automation:remove", (_e, id: string) => backend.automation.remove(String(id)));
  ipcMain.handle("automation:toggle", (_e, id: string, on: boolean) => backend.automation.setEnabled(String(id), !!on));
  ipcMain.handle("automation:run", (_e, id: string) => backend.automation.runNow(String(id)));
  ipcMain.handle("automation:abort", (_e, id: string) => backend.automation.abort(String(id)));
  ipcMain.handle("defects:get", () => backend.defectsGet());
  ipcMain.handle("defects:refresh", () => backend.defects.refresh());
  ipcMain.handle("defects:seen", () => void backend.defects.markSeen());
  ipcMain.handle("defects:transitions", (_e, key: string) => backend.defectTransitions(String(key)));
  ipcMain.handle("defects:transition", (_e, key: string, tid: string) => backend.defectTransition(String(key), String(tid)));
  ipcMain.handle("automation:running", () => backend.automation.list().filter(a => backend.automation.isRunning(a.id)).map(a => a.id));
  ipcMain.handle("repo:sync", (_e, name: string) => backend.repoSync(String(name)));
  ipcMain.handle("repo:diffstat", (_e, names: unknown) => backend.repoDiffStat(Array.isArray(names) ? names.map(String) : []));
  ipcMain.handle("task:folder", async (_e, id: string, open: boolean) => {
    const dir = backend.taskFolder(String(id));
    if (open && !process.env.HARNESS_DBX_OPEN_LOG) await shell.openPath(dir);
    return dir;
  });
  ipcMain.handle("plugins:market", (_e, refresh: boolean) => backend.pluginMarket(refresh));
  ipcMain.handle("plugins:fetch-url", (_e, url: string) => backend.pluginFetchUrl(String(url)));
  ipcMain.handle("plugins:install", (_e, id: string) => backend.pluginInstall(String(id)));
  ipcMain.handle("plugins:uninstall", (_e, id: string) => backend.pluginUninstall(String(id)));
  ipcMain.handle("connections:list", () => backend.connectionList());
  ipcMain.handle("connections:save", (_e, input: ConnectionInput) => backend.connectionSave(input));
  ipcMain.handle("connections:remove", (_e, id: string) => backend.connectionRemove(String(id)));
  ipcMain.handle("connections:toggle", (_e, id: string, on: boolean) => backend.connectionToggle(String(id), !!on));
  ipcMain.handle("connections:test", (_e, input: ConnectionInput) => backend.connectionTest(input));
  ipcMain.handle("connections:gitlab-hosts-info", () => backend.gitlabHostsInfo());
  ipcMain.handle("connections:gitlab-from-hosts", () => backend.connectionFromHosts());
  ipcMain.handle("plugins:install-package", (_e, bytes: Uint8Array) => backend.pluginInstallPackage(bytes));
  ipcMain.handle("plugins:install-url", (_e, url: string) => backend.pluginInstallUrl(String(url)));
  ipcMain.handle("plugins:repos", () => backend.pluginRepoList());
  ipcMain.handle("plugins:repo-add", (_e, r: { id: string; name?: string; url: string }) => backend.pluginRepoAdd(r));
  ipcMain.handle("plugins:repo-remove", (_e, id: string) => backend.pluginRepoRemove(String(id)));
  ipcMain.handle("plugins:repo-toggle", (_e, id: string, on: boolean) => backend.pluginRepoToggle(String(id), !!on));
  ipcMain.handle("plugins:open-dir", async () => {
    const d = backend.pluginDir();
    fs.mkdirSync(d, { recursive: true });
    const err = await shell.openPath(d);
    return err ? { ok: false, error: err } : { ok: true };
  });
  // 数据库页：库 / schema / 表列表、表结构、看数据、改数据、写 SQL
  ipcMain.handle("db:databases", (_e, id: string) => backend.dbCall(db => db.listDatabases(String(id))));
  ipcMain.handle("db:schemas", (_e, ref) => backend.dbCall(db => db.listSchemas(ref ?? {})));
  ipcMain.handle("db:extensions", (_e, ref) => backend.dbCall(db => db.listExtensions(ref ?? {})));
  ipcMain.handle("db:event-triggers", (_e, ref) => backend.dbCall(db => db.listEventTriggers(ref ?? {})));
  ipcMain.handle("db:tables", (_e, ref) => backend.dbCall(db => db.listTables(ref ?? {})));
  ipcMain.handle("db:structure", (_e, ref) => backend.dbCall(db => db.structure(ref ?? {})));
  ipcMain.handle("db:data", (_e, req) => backend.dbCall(db => db.tableData(req ?? {})));
  ipcMain.handle("db:count", (_e, req) => backend.dbCall(db => db.tableCount(req ?? {})));
  ipcMain.handle("db:query", (_e, req) => backend.dbCall(db => db.query(req ?? {}, "ui")));
  ipcMain.handle("db:apply", (_e, req) => backend.dbCall(db => db.applyRows(req ?? {})));
  ipcMain.handle("pluginhost:list", () => backend.pluginUiList());
  ipcMain.handle("pluginhost:connections", (_e, id: string) => backend.pluginConnections(String(id)));
  ipcMain.handle("pluginhost:trust", (_e, id: string, grants?: string[]) => backend.pluginTrust(String(id), grants));
  ipcMain.handle("pluginhost:db-access", (_e, id: string) => backend.pluginDbAccess(String(id)));
  ipcMain.handle("pluginhost:db-grants", (_e, id: string, ids: string[]) => backend.pluginSetGrants(String(id), ids));
  ipcMain.handle("pluginhost:request", (_e, id: string, method: string, params: unknown) => backend.pluginRequest(String(id), String(method), params));
  ipcMain.handle("workbench:todos", () => backend.workbenchTodos());
  ipcMain.handle("repo:inspect", (_e, dir: string) => backend.inspectRepo(String(dir)));
  ipcMain.handle("tools:list", () => backend.listTools());
  ipcMain.handle("mcp:status", () => backend.mcpStatus());
  ipcMain.handle("mcp:reconnect", (_e, name: string) => backend.mcpReconnect(String(name)));
  ipcMain.handle("skills:list", () => backend.listSkills());
  ipcMain.handle("skills:read", (_e, name: string) => backend.readSkill(String(name)));
  ipcMain.handle("skills:save", (_e, req) => backend.saveSkill(req ?? {}));
  ipcMain.handle("skills:delete", (_e, name: string) => backend.deleteSkill(String(name)));
  ipcMain.handle("rules:preview", () => backend.rulesPreview());
  ipcMain.handle("provider:models", (_e, name: string, opts) => backend.providerModels(String(name), opts ?? {}));
  ipcMain.handle("repo:branches", (_e, dir: string) => backend.listBranches(String(dir)));
  ipcMain.handle("githost:probe", (_e, req) => backend.probeGitHost(req ?? {}));
  ipcMain.handle("repo:clone", (_e, url: string, parentDir: string, name: string) => backend.cloneRepo(String(url), String(parentDir), String(name)));
  ipcMain.handle("path:open", (_e, p: string) => {
    // 只用于在资源管理器中定位 home 下的文件
    const abs = path.resolve(String(p));
    if (!abs.toLowerCase().startsWith(path.resolve(home).toLowerCase())) return;
    shell.showItemInFolder(abs);
  });

  ipcMain.handle("project:feishu-status", () => backend.feishuProjectStatus());
  ipcMain.handle("integration:status", (_e, kind: string) => backend.integrationStatus(String(kind)));
  ipcMain.handle("integration:update", (_e, kind: string) => backend.integrationCheckUpdate(String(kind)));
  ipcMain.handle("project:feishu-spaces", () => backend.feishuSpaces());
  ipcMain.handle("secret:get", (_e, name: string) => backend.getSecret(String(name)));
  ipcMain.handle("secret:set", (_e, name: string, value: string) => backend.setSecret(String(name), String(value)));
  ipcMain.handle("models:list", (_e, req) => backend.listModels(req ?? {}));
  ipcMain.handle("theme:set", (_e, theme: string) => {
    if (process.platform === "darwin" || !win || win.isDestroyed()) return;
    try {
      win.setTitleBarOverlay(theme === "light" ? OVERLAY.light : OVERLAY.dark);
    } catch {
      /* 平台不支持则忽略 */
    }
  });

  ipcMain.handle("run:start", (_e, req: RunRequest) => backend.run(req));
  ipcMain.handle("run:abort", (_e, runKey: string) => backend.abort(runKey));
  ipcMain.handle("approval:respond", (_e, id: string, ok: boolean, remember: boolean) =>
    backend.respondApproval(id, !!ok, !!remember),
  );

  ipcMain.handle("trace:list", () => backend.listTraces());
  ipcMain.handle("trace:read", (_e, file: string) => backend.readTrace(String(file)));


  ipcMain.handle("channel:start", () => backend.channelStart());
  ipcMain.handle("channel:stop", () => backend.channelStop());
}

// 插件界面走自定义协议；必须在 ready 之前声明
protocol.registerSchemesAsPrivileged([{ scheme: PLUGIN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }]);
const lock = app.requestSingleInstanceLock();
if (!lock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    // 只放行「读取本机字体列表」（设置里选字体用）和复制到剪贴板；其余权限请求一律拒绝
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "local-fonts" || permission === "clipboard-sanitized-write"));
    backend = new Backend(home, {
      send,
      notify: notifyDefects,
      // 连接里的密码用系统的加密存储（Windows 的 DPAPI 等）；系统不支持时才退回明文
      secrets: {
        encrypt: s => (safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(s).toString("base64")}` : `plain:${s}`),
        decrypt: s => (s.startsWith("enc:") ? safeStorage.decryptString(Buffer.from(s.slice(4), "base64")) : s.replace(/^plain:/, "")),
      },
    });
    protocol.handle(PLUGIN_SCHEME, req => backend.pluginHost.serve(req.url));
    // 测试时用 HARNESS_HOME_BASE 指向假的定位 / 天气 / 图片服务
    const hb = process.env["HARNESS_HOME_BASE"];
    homeSvc = new HomeService(home, hb ? { urls: { ip: [`${hb}/ip1`], weather: `${hb}/w`, geocode: `${hb}/geo`, bingApi: `${hb}/bing/api`, bingHost: `${hb}/bing` } } : {});
    setTimeout(() => homeSvc.prefetch(), 300);
    updater = new Updater({
      version: app.getVersion(),
      repo: () => process.env["HARNESS_UPDATE_REPO"] || backend.config.update.repo,
      send: s => send("update:state", s),
      openExternal: url => /^https:\/\/github\.com\//i.test(url) && void shell.openExternal(url),
      canAutoInstall: app.isPackaged && process.platform === "win32",
      loadAutoUpdater,
      apiBase: process.env["HARNESS_GITHUB_API"],
    });
    updater.start(() => backend.config.update.autoCheck);
    registerIpc();
    createWindow();
    setTimeout(() => backend.prefetchModels(), 1500);
    backend.startAutomation();
    backend.startDefects();
    app.on("activate", () => BrowserWindow.getAllWindows().length === 0 && createWindow());
  });
  app.on("before-quit", () => backend?.dispose());
  app.on("window-all-closed", () => process.platform !== "darwin" && app.quit());
}

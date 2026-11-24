/**
 * 注入到插件界面里的脚本：提供 window.dbxPlugin。
 * 界面运行在 sandbox="allow-scripts" 的 iframe 里，碰不到宿主页面；所有宿主能力都通过 postMessage 请求父页面，
 * 由父页面转给主进程（backend.invoke / 存储 / 上下文），所以这里只负责打包消息，不做任何权限判断。
 * 写成 ES5 且不含模板字符串，直接当字符串嵌进页面。
 */
export const PLUGIN_SHIM = `(function () {
  if (window.dbxPlugin) return;
  var pending = {}, seq = 0;
  var ctx = null, loc = "zh-CN", th = { appearance: "dark", tokens: {} }, caps = {};
  var onCtx = [], onEv = [], onBin = [], onInit = [];
  var readyRes;
  var ready = new Promise(function (r) { readyRes = r; });
  function post(m) { m.__dbx = 1; parent.postMessage(m, "*"); }
  function request(method, params) {
    return new Promise(function (res, rej) {
      var id = ++seq;
      pending[id] = { res: res, rej: rej };
      post({ kind: "request", id: id, method: method, params: params === undefined ? {} : params });
    });
  }
  function applyTheme() {
    var root = document.documentElement;
    root.setAttribute("data-dbx-theme", th.appearance);
    root.style.colorScheme = th.appearance;
    var t = th.tokens || {};
    for (var k in t) if (Object.prototype.hasOwnProperty.call(t, k)) root.style.setProperty(k, t[k]);
  }
  // 插件界面里写死的「DBX」字样：本软件不需要 DBX，把会误导人的提示换成不提 DBX 的说法
  var REWORD = [
    ["在 DBX 发送凭据前，请先确认该指纹。", "发送登录凭据前，请先确认这个服务器的指纹。"],
    ["Confirm this fingerprint before DBX sends credentials.", "Confirm this fingerprint before credentials are sent."]
  ];
  function reword(node) {
    if (node.nodeType === 3) {
      var s = node.nodeValue;
      for (var i = 0; i < REWORD.length; i++) if (s && s.indexOf(REWORD[i][0]) >= 0) s = s.split(REWORD[i][0]).join(REWORD[i][1]);
      if (s !== node.nodeValue) node.nodeValue = s;
    } else if (node.childNodes) {
      for (var j = 0; j < node.childNodes.length; j++) reword(node.childNodes[j]);
    }
  }
  if (typeof MutationObserver === "function") {
    new MutationObserver(function (list) {
      list.forEach(function (r) {
        if (r.type === "characterData") reword(r.target);
        else r.addedNodes.forEach(reword);
      });
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }
  function off(list, fn) { return function () { var i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); }; }
  function unsupported(name) { return function () { return Promise.reject(new Error("本软件暂不支持 " + name)); }; }
  window.addEventListener("message", function (e) {
    var m = e.data;
    if (!m || m.__dbx !== 1 || e.source !== parent) return;
    if (m.kind === "response") {
      var p = pending[m.id];
      if (!p) return;
      delete pending[m.id];
      if (m.error) p.rej(new Error(m.error)); else p.res(m.result);
    } else if (m.kind === "init") {
      ctx = m.context; loc = m.locale; th = m.theme; caps = m.capabilities || {};
      applyTheme();
      readyRes(ctx);
      onInit.slice().forEach(function (f) { try { f(ctx); } catch (_) {} });
    } else if (m.kind === "context") {
      ctx = m.context;
      onCtx.slice().forEach(function (f) { try { f(ctx); } catch (_) {} });
    } else if (m.kind === "theme") {
      th = m.theme; applyTheme();
    } else if (m.kind === "event") {
      onEv.slice().forEach(function (f) { try { f({ method: m.method, params: m.params }); } catch (_) {} });
    } else if (m.kind === "binary") {
      onBin.slice().forEach(function (f) { try { f({ channel: m.channel, data: m.data instanceof Uint8Array ? m.data : new Uint8Array(m.data || []) }); } catch (_) {} });
    }
  });
  var api = {
    ready: ready,
    get context() { return ctx; },
    get locale() { return loc; },
    get theme() { return th; },
    get capabilities() { return caps; },
    invoke: function (method, params, options) {
      return request("backend.invoke", { method: method, params: params === undefined ? {} : params, timeoutMs: options && options.timeoutMs });
    },
    request: request,
    notify: function (method, params) { post({ kind: "notify", method: method, params: params === undefined ? {} : params }); },
    onContext: function (fn) { onCtx.push(fn); return off(onCtx, fn); },
    onInit: function (fn) { onInit.push(fn); if (ctx) { try { fn(ctx); } catch (_) {} } return off(onInit, fn); },
    onEvent: function (fn) { onEv.push(fn); return off(onEv, fn); },
    onBinary: function (fn) { onBin.push(fn); return off(onBin, fn); },
    decodeBase64: function (s) {
      var b = atob(String(s || "")), u = new Uint8Array(b.length);
      for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
      return u;
    },
    encodeBase64: function (d) {
      var u = d instanceof Uint8Array ? d : new Uint8Array(d || []), s = "";
      for (var i = 0; i < u.length; i += 8192) s += String.fromCharCode.apply(null, u.subarray(i, i + 8192));
      return btoa(s);
    },
    sendBinary: function (channel, data) { return request("host.sendBinary", { channel: channel, data: data }); },
    readAsset: function (path) { return request("host.readAsset", { path: path }); },
    readAssetUrl: function (path) { return request("host.readAsset", { path: path, url: true }); },
    setTitle: function (title) { return request("host.setTitle", { title: title }); },
    getTitle: function () { return request("host.getTitle", {}); },
    openWorkbench: unsupported("openWorkbench"),
    executeCommand: unsupported("executeCommand"),
    openFilesystem: unsupported("openFilesystem"),
    getPlanCapabilities: unsupported("getPlanCapabilities"),
    explainPlan: unsupported("explainPlan"),
    getTableMetadata: function (req) { return request("host.getTableMetadata", req || {}); },
    queryData: function (req) { return request("host.queryData", req || {}); },
    getConnections: function () { return request("host.getConnections", {}); },
    storage: {
      get: function (key) { return request("host.storage.get", { key: key }); },
      set: function (key, value) { return request("host.storage.set", { key: key, value: value }); },
      delete: function (key) { return request("host.storage.delete", { key: key }); }
    },
    ai: {
      openConversation: unsupported("ai.openConversation"),
      listProviders: unsupported("ai.listProviders"),
      discoverModels: unsupported("ai.discoverModels"),
      listModels: unsupported("ai.listModels"),
      generateText: unsupported("ai.generateText"),
      setRecommendations: unsupported("ai.setRecommendations"),
      clearRecommendations: unsupported("ai.clearRecommendations")
    }
  };
  Object.defineProperty(window, "dbxPlugin", { value: api, configurable: false, writable: false });
  post({ kind: "hello" });
})();`;

/** 每个插件页面自带的小组件库（dbx-* 类名），颜色跟随宿主主题 */
export const PLUGIN_KIT_CSS = `
:root{--color-background:#fff;--color-foreground:#1c1c21;--color-card:#fff;--color-border:#e4e4e9;--color-input:#d2d2d9;--color-primary:#2f6fed;--color-primary-foreground:#fff;--color-muted:#f1f1f4;--color-muted-foreground:#6b6b76;--color-accent:#e8f0fe;--color-destructive:#d23f4a;--color-ring:#2f6fed}
:root[data-dbx-theme=dark]{--color-background:#181818;--color-foreground:#e6e6e6;--color-card:#1e1e1e;--color-border:#2e2e2e;--color-input:#404040;--color-primary:#5b9bff;--color-primary-foreground:#fff;--color-muted:#262626;--color-muted-foreground:#9a9aa3;--color-accent:#1d2d4a;--color-destructive:#f0707a;--color-ring:#5b9bff}
.dbx-card{border:1px solid var(--color-border);background:var(--color-card);border-radius:8px;padding:12px}
.dbx-section-title{font-size:13px;font-weight:600;margin:0 0 8px}
.dbx-btn{border:1px solid var(--color-border);background:var(--color-card);color:var(--color-foreground);border-radius:6px;padding:5px 12px;font:inherit;font-size:13px;cursor:pointer}
.dbx-btn:hover{background:var(--color-muted)}
.dbx-btn--primary{background:var(--color-primary);border-color:var(--color-primary);color:var(--color-primary-foreground)}
.dbx-btn--primary:hover{background:var(--color-primary);opacity:.9}
.dbx-btn--danger{color:var(--color-destructive);border-color:var(--color-destructive)}
.dbx-btn--ghost{border-color:transparent;background:transparent}
.dbx-label{display:block;font-size:12px;color:var(--color-muted-foreground);margin-bottom:4px}
.dbx-input,.dbx-select,.dbx-textarea{width:100%;box-sizing:border-box;border:1px solid var(--color-input);background:var(--color-background);color:var(--color-foreground);border-radius:6px;padding:5px 8px;font:inherit;font-size:13px}
.dbx-input:focus,.dbx-select:focus,.dbx-textarea:focus{outline:2px solid var(--color-ring);outline-offset:-1px}
.dbx-hint{font-size:12px;color:var(--color-muted-foreground)}
.dbx-row{display:grid;grid-template-columns:140px 1fr;gap:8px;align-items:center;margin-bottom:8px}
.dbx-table{border-collapse:collapse;width:100%;font-size:13px}
.dbx-table th,.dbx-table td{border-bottom:1px solid var(--color-border);padding:6px 8px;text-align:left}
.dbx-badge{display:inline-block;border-radius:999px;background:var(--color-muted);color:var(--color-muted-foreground);padding:1px 8px;font-size:11px}
.dbx-link{color:var(--color-primary);cursor:pointer;text-decoration:none}
`;

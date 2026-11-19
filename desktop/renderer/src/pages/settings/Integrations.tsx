import { useCallback, useEffect, useState } from "react";
import type { AppState, IntegrationKind, IntegrationStatusDTO, IntegrationUpdateDTO } from "../../../../shared/api";
import { api } from "../../api";
import { Icon } from "../../components/Icon";
import { useConfigEditor } from "../../lib/configEdit";

interface RowDef {
  kind: IntegrationKind;
  label: string;
  /** 未安装时给出的安装提示 */
  install?: string;
}

const PACKAGES: Record<IntegrationKind, string> = { lark: "@larksuite/cli", meegle: "@lark-project/meegle", dws: "dingtalk-workspace-cli" };

function useIntegrations(kinds: IntegrationKind[]) {
  const [status, setStatus] = useState<Partial<Record<IntegrationKind, IntegrationStatusDTO>>>({});
  const [updates, setUpdates] = useState<Partial<Record<IntegrationKind, IntegrationUpdateDTO>>>({});
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const key = kinds.join(",");

  const refresh = useCallback(async () => {
    setLoading(true);
    const entries = await Promise.all(kinds.map(async k => [k, await api.integrationStatus(k)] as const));
    const next: Partial<Record<IntegrationKind, IntegrationStatusDTO>> = Object.fromEntries(entries);
    setStatus(next);
    setLoading(false);
    return next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => void refresh(), [refresh]);

  const checkUpdate = async () => {
    setChecking(true);
    const entries = await Promise.all(kinds.map(async k => [k, await api.integrationCheckUpdate(k)] as const));
    setUpdates(Object.fromEntries(entries));
    setChecking(false);
  };

  // 一键安装 / 升级：npm install -g，装完自动重新检测
  const [installing, setInstalling] = useState<IntegrationKind | null>(null);
  const [installMsg, setInstallMsg] = useState<Partial<Record<IntegrationKind, { ok: boolean; text: string }>>>({});
  const install = async (k: IntegrationKind) => {
    setInstalling(k);
    setInstallMsg(m => ({ ...m, [k]: undefined }));
    const r = await api.integrationInstall(k);
    setInstalling(null);
    setInstallMsg(m => ({ ...m, [k]: r.ok ? { ok: true, text: "安装完成，已重新检测" } : { ok: false, text: `${r.error ?? "安装失败"}${r.output ? `\n${r.output}` : ""}` } }));
    if (r.ok) {
      setUpdates(u => ({ ...u, [k]: undefined }));
      await refresh();
    }
    return r.ok;
  };

  // 一键登录：后台自动在浏览器打开授权页，授权完成后自动刷新状态
  type LoginState = { running: boolean; text?: string; url?: string; userCode?: string; result?: { ok: boolean; text: string } };
  const [login, setLogin] = useState<Partial<Record<IntegrationKind, LoginState>>>({});
  useEffect(
    () =>
      api.onIntegrationLoginProgress(p => {
        setLogin(m => ({ ...m, [p.kind]: { ...(m[p.kind] ?? { running: true }), running: true, text: p.text ?? m[p.kind]?.text, url: p.url ?? m[p.kind]?.url, userCode: p.userCode ?? m[p.kind]?.userCode } }));
      }),
    [],
  );
  const doLogin = async (k: IntegrationKind) => {
    setLogin(m => ({ ...m, [k]: { running: true, text: "正在发起登录…" } }));
    const r = await api.integrationLogin(k);
    setLogin(m => ({ ...m, [k]: { running: false, result: { ok: r.ok, text: r.message } } }));
    await refresh();
  };

  // 一键安装：没装的依次安装 → 重新检测 → 没登录的依次弹授权页登录。哪一步失败，那一项的提示里会写清原因
  const [setupRunning, setSetupRunning] = useState(false);
  const setup = async () => {
    setSetupRunning(true);
    try {
      let cur = await refresh();
      for (const k of kinds) if (!cur[k]?.installed) await install(k);
      cur = await refresh();
      for (const k of kinds) if (cur[k]?.installed && !cur[k]?.authenticated) await doLogin(k);
    } finally {
      setSetupRunning(false);
    }
  };
  const needInstall = kinds.some(k => status[k] && !status[k]!.installed);
  const needLogin = kinds.some(k => status[k]?.installed && !status[k]!.authenticated);
  return { status, updates, loading, checking, refresh, checkUpdate, install, installing, installMsg, login, doLogin, setup, setupRunning, needInstall, needLogin };
}

type Integ = ReturnType<typeof useIntegrations>;

function CliRow({ def, s, u, loading, integ }: { def: RowDef; s?: IntegrationStatusDTO; u?: IntegrationUpdateDTO; loading: boolean; integ: Integ }) {
  const busy = integ.installing === def.kind;
  const msg = integ.installMsg[def.kind];
  // 行内只负责「升级」；首次安装统一走右上角的「一键安装」
  const canInstall = !!s && s.installed && !!u?.hasUpdate;
  const lg = integ.login[def.kind];
  const canLogin = !!s && s.installed && !s.authenticated;
  return (
    <div className="int-row" data-testid={`int-${def.kind}`}>
      <div className="int-main">
        <span className="int-label">{def.label}</span>
        {s?.version && <span className="chip">v{s.version}</span>}
        {s &&
          (s.installed ? (
            s.authenticated ? (
              <span className="chip ok">
                <Icon name="check" size={12} /> 已登录{s.user ? `：${s.user}` : ""}
              </span>
            ) : (
              <span className="chip bad">未登录</span>
            )
          ) : (
            <span className="chip bad">未安装</span>
          ))}
        {loading && !s && <span className="spinner" />}
        {canLogin && (
          <button className="btn sm primary" style={{ marginLeft: "auto" }} data-testid={`int-login-${def.kind}`} disabled={!!lg?.running || integ.setupRunning} onClick={() => void integ.doLogin(def.kind)}>
            {lg?.running ? (
              <>
                <span className="spinner" /> 等待授权…
              </>
            ) : (
              "登录"
            )}
          </button>
        )}
        {canInstall && (
          <button className="btn sm primary" style={{ marginLeft: canLogin ? 0 : "auto" }} data-testid={`int-install-${def.kind}`} disabled={integ.installing !== null || integ.setupRunning} onClick={() => void integ.install(def.kind)} title={`npm install -g ${PACKAGES[def.kind]}`}>
            {busy ? (
              <>
                <span className="spinner" /> {s?.installed ? "升级中…" : "安装中…"}
              </>
            ) : (
              "升级"
            )}
          </button>
        )}
      </div>
      {s && (!s.installed || !s.authenticated) && (
        <div className="int-note">
          {s.detail ?? (s.installed ? "未登录" : def.install)}
          {!s.installed && !msg ? "　→ 点右上角「一键安装」即可自动安装并登录" : ""}
        </div>
      )}
      {u && u.supported && <div className={`int-note ${u.ok ? (u.hasUpdate ? "warn" : "") : "bad"}`}>{u.message}</div>}
      {u && !u.supported && <div className="int-note">{u.message}</div>}
      {busy && <div className="int-note">正在执行 npm install -g {PACKAGES[def.kind]}，可能需要几十秒…</div>}
      {msg && (
        <div className={`int-note ${msg.ok ? "" : "bad"}`} style={{ whiteSpace: "pre-wrap" }}>
          {msg.text}
          {msg.ok && s?.installed && !s.authenticated ? "。接下来点右侧「登录」完成授权" : ""}
        </div>
      )}
      {lg?.running && (
        <div className="int-note">
          {lg.text ?? "正在登录…"}
          {lg.userCode ? `　验证码：${lg.userCode}` : ""}
          {lg.url && (
            <>
              　浏览器没打开？
              <a href={lg.url} target="_blank" rel="noreferrer">
                点此打开授权页
              </a>
              　或
              <a
                href="#"
                onClick={e => {
                  e.preventDefault();
                  void navigator.clipboard.writeText(lg.url!);
                }}
              >
                复制链接
              </a>
            </>
          )}
        </div>
      )}
      {lg?.result && !lg.running && !(s?.authenticated && !lg.result.ok) && <div className={`int-note ${lg.result.ok ? "" : "bad"}`}>{lg.result.text}</div>}
    </div>
  );
}

function Header({ title, onCheck, onRefresh, checking, loading, integ }: { title: string; onCheck: () => void; onRefresh: () => void; checking: boolean; loading: boolean; integ: Integ }) {
  const busy = integ.setupRunning;
  const label = integ.needInstall ? "一键安装" : "一键登录";
  return (
    <div className="int-head">
      <div>
        <div className="int-title">{title}</div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        {(integ.needInstall || integ.needLogin || busy) && (
          <button className="btn sm primary" data-testid="int-setup" disabled={busy} onClick={() => void integ.setup()} title="没装的依次安装 → 自动检测 → 没登录的依次打开授权页">
            {busy ? (
              <>
                <span className="spinner" /> 处理中…
              </>
            ) : (
              label
            )}
          </button>
        )}
        <button className="btn sm" onClick={onRefresh} disabled={loading} title="重新检测版本与登录状态">
          <Icon name="refresh" size={13} /> 检测
        </button>
        <button className="btn sm" data-testid="int-check-update" onClick={onCheck} disabled={checking}>
          {checking ? "检查中…" : "检查更新"}
        </button>
      </div>
    </div>
  );
}

/** 飞书集成：lark-cli（办公通道 / 文档 / 日历等）+ meegle（飞书项目）；项目页里还有默认空间 */
export function FeishuIntegration({ state, onChanged }: { state: AppState; onChanged: () => void }) {
  const kinds: IntegrationKind[] = ["lark", "meegle"];
  const integ = useIntegrations(kinds);
  const { status, updates, loading, checking, refresh, checkUpdate } = integ;
  const rows: RowDef[] = [
    { kind: "lark", label: "飞书（lark-cli）", install: "没有找到 lark-cli，请先安装并执行 lark-cli auth login" },
    { kind: "meegle", label: "飞书项目（meegle-cli）", install: "没有找到 meegle，请先安装并执行 meegle auth login" },
  ].filter(r => kinds.includes(r.kind as IntegrationKind)) as RowDef[];

  return (
    <div className="int-card" data-testid="feishu-integration">
      <Header
        title="飞书集成"
        onCheck={() => void checkUpdate()}
        onRefresh={() => void refresh()}
        checking={checking}
        loading={loading}
        integ={integ}
      />
      {rows.map(r => (
        <CliRow key={r.kind} def={r} s={status[r.kind]} u={updates[r.kind]} loading={loading} integ={integ} />
      ))}
      <DefaultSpace state={state} onChanged={onChanged} meegle={status.meegle} />
    </div>
  );
}

function DefaultSpace({ state, onChanged, meegle }: { state: AppState; onChanged: () => void; meegle?: IntegrationStatusDTO }) {
  const ed = useConfigEditor(state, onChanged);
  const fp = ed.cfg?.integrations?.feishuProject as { defaultSpace?: { key: string; name?: string } } | undefined;
  const saved = fp?.defaultSpace;
  const [spaces, setSpaces] = useState<Array<{ name: string; key: string }>>([]);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const ready = !!meegle?.installed && !!meegle?.authenticated;

  useEffect(() => {
    if (!ready) return;
    setLoading(true);
    void api.feishuSpaces().then(r => {
      setLoading(false);
      if (r.ok) setSpaces(r.spaces ?? []);
      else setErr(r.error ?? "获取空间失败");
    });
  }, [ready]);

  const change = async (key: string) => {
    setErr("");
    const sp = spaces.find(s => s.key === key);
    const r = await ed.update(c => {
      if (!c.integrations?.feishuProject) return;
      if (key && sp) c.integrations.feishuProject.defaultSpace = { key, name: sp.name };
      else delete c.integrations.feishuProject.defaultSpace;
    });
    if (!r.ok) setErr(r.error ?? "保存失败");
  };

  const enabled = !!fp;
  const options = saved && !spaces.some(s => s.key === saved.key) ? [{ key: saved.key, name: saved.name ?? saved.key }, ...spaces] : spaces;

  return (
    <div className="int-row space">
      <div>
        <div className="int-label">默认空间</div>
        <div className="muted">{!enabled ? "先在下方启用「飞书项目」" : "用户没指明空间时使用"}</div>
      </div>
      <select className="input" style={{ width: 280 }} data-testid="default-space" disabled={!enabled || !ready || loading} value={saved?.key ?? ""} onChange={e => void change(e.target.value)}>
        <option value="">{loading ? "加载空间中…" : ready ? "不设置" : "需要先登录 meegle"}</option>
        {options.map(s => (
          <option key={s.key} value={s.key}>
            {s.name}
          </option>
        ))}
      </select>
      {err && <div className="inline-warn" style={{ gridColumn: "1 / -1" }}>{err}</div>}
    </div>
  );
}

/** 钉钉集成：官方 dws CLI */
export function DingTalkIntegration() {
  const integ = useIntegrations(["dws"]);
  const { status, updates, loading, checking, refresh, checkUpdate } = integ;
  return (
    <div className="int-card" data-testid="dingtalk-integration">
      <Header title="钉钉集成" onCheck={() => void checkUpdate()} onRefresh={() => void refresh()} checking={checking} loading={loading} integ={integ} />
      <CliRow def={{ kind: "dws", label: "钉钉（dws）", install: "安装：npm install -g dingtalk-workspace-cli，然后执行 dws auth login" }} s={status.dws} u={updates.dws} loading={loading} integ={integ} />
    </div>
  );
}

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

function useIntegrations(kinds: IntegrationKind[]) {
  const [status, setStatus] = useState<Partial<Record<IntegrationKind, IntegrationStatusDTO>>>({});
  const [updates, setUpdates] = useState<Partial<Record<IntegrationKind, IntegrationUpdateDTO>>>({});
  const [loading, setLoading] = useState(false);
  const [checking, setChecking] = useState(false);
  const key = kinds.join(",");

  const refresh = useCallback(async () => {
    setLoading(true);
    const entries = await Promise.all(kinds.map(async k => [k, await api.integrationStatus(k)] as const));
    setStatus(Object.fromEntries(entries));
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(() => void refresh(), [refresh]);

  const checkUpdate = async () => {
    setChecking(true);
    const entries = await Promise.all(kinds.map(async k => [k, await api.integrationCheckUpdate(k)] as const));
    setUpdates(Object.fromEntries(entries));
    setChecking(false);
  };
  return { status, updates, loading, checking, refresh, checkUpdate };
}

function CliRow({ def, s, u, loading }: { def: RowDef; s?: IntegrationStatusDTO; u?: IntegrationUpdateDTO; loading: boolean }) {
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
      </div>
      {s && (!s.installed || !s.authenticated) && <div className="int-note">{s.detail ?? (s.installed ? "未登录" : def.install)}</div>}
      {u && u.supported && <div className={`int-note ${u.ok ? (u.hasUpdate ? "warn" : "") : "bad"}`}>{u.message}</div>}
      {u && !u.supported && <div className="int-note">{u.message}</div>}
    </div>
  );
}

function Header({ title, onCheck, onRefresh, checking, loading }: { title: string; onCheck: () => void; onRefresh: () => void; checking: boolean; loading: boolean }) {
  return (
    <div className="int-head">
      <div>
        <div className="int-title">{title}</div>
      </div>
      <div style={{ display: "flex", gap: 8 }}>
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
  const { status, updates, loading, checking, refresh, checkUpdate } = useIntegrations(kinds);
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
      />
      {rows.map(r => (
        <CliRow key={r.kind} def={r} s={status[r.kind]} u={updates[r.kind]} loading={loading} />
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
  const { status, updates, loading, checking, refresh, checkUpdate } = useIntegrations(["dws"]);
  return (
    <div className="int-card" data-testid="dingtalk-integration">
      <Header title="钉钉集成" onCheck={() => void checkUpdate()} onRefresh={() => void refresh()} checking={checking} loading={loading} />
      <CliRow def={{ kind: "dws", label: "钉钉（dws）", install: "安装：npm install -g dingtalk-workspace-cli，然后执行 dws auth login" }} s={status.dws} u={updates.dws} loading={loading} />
    </div>
  );
}

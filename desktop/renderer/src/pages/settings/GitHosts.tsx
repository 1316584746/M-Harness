import { useEffect, useRef, useState } from "react";
import type { AppState, HostProbeDTO } from "../../../../shared/api";
import { HOSTS, hostDef, hostOriginsFromUrls } from "../../../../../src/tools/git-hosts";
import { api } from "../../api";
import { Icon } from "../../components/Icon";
import { useConfigEditor } from "../../lib/configEdit";
import { Field, fmtDate, KeyInput } from "./Models";
import { Switch } from "./Projects";

/** 代码托管平台账号：下拉选平台 → 填该平台的令牌（存 .env）→ 自动校验并显示所属账号 */
export function GitHosts({ state, onChanged }: { state: AppState; onChanged: () => void }) {
  const ed = useConfigEditor(state, onChanged);
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [sel, setSel] = useState("");
  const [token, setToken] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [probe, setProbe] = useState<{ status: "idle" | "loading" | "done"; res?: HostProbeDTO }>({ status: "idle" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const seq = useRef(0);

  const def = hostDef(sel);
  const storedBase: string = ed.cfg?.gitHosts?.[sel]?.baseURL ?? "";
  const storedToken = tokens[sel] ?? "";
  const enabledOf = (id: string) => ed.cfg?.gitHosts?.[id]?.enabled !== false;
  const enabled = enabledOf(sel);
  const onList = HOSTS.filter(h => tokens[h.id] && enabledOf(h.id));
  /** 下拉里的顺序：已启用的在前，其次已停用的，最后没配置的；同类保持原来的顺序 */
  const rank = (m: Record<string, string>, id: string) => (m[id] ? (enabledOf(id) ? 0 : 1) : 2);
  const ordered = [...HOSTS].sort((a, b) => rank(tokens, a.id) - rank(tokens, b.id));
  // 已登记仓库的远端地址里能看出的自建实例地址，作为建议
  const guesses = hostOriginsFromUrls(Object.values((ed.cfg?.repos ?? {}) as Record<string, { url?: string }>).map(r => r?.url), sel).filter(g => g !== baseURL.trim().replace(/\/+$/, ""));

  const loadTokens = async () => {
    const entries = await Promise.all(HOSTS.map(async h => [h.id, await api.getSecret(h.tokenEnv)] as const));
    const m = Object.fromEntries(entries);
    setTokens(m);
    return m;
  };

  // 首次进入：读各平台令牌，默认选中第一个已启用的
  useEffect(() => {
    void loadTokens().then(m => setSel(s => s || [...HOSTS].sort((a, b) => rank(m, a.id) - rank(m, b.id))[0].id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 切换平台 / 外部值变化：草稿回到已保存的值
  useEffect(() => {
    setToken(storedToken);
    setBaseURL(storedBase);
  }, [sel, storedToken, storedBase]);
  useEffect(() => setMsg(null), [sel]);

  // 令牌或地址变化后自动校验（防抖）
  useEffect(() => {
    const t = token.trim();
    const my = ++seq.current;
    if (!sel || t.length < 8) {
      setProbe({ status: "idle" });
      return;
    }
    setProbe(p => ({ status: "loading", res: p.res }));
    const timer = setTimeout(async () => {
      const r = await api.probeGitHost({ platform: sel, baseURL: baseURL.trim(), token: t });
      if (my === seq.current) setProbe({ status: "done", res: r });
    }, 600);
    return () => clearTimeout(timer);
  }, [sel, token, baseURL]);

  const toggle = async (v: boolean) => {
    setMsg(null);
    const r = await ed.update(c => {
      c.gitHosts ??= {};
      const cur = { ...(c.gitHosts[sel] ?? {}) };
      if (v) delete cur.enabled;
      else cur.enabled = false;
      if (Object.keys(cur).length) c.gitHosts[sel] = cur;
      else delete c.gitHosts[sel];
    });
    if (!r.ok) setMsg({ ok: false, text: r.error ?? "保存失败" });
  };

  const dirty = token !== storedToken || baseURL.trim() !== storedBase;

  const save = async () => {
    if (!def) return;
    setBusy(true);
    setMsg(null);
    if (token !== storedToken) {
      const s = await api.setSecret(def.tokenEnv, token.trim());
      if (!s.ok) {
        setBusy(false);
        return setMsg({ ok: false, text: s.error ?? "保存令牌失败" });
      }
    }
    const r = await ed.update(c => {
      c.gitHosts ??= {};
      const b = baseURL.trim().replace(/\/+$/, "");
      const off = c.gitHosts[def.id]?.enabled === false;
      if (b || off) c.gitHosts[def.id] = { ...(b ? { baseURL: b } : {}), ...(off ? { enabled: false } : {}) };
      else delete c.gitHosts[def.id];
    });
    await loadTokens();
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: `已保存。克隆 / 拉取 / 推送 ${def.label} 的 https 仓库时会自动使用这个令牌` } : { ok: false, text: r.error ?? "保存失败" });
  };

  const info = probe.res;
  const u = info?.user;

  return (
    <div className="pcard" data-testid="git-hosts">
      <div className="pcard-head">
        <div className="pcard-name">托管平台账号</div>
        <span className="muted">令牌保存在 <code>.env</code></span>
        <span className="spacer" />
        {def && storedToken && (
          <label className="host-switch" title={enabled ? "启用中：拉取 / 推送 / 克隆这个平台的 https 仓库会用这个令牌" : "已停用：不会再用这个令牌"}>
            {enabled ? "启用" : "停用"}
            <Switch on={enabled} onChange={v => void toggle(v)} testid="host-enabled" />
          </label>
        )}
      </div>

      <Field label="选择平台">
        <select className="input" data-testid="host-select" value={sel} onChange={e => setSel(e.target.value)}>
          {ordered.map(h => (
            <option key={h.id} value={h.id}>
              {h.label}
              {tokens[h.id] ? (enabledOf(h.id) ? "（已启用）" : "（已停用）") : "（未配置）"}
            </option>
          ))}
        </select>
      </Field>

      {def && storedToken && !enabled && <div className="inline-warn" data-testid="host-off">已停用：克隆 / 拉取 / 推送 {def.label} 的 https 仓库时不会再带这个令牌（令牌还留着，打开右上角开关即可恢复）。</div>}
      {onList.length > 1 && <div className="field-hint" data-testid="host-many">现在有 {onList.length} 个平台处于启用状态（{onList.map(h => h.label).join("、")}），按仓库的远端地址决定用哪个令牌；用不到的可以先停用。</div>}

      {def && (
        <>
          <Field label={def.tokenLabel} hint={def.tokenHint}>
            <KeyInput value={token} onChange={v => (setToken(v), setMsg(null))} placeholder={`粘贴 ${def.label} 令牌`} />
            {probe.status !== "idle" && (
              <div className={`keyinfo${probe.status === "loading" && !info?.ok ? " loading" : info && !info.ok ? " bad" : ""}`} data-testid="host-info">
                <Icon name={probe.status === "loading" && !info?.ok ? "refresh" : info && !info.ok ? "alert" : "user"} size={15} />
                <div>
                  {probe.status === "loading" && !info?.ok && "正在验证令牌…"}
                  {probe.status === "done" && info && !info.ok && (info.error ?? "验证失败")}
                  {info?.ok && u && (
                    <>
                      {(u.name || u.username || u.email) && (
                        <div>
                          {(u.name || u.username) && <span className="ki-name">{u.name || u.username}</span>}
                          <span className="ki-sub">{[u.name ? u.username && `@${u.username}` : undefined, u.email].filter(Boolean).join("  ")}</span>
                        </div>
                      )}
                      {u.createdAt && <div>账号创建于 {fmtDate(u.createdAt)}</div>}
                      {u.note && <div className="ki-sub">{u.note}</div>}
                    </>
                  )}
                </div>
              </div>
            )}
          </Field>

          {def.selfHosted && (
            <Field label="实例地址" hint={`自建或企业版才需要填写，留空使用 ${def.defaultBase}`}>
              <input className="input mono" value={baseURL} placeholder={def.defaultBase} onChange={e => (setBaseURL(e.target.value), setMsg(null))} data-testid="host-base" />
              {guesses.length > 0 && (
                <div className="field-hint" data-testid="host-guess">
                  已登记的仓库用的是：
                  {guesses.map(g => (
                    <button key={g} type="button" className="act-link" onClick={() => (setBaseURL(g), setMsg(null))}>
                      {g}
                    </button>
                  ))}
                  点一下填入
                </div>
              )}
            </Field>
          )}

          {msg && <div className={msg.ok ? "inline-ok" : "inline-warn"}>{msg.text}</div>}
          <div className="pcard-actions">
            <button className="btn primary sm" data-testid="host-save" disabled={!dirty || busy} onClick={save}>
              保存
            </button>
            {dirty && (
              <button className="btn sm" onClick={() => (setToken(storedToken), setBaseURL(storedBase), setMsg(null))}>
                还原
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}

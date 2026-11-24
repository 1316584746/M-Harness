import { useCallback, useEffect, useState } from "react";
import { KIND_LABEL, type ResourceItem } from "../../../shared/plugins";
import { api } from "../api";
import { fmtStars } from "../lib/stars";
import { Icon } from "./Icon";

type Kind = ResourceItem["kind"];

/** 同步 / 导入 / 加载面板添加了内容后发这个事件，让各处知道配置变了 */
export const RESOURCES_CHANGED = "harness-resources-changed";

const HIDDEN_KEY = "harness-hidden-recommend";
function readHidden(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(HIDDEN_KEY) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}
function writeHidden(keys: string[]) {
  try {
    localStorage.setItem(HIDDEN_KEY, JSON.stringify(keys));
  } catch {
    /* 存不了就只在本次有效 */
  }
}

/**
 * 技能 / MCP / 规则 / 动作页里的「推荐」：去 GitHub 按星标排行取这一类最高的 6 个仓库（不是写死的）。
 * 每一项是一个仓库；点「添加」会先看它里面具体有哪些，只有一项就直接加，多项就列出来让你勾选。
 * 从链接导入、从本机文件夹加载、从其他平台同步，见 ResourceTools（页面顶部的三个按钮）。
 */
export function ResourceDiscover({ kind, onAdded }: { kind: Kind; onAdded: () => void }) {
  const label = KIND_LABEL[kind];
  const [rec, setRec] = useState<ResourceItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadErr, setLoadErr] = useState("");
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<Set<string>>(new Set());
  /** 正在挑选的仓库：里面扫出来的内容 */
  const [pick, setPick] = useState<{ key: string; items: ResourceItem[]; sel: Set<string>; adding: boolean } | null>(null);

  const load = useCallback(
    (refresh: boolean) => {
      setLoading(true);
      setLoadErr("");
      void api
        .resourceRecommended(kind, refresh)
        .then(r => {
          setRec(r.items);
          setLoadErr(r.error ?? "");
        })
        .catch((e: unknown) => setLoadErr(e instanceof Error ? e.message : String(e)))
        .finally(() => setLoading(false));
    },
    [kind],
  );
  useEffect(() => load(false), [load]);

  // 不想要的推荐可以删掉（其实是「不再推荐」：榜单是 GitHub 的，删不掉本体，只是不再显示）；存在本机，可以恢复
  const [hidden, setHidden] = useState<string[]>(readHidden);
  const hide = (key: string) => {
    const next = [...new Set([...hidden, key])];
    setHidden(next);
    writeHidden(next);
    if (pick?.key === key) setPick(null);
  };
  const restore = () => {
    const mine = new Set(rec.map(i => i.key));
    const next = hidden.filter(k => !mine.has(k));
    setHidden(next);
    writeHidden(next);
  };
  const hiddenHere = rec.filter(i => hidden.includes(i.key)).length;
  const todo = rec.filter(i => !hidden.includes(i.key));

  const addKeys = async (items: ResourceItem[]) => {
    let ok = 0;
    const bad: string[] = [];
    const extra: string[] = [];
    const done = new Set<string>();
    for (const i of items) {
      const r = await api.resourceAdd(i.key);
      if (r.ok) {
        ok++;
        done.add(i.key);
        if (r.error) extra.push(`「${i.name}」${r.error}`);
      } else bad.push(`「${i.name}」：${r.error ?? "未知错误"}`);
    }
    if (ok) setMsg(`已添加 ${ok} 项${extra.length ? `。${extra.join("；")}` : ""}`);
    if (bad.length) setErr(`有 ${bad.length} 项没添加成功：\n${bad.join("\n")}`);
    if (ok) {
      onAdded();
      window.dispatchEvent(new Event(RESOURCES_CHANGED));
    }
    return done;
  };

  const add = async (i: ResourceItem) => {
    setErr("");
    setMsg("");
    setBusy(b => new Set([...b, i.key]));
    const r = await api.resourceScan(i.name, kind).catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }) as Awaited<ReturnType<typeof api.resourceScan>>);
    if (!r.ok) {
      setBusy(b => new Set([...b].filter(k => k !== i.key)));
      return setErr(`「${i.name}」：${r.error ?? "读取失败"}`);
    }
    const found = (r.items ?? []).filter(x => x.kind === kind);
    const fresh = found.filter(x => !x.added);
    if (!found.length) {
      setBusy(b => new Set([...b].filter(k => k !== i.key)));
      return setErr(`「${i.name}」里没有找到可添加的${label}。可以点「主页」去看看它怎么用。`);
    }
    if (!fresh.length) {
      setBusy(b => new Set([...b].filter(k => k !== i.key)));
      return setMsg(`「${i.name}」里的${label}（${found.length} 项）都已经添加过了`);
    }
    if (found.length === 1) {
      await addKeys(fresh);
      setBusy(b => new Set([...b].filter(k => k !== i.key)));
      return;
    }
    setBusy(b => new Set([...b].filter(k => k !== i.key)));
    setPick({ key: i.key, items: found, sel: new Set(fresh.map(x => x.key)), adding: false });
  };

  const addPicked = async () => {
    if (!pick) return;
    const list = pick.items.filter(x => !x.added && pick.sel.has(x.key));
    if (!list.length) return;
    setErr("");
    setMsg("");
    setPick({ ...pick, adding: true });
    const done = await addKeys(list);
    setPick(p => (p ? { ...p, adding: false, sel: new Set(), items: p.items.map(x => (done.has(x.key) ? { ...x, added: true } : x)) } : p));
  };

  return (
    <div className="card-section" data-testid="res-discover">
      <div className="shead">
        <h3 style={{ margin: 0 }}>推荐{label}</h3>
        <span className="muted" style={{ margin: "0 0 0 8px" }}>
          GitHub 星标榜前 6
        </span>
        <span className="spacer" />
        {hiddenHere > 0 && (
          <button className="btn sm" data-testid="res-restore" onClick={restore} title="把删掉的推荐重新显示出来">
            恢复已删除的（{hiddenHere}）
          </button>
        )}
        <button className="btn sm" data-testid="res-refresh" disabled={loading} onClick={() => load(true)} title="重新去 GitHub 拉最新的榜单">
          {loading ? <span className="spinner" /> : <Icon name="refresh" size={13} />} 刷新
        </button>
      </div>

      {loading && rec.length === 0 ? (
        <div className="muted" data-testid="res-loading">
          <span className="spinner" /> 正在从 GitHub 取排行（第一次要核实每个仓库里有没有能添加的内容，可能要十几秒）…
        </div>
      ) : todo.length === 0 ? (
        <div className="muted">{loadErr && rec.length === 0 ? "" : hiddenHere > 0 ? "推荐的都已经删除了" : "暂时没有推荐"}</div>
      ) : (
        <div className="sgroup">
          {todo.map(i => (
            <div key={i.key}>
              <div className="srow" data-testid="res-row" data-key={i.key}>
                <div className="srow-text">
                  <div className="srow-title">
                    {i.name}
                    {typeof i.stars === "number" && (
                      <span className="tag" title={`${i.stars} 颗星`}>
                        ★ {fmtStars(i.stars)}
                      </span>
                    )}
                  </div>
                  <div className="srow-desc">{i.description}</div>
                </div>
                <div className="srow-ctl">
                  {i.homepage && (
                    <a className="btn sm" href={i.homepage} target="_blank" rel="noreferrer" title="在浏览器里打开这个仓库">
                      主页
                    </a>
                  )}
                  <button className="btn sm" data-testid="res-add" disabled={busy.has(i.key)} onClick={() => void add(i)}>
                    {busy.has(i.key) ? <span className="spinner" /> : <Icon name="plus" size={13} />} 添加
                  </button>
                  <button className="btn sm danger" data-testid="res-hide" title="删除这条推荐（以后不再显示，可以在右上角恢复）" disabled={busy.has(i.key)} onClick={() => hide(i.key)}>
                    删除
                  </button>
                </div>
              </div>
              {pick?.key === i.key && (
                <div className="res-pick" data-testid="res-pick-list" style={{ padding: "6px 12px 10px 24px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                    <span className="muted">这个仓库里有 {pick.items.length} 项{label}，勾选要添加的：</span>
                    <span className="spacer" style={{ flex: 1 }} />
                    <button className="btn sm primary" data-testid="res-pick-add" disabled={pick.adding || !pick.sel.size} onClick={() => void addPicked()}>
                      {pick.adding ? <span className="spinner" /> : <Icon name="plus" size={13} />} 添加所选{pick.sel.size ? `（${pick.sel.size}）` : ""}
                    </button>
                    <button className="btn sm" onClick={() => setPick(null)}>
                      收起
                    </button>
                  </div>
                  {pick.items.map(x => (
                    <label key={x.key} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "3px 0", cursor: x.added ? "default" : "pointer" }}>
                      <input
                        type="checkbox"
                        style={{ marginTop: 3 }}
                        disabled={x.added || pick.adding}
                        checked={x.added || pick.sel.has(x.key)}
                        onChange={() => setPick(p => (p ? { ...p, sel: p.sel.has(x.key) ? new Set([...p.sel].filter(k => k !== x.key)) : new Set([...p.sel, x.key]) } : p))}
                      />
                      <span>
                        <b>{x.name}</b>
                        {x.added && <span className="muted"> · 已添加</span>}
                        <span className="muted" style={{ display: "block" }}>
                          {x.description}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {loadErr && (
        <div className="inline-warn" style={{ marginTop: 8 }} data-testid="res-load-err">
          {rec.length ? `没能刷新到最新榜单，先显示上次的：${loadErr}` : `取排行失败：${loadErr}`}
        </div>
      )}
      {err && (
        <div className="inline-warn" style={{ marginTop: 8, whiteSpace: "pre-wrap" }} data-testid="res-err">
          {err}
        </div>
      )}
      {msg && (
        <div className="muted" style={{ marginTop: 8 }} data-testid="res-msg">
          {msg}
        </div>
      )}
    </div>
  );
}

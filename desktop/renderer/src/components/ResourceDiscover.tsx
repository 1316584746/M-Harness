import { useCallback, useEffect, useState } from "react";
import { KIND_LABEL, type ResourceItem } from "../../../shared/plugins";
import { api } from "../api";
import { Icon } from "./Icon";

type Kind = ResourceItem["kind"];

/** 同步 / 导入 / 加载面板添加了内容后发这个事件，推荐列表跟着刷新「已添加」 */
export const RESOURCES_CHANGED = "harness-resources-changed";

/**
 * 技能 / MCP / 规则 / 动作页里的「推荐」。
 * 这些不是插件，所以不放进插件中心：软件自带一些常用的推荐，一键添加。
 * 从链接导入、从本机文件夹加载、从其他平台同步，见 ResourceTools（页面顶部的三个按钮）。
 */
export function ResourceDiscover({ kind, onAdded }: { kind: Kind; onAdded: () => void }) {
  const label = KIND_LABEL[kind];
  const [rec, setRec] = useState<ResourceItem[]>([]);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<Set<string>>(new Set());

  const loadRec = useCallback(() => void api.resourceRecommended(kind).then(setRec).catch(() => {}), [kind]);
  useEffect(loadRec, [loadRec]);
  useEffect(() => {
    window.addEventListener(RESOURCES_CHANGED, loadRec);
    return () => window.removeEventListener(RESOURCES_CHANGED, loadRec);
  }, [loadRec]);

  const add = async (i: ResourceItem) => {
    setErr("");
    setMsg("");
    setBusy(b => new Set([...b, i.key]));
    const r = await api.resourceAdd(i.key);
    setBusy(b => new Set([...b].filter(k => k !== i.key)));
    if (!r.ok) return setErr(`添加「${i.name}」失败：${r.error ?? "未知错误"}`);
    setMsg(`已添加「${i.name}」${r.error ? `。${r.error}` : ""}`);
    setRec(list => list.map(x => (x.key === i.key ? { ...x, added: true } : x)));
    onAdded();
  };

  const todo = rec.filter(i => !i.added);
  return (
    <div className="card-section" data-testid="res-discover">
      <div className="shead">
        <h3 style={{ margin: 0 }}>推荐{label}</h3>
      </div>
      {todo.length === 0 ? (
        <div className="muted">推荐的都已经添加了</div>
      ) : (
        <div className="sgroup">
          {todo.map(i => (
            <div className="srow" key={i.key} data-testid="res-row" data-key={i.key}>
              <div className="srow-text">
                <div className="srow-title">
                  {i.name}
                  {i.note && <span className="tag">{i.note}</span>}
                </div>
                <div className="srow-desc">{i.description}</div>
              </div>
              <div className="srow-ctl">
                <button className="btn sm" data-testid="res-add" disabled={busy.has(i.key)} onClick={() => void add(i)}>
                  {busy.has(i.key) ? <span className="spinner" /> : <Icon name="plus" size={13} />} 添加
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {err && (
        <div className="inline-warn" style={{ marginTop: 8 }} data-testid="res-err">
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

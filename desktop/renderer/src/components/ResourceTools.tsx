import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { KIND_LABEL, type PlatformInfo, type ResourceItem, type ResourceScan } from "../../../shared/plugins";
import { api } from "../api";
import { Icon } from "./Icon";
import { RESOURCES_CHANGED } from "./ResourceDiscover";

type Kind = ResourceItem["kind"];
type Mode = "sync" | "link" | "local";

/** 扫描结果里属于当前这一页的内容，和「还有别的类型」的提示 */
function split(r: ResourceScan, kind: Kind): { items: ResourceItem[]; others: string; notes: string[] } {
  const all = r.items ?? [];
  const rest = new Map<string, number>();
  for (const i of all) if (i.kind !== kind) rest.set(KIND_LABEL[i.kind], (rest.get(KIND_LABEL[i.kind]) ?? 0) + 1);
  return { items: all.filter(i => i.kind === kind), others: [...rest].map(([k, n]) => `${n} 个${k}`).join("、"), notes: r.skipped ?? [] };
}

/**
 * 技能 / MCP / 规则 / 动作页顶部的三个按钮：
 *   同步 —— 从用户在「设置 → 模型」里添加过账号的平台（Cursor / Claude Code / Codex）在本机已有的内容里挑
 *   导入 —— 粘贴链接（GitHub 仓库、技能所在文件夹的链接，或资源文件直链）
 *   加载 —— 选本机的一个文件夹，软件在里面找这一类内容
 * 三个都是「列出来，勾选，添加所选」。返回按钮和展开的面板，由页面放到合适的位置。
 */
export function useResourceTools(kind: Kind, onAdded: () => void): { buttons: ReactNode; panel: ReactNode } {
  const [mode, setMode] = useState<Mode | null>(null);
  const btn = (m: Mode, icon: "refresh" | "link" | "folder", text: string, tip: string) => (
    <button className={`btn${mode === m ? " active" : ""}`} data-testid={`res-btn-${m}`} title={tip} aria-pressed={mode === m} onClick={() => setMode(cur => (cur === m ? null : m))}>
      <Icon name={icon} size={14} /> {text}
    </button>
  );
  return {
    buttons: (
      <>
        {btn("sync", "refresh", "同步", `从你添加过账号的 Cursor / Claude Code / Codex 在本机已有的内容里挑着同步${KIND_LABEL[kind]}`)}
        {btn("link", "link", "导入", `粘贴链接导入${KIND_LABEL[kind]}（GitHub 仓库或文件夹的链接）`)}
        {btn("local", "folder", "加载", `选本机的一个文件夹，从里面加载${KIND_LABEL[kind]}`)}
      </>
    ),
    panel: mode && <ResourcePanel key={mode} kind={kind} mode={mode} onClose={() => setMode(null)} onAdded={onAdded} />,
  };
}

function ResourcePanel({ kind, mode, onClose, onAdded }: { kind: Kind; mode: Mode; onClose: () => void; onAdded: () => void }) {
  const label = KIND_LABEL[kind];
  const [items, setItems] = useState<ResourceItem[] | null>(null);
  const [others, setOthers] = useState("");
  const [notes, setNotes] = useState<string[]>([]);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [scanning, setScanning] = useState(false);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState("");
  const [msg, setMsg] = useState("");
  // 导入：链接
  const [url, setUrl] = useState("");
  // 加载：选的文件夹
  const [dir, setDir] = useState("");
  // 同步：平台
  const [plats, setPlats] = useState<PlatformInfo[] | null>(null);
  const [plat, setPlat] = useState("");
  const [showAll, setShowAll] = useState(false);
  const cache = useRef(new Map<string, ResourceScan>());

  const show = useCallback(
    (r: ResourceScan) => {
      if (!r.ok) {
        setItems(null);
        setErr(r.error ?? "读取失败");
        return;
      }
      const s = split(r, kind);
      setItems(s.items);
      setOthers(s.others);
      setNotes(s.notes);
      setSel(new Set());
    },
    [kind],
  );

  const run = async (fn: () => Promise<ResourceScan>) => {
    setErr("");
    setMsg("");
    setItems(null);
    setScanning(true);
    const r = await fn().catch((e: unknown) => ({ ok: false, error: e instanceof Error ? e.message : String(e) }) as ResourceScan);
    setScanning(false);
    show(r);
    return r;
  };

  // 导入：查找
  const scanUrl = () => void run(() => api.resourceScan(url));

  // 加载：选文件夹并扫描
  const pick = useCallback(async () => {
    const p = await api.pickFolder(`选择要加载${label}的文件夹`);
    if (!p) return;
    setDir(p);
    await run(() => api.resourceScanLocal(p));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [label]);
  useEffect(() => {
    if (mode === "local") void pick();
  }, [mode, pick]);

  // 同步：平台列表，默认看第一个添加过账号的
  const scanPlat = (id: string) => {
    setPlat(id);
    const hit = cache.current.get(id);
    if (hit) return void (setErr(""), setMsg(""), show(hit));
    void run(() => api.resourceSyncScan(id)).then(r => r.ok && cache.current.set(id, r));
  };
  useEffect(() => {
    if (mode !== "sync") return;
    void api.resourceSyncPlatforms().then(list => {
      setPlats(list);
      const first = list.find(p => p.configured && p.found) ?? list.find(p => p.configured);
      if (first) scanPlat(first.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode]);

  const todo = (items ?? []).filter(i => !i.added);
  const toggle = (k: string) => setSel(s => (s.has(k) ? new Set([...s].filter(x => x !== k)) : new Set([...s, k])));

  const addSelected = async () => {
    const list = todo.filter(i => sel.has(i.key));
    if (!list.length) return;
    setAdding(true);
    setErr("");
    setMsg("");
    let ok = 0;
    const bad: string[] = [];
    const extra: string[] = [];
    const added = new Set<string>();
    for (const i of list) {
      const r = await api.resourceAdd(i.key);
      if (r.ok) {
        ok++;
        added.add(i.key);
        if (r.error) extra.push(`「${i.name}」${r.error}`);
      } else bad.push(`「${i.name}」：${r.error ?? "未知错误"}`);
    }
    setAdding(false);
    const mark = (l: ResourceItem[] | null) => (l ? l.map(x => (added.has(x.key) ? { ...x, added: true } : x)) : l);
    setItems(mark);
    // 平台缓存里的也要标上「已添加」
    for (const [k, v] of cache.current) cache.current.set(k, { ...v, items: mark(v.items ?? []) ?? [] });
    setSel(new Set());
    if (ok) setMsg(`已添加 ${ok} 项${extra.length ? `。${extra.join("；")}` : ""}`);
    if (bad.length) setErr(`有 ${bad.length} 项没添加成功：\n${bad.join("\n")}`);
    if (ok) {
      onAdded();
      window.dispatchEvent(new Event(RESOURCES_CHANGED));
    }
  };

  const visiblePlats = (plats ?? []).filter(p => showAll || p.configured);
  const hidden = (plats ?? []).filter(p => !p.configured).length;
  const platInfo = plats?.find(p => p.id === plat);

  return (
    <div className="card-section res-panel" data-testid={`res-panel-${mode}`}>
      <div className="shead">
        <h3 style={{ margin: 0 }}>{mode === "sync" ? `同步${label}` : mode === "link" ? `导入${label}` : `加载${label}`}</h3>
        <span className="spacer" />
        <button className="icon-btn sm" title="收起" onClick={onClose}>
          <Icon name="x" size={14} />
        </button>
      </div>

      {mode === "link" && (
        <>
          <div className="muted" style={{ marginBottom: 8 }}>
            粘贴链接（GitHub 仓库、仓库里某个文件夹的链接，或 owner/repo），软件会找出里面的{label}，你勾选要的添加。
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input className="input" style={{ flex: 1 }} data-testid="res-url" autoFocus placeholder="例如：anthropics/skills 或 https://github.com/owner/repo/tree/main/skills/xxx" value={url} onChange={e => setUrl(e.target.value)} onKeyDown={e => e.key === "Enter" && url.trim() && scanUrl()} />
            <button className="btn" data-testid="res-scan" disabled={scanning || !url.trim()} onClick={scanUrl}>
              {scanning ? <span className="spinner" /> : <Icon name="search" size={14} />} 查找
            </button>
          </div>
        </>
      )}

      {mode === "local" && (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          <div className="muted" style={{ flex: 1, wordBreak: "break-all" }} data-testid="res-dir">
            {dir ? <code>{dir}</code> : `选一个文件夹，软件在里面找${label}（也认 .cursor、.claude、.codex 这些工具的用户目录）`}
          </div>
          <button className="btn" data-testid="res-pick" disabled={scanning} onClick={() => void pick()}>
            {scanning ? <span className="spinner" /> : <Icon name="folder" size={14} />} {dir ? "重新选择" : "选择文件夹"}
          </button>
        </div>
      )}

      {mode === "sync" && (
        <>
          <div className="muted" style={{ marginBottom: 8 }}>
            显示你在「设置 → 模型」里添加过账号的平台（Cursor、Claude Code、Codex）在本机已经有的{label}，勾选要同步过来的。
          </div>
          {plats === null ? (
            <div className="muted">
              <span className="spinner" /> 正在检查…
            </div>
          ) : visiblePlats.length === 0 ? (
            <div className="muted" data-testid="res-no-plat">
              你还没有在「设置 → 模型」里添加 Cursor、Claude Code 或 Codex 的账号，没有可同步的平台。
            </div>
          ) : (
            <div className="chips" style={{ marginBottom: 4 }}>
              {visiblePlats.map(p => (
                <button key={p.id} className={`btn sm${plat === p.id ? " primary" : ""}`} data-testid={`res-plat-${p.id}`} disabled={scanning} onClick={() => scanPlat(p.id)}>
                  {p.name}
                  {!p.configured && <span className="tag" style={{ marginLeft: 6 }}>未添加账号</span>}
                  {!p.found && <span className="tag" style={{ marginLeft: 6 }}>本机没找到</span>}
                </button>
              ))}
            </div>
          )}
          {plats !== null && hidden > 0 && (
            <button className="link" data-testid="res-plat-all" onClick={() => setShowAll(v => !v)}>
              {showAll ? "只看添加过账号的" : `还有 ${hidden} 个平台没添加账号，也看看`}
            </button>
          )}
          {platInfo && !platInfo.found && !scanning && <div className="muted" style={{ marginTop: 8 }}>本机没有找到 {platInfo.name} 的用户目录，可能还没用过它。</div>}
        </>
      )}

      {scanning && (
        <div className="muted" style={{ marginTop: 8 }}>
          <span className="spinner" /> 正在读取…
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

      {items && (
        <div style={{ marginTop: 10 }} data-testid="res-found">
          {items.length === 0 ? (
            <div className="muted">
              没找到{label}
              {others ? `（有 ${others}，到对应的设置页去加载）` : ""}
            </div>
          ) : (
            <>
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <label style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                  <input type="checkbox" data-testid="res-all" disabled={!todo.length || adding} checked={todo.length > 0 && todo.every(i => sel.has(i.key))} onChange={e => setSel(e.target.checked ? new Set(todo.map(i => i.key)) : new Set())} />
                  <span className="muted">
                    共 {items.length} 项{todo.length < items.length ? `，${items.length - todo.length} 项已添加` : ""}
                  </span>
                </label>
                <span className="spacer" style={{ flex: 1 }} />
                <button className="btn sm primary" data-testid="res-add-sel" disabled={!sel.size || adding} onClick={() => void addSelected()}>
                  {adding ? <span className="spinner" /> : <Icon name="plus" size={13} />} 添加所选{sel.size ? `（${sel.size}）` : ""}
                </button>
              </div>
              <div className="sgroup">
                {items.map(i => (
                  <div className="srow" key={i.key} data-testid="res-row" data-key={i.key}>
                    <label style={{ display: "flex", alignItems: "flex-start", gap: 10, flex: 1, minWidth: 0, cursor: i.added ? "default" : "pointer" }}>
                      <input type="checkbox" style={{ marginTop: 3 }} data-testid="res-check" disabled={i.added || adding} checked={i.added || sel.has(i.key)} onChange={() => toggle(i.key)} />
                      <div className="srow-text">
                        <div className="srow-title">
                          {i.name}
                          {i.note && <span className="tag">{i.note}</span>}
                          {i.added && (
                            <span className="muted" data-testid="res-added" style={{ marginLeft: 8, fontWeight: 400 }}>
                              已添加
                            </span>
                          )}
                        </div>
                        <div className="srow-desc">{i.description}</div>
                      </div>
                    </label>
                  </div>
                ))}
              </div>
            </>
          )}
          {others && items.length > 0 && <div className="muted" style={{ marginTop: 8 }}>这里还有 {others}，到对应的设置页去加载。</div>}
          {notes.length > 0 && (
            <div className="muted" style={{ marginTop: 8 }} data-testid="res-notes">
              {notes.slice(0, 5).join("；")}
              {notes.length > 5 ? `……等 ${notes.length} 条提示` : ""}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

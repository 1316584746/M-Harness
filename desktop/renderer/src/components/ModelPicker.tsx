import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyProbeDTO, ProviderInfo } from "../../../shared/api";
import { api } from "../api";
import { Icon } from "./Icon";

const cache = new Map<string, { at: number; res: KeyProbeDTO }>();
const TTL = 60_000;

/** 取模型列表并记进渲染进程缓存；联网失败但已有旧列表时保留旧的 */
async function load(provider: string, refresh: boolean): Promise<KeyProbeDTO> {
  const r = await api.providerModels(provider, { refresh });
  if (r.ok) cache.set(provider, { at: r.cached ? (r.at ?? Date.now()) : Date.now(), res: r });
  return r;
}

/** 对话框里的模型选择：只对当前对话生效，不改全局配置；列表用该提供方已保存的 Key 实时获取 */
export function ModelPicker({ provider, info, value, onChange, disabled }: { provider: string; info?: ProviderInfo; value?: string; onChange: (m: string | undefined) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [res, setRes] = useState<KeyProbeDTO | null>(null);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const current = value ?? info?.model;

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  // 挂载 / 换 provider 时就在后台取：先拿缓存（几乎瞬时），再让后端按需联网更新，打开下拉时通常已经有列表
  useEffect(() => {
    if (!info?.model) return;
    let alive = true;
    const mem = cache.get(provider);
    setRes(mem?.res ?? null);
    void api.providerModels(provider, { cacheOnly: true }).then(r => {
      if (alive && r.ok && !cache.has(provider)) setRes(r);
    });
    void load(provider, false).then(r => alive && setRes(r));
    return () => {
      alive = false;
    };
  }, [provider, info?.model]);

  // 打开时：有列表就立刻显示；列表超过 1 分钟再静默刷新一次
  useEffect(() => {
    if (!open) return;
    setQ("");
    const hit = cache.get(provider);
    if (hit && Date.now() - hit.at < TTL) return;
    let alive = true;
    if (!hit) setLoading(true);
    void load(provider, !!hit).then(r => {
      if (!alive) return;
      if (r.ok || !hit) setRes(r);
      setLoading(false);
    });
    return () => {
      alive = false;
      setLoading(false);
    };
  }, [open, provider]);

  const labels = res?.labels ?? {};
  const models = useMemo(() => (res?.models ?? []).filter(m => !q || m.toLowerCase().includes(q.toLowerCase()) || (labels[m] ?? "").toLowerCase().includes(q.toLowerCase())), [res, q, labels]);

  if (!info?.model) return null; // cli 没有「模型」这个概念

  return (
    <div className="picker" ref={box}>
      <button type="button" className={`chipbtn ${open ? "on" : ""}`} data-testid="model-trigger" disabled={disabled} onClick={() => setOpen(!open)} title={value ? `本对话使用 ${value}（全局默认 ${info.model}）` : "使用全局默认模型"}>
        <span>{labels[current ?? ""] ?? current}</span>
        <Icon name="down" size={13} />
      </button>
      {open && (
        <div className="menu" role="listbox" data-testid="model-menu">
          <div className="menu-title">选择模型（只对当前对话生效）</div>
          <input className="input menu-search" placeholder="搜索模型" value={q} onChange={e => setQ(e.target.value)} autoFocus />
          <button
            type="button"
            className={`menu-item ${!value ? "sel" : ""}`}
            data-testid="model-default"
            onClick={() => {
              onChange(undefined);
              setOpen(false);
            }}
          >
            <span className="menu-main">
              <span className="menu-name">默认 · {info.model}</span>
              <span className="menu-desc">跟随设置里的全局配置</span>
            </span>
            {!value && <Icon name="check" size={15} />}
          </button>
          {loading && <div className="menu-empty">正在获取模型列表…</div>}
          {res && !res.ok && <div className="menu-empty bad">{res.error ?? "获取模型列表失败"}（仍可使用默认模型）</div>}
          {models.map(m => (
            <button
              key={m}
              type="button"
              role="option"
              aria-selected={m === value}
              data-testid={`model-${m}`}
              className={`menu-item ${m === value ? "sel" : ""}`}
              onClick={() => {
                onChange(m === info.model ? undefined : m);
                setOpen(false);
              }}
            >
              <span className="menu-main">
                <span className="menu-name">{labels[m] ?? m}</span>
                {labels[m] && <span className="menu-desc">{m}</span>}
              </span>
              {m === (value ?? info.model) && <Icon name="check" size={15} />}
            </button>
          ))}
          {res?.ok && !models.length && <div className="menu-empty">没有匹配的模型</div>}
        </div>
      )}
    </div>
  );
}

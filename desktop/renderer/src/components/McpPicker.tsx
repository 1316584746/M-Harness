import { useEffect, useRef, useState } from "react";
import type { McpServerDTO, ToolInfo } from "../../../shared/api";
import { api } from "../api";
import { Icon } from "./Icon";

const RISK: Record<string, string> = { read: "只读", write: "写入", exec: "执行", network: "联网" };

/** 和 src/mcp/manager.ts 里一致：提供给模型的 MCP 工具名是 mcp__<服务>__<工具> */
const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
const prefixOf = (server: string) => `mcp__${safe(server)}__`;

const STATE_TEXT: Record<McpServerDTO["state"], string> = {
  disabled: "已停用",
  idle: "未连接",
  connecting: "连接中…",
  ready: "已连接",
  error: "连接失败",
};

/**
 * 对话框里的「MCP n/m」：按 MCP 服务分组，本对话里可以整个服务关掉，或只关其中某几个工具。
 * 内置工具（读写文件、执行命令等）不在这里管理，它们始终可用并受审批约束。
 * 开关写入的是本对话的 disabledTools（工具名），不会改全局配置。
 */
export function McpPicker({ disabled: off, onChange, busy }: { disabled: string[]; onChange: (names: string[]) => void; busy?: boolean }) {
  const [servers, setServers] = useState<McpServerDTO[]>([]);
  const [tools, setTools] = useState<ToolInfo[]>([]);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const box = useRef<HTMLDivElement>(null);

  const load = () => Promise.all([api.mcpStatus(), api.listTools()]).then(([s, t]) => (setServers(s), setTools(t)));
  useEffect(() => void load(), []);

  const pending = servers.some(s => s.state === "idle" || s.state === "connecting");
  // 对话页切到设置时只是被隐藏、不会卸载：在设置里增删 / 启停 MCP 服务后，回到对话页要自动刷新；还有服务在连接时持续轮询
  const wasVisible = useRef(true);
  useEffect(() => {
    const t = setInterval(() => {
      const visible = !!box.current && box.current.offsetParent !== null;
      if (visible && (!wasVisible.current || pending)) void load();
      wasVisible.current = visible;
    }, 1000);
    return () => clearInterval(t);
  }, [pending]);
  useEffect(() => {
    if (!open) return;
    void load();
    const close = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);
  const offSet = new Set(off);
  const groups = servers.map(s => ({ s, list: tools.filter(t => t.name.startsWith(prefixOf(s.name))) }));
  const all = groups.flatMap(g => g.list);
  const enabled = all.filter(t => !offSet.has(t.name)).length;

  const setNames = (names: string[], on: boolean) => {
    const next = new Set(off);
    for (const n of names) (on ? next.delete(n) : next.add(n));
    onChange([...next]);
  };

  return (
    <div className="picker" ref={box}>
      <button type="button" className={`chipbtn ${open ? "on" : ""}`} data-testid="mcp-picker" disabled={busy} onClick={() => setOpen(!open)} title="本对话里模型可以使用的 MCP 服务和工具">
        <Icon name="plug" size={14} />
        <span>MCP</span>
        <span className="count" data-testid="mcp-picker-count">
          {enabled}/{all.length}
        </span>
        <Icon name="down" size={13} />
      </button>
      {open && (
        <div className="menu wide" data-testid="mcp-picker-menu">
          <div className="menu-title" style={{ display: "flex", justifyContent: "space-between" }}>
            <span>本对话可用的 MCP</span>
            {all.length > 0 && (
              <span>
                <a className="link" data-testid="mcp-picker-all-on" onClick={() => setNames(all.map(t => t.name), true)}>
                  全部开启
                </a>
                {" · "}
                <a className="link" data-testid="mcp-picker-all-off" onClick={() => setNames(all.map(t => t.name), false)}>
                  全部关闭
                </a>
              </span>
            )}
          </div>
          {groups.length === 0 && (
            <div className="menu-empty" data-testid="mcp-picker-empty">
              还没有配置 MCP 服务。到「设置 → MCP」添加后，这里就能按服务开关。
            </div>
          )}
          {groups.map(({ s, list }) => {
            const names = list.map(t => t.name);
            const on = list.filter(t => !offSet.has(t.name)).length;
            const usable = s.state === "ready" && list.length > 0;
            const isOpen = !!expanded[s.name];
            return (
              <div key={s.name} data-testid={`mcp-picker-group-${s.name}`}>
                <label className="menu-item check" style={usable ? undefined : { opacity: 0.7 }}>
                  <input type="checkbox" data-testid={`mcp-picker-server-${s.name}`} disabled={!usable} checked={usable && on > 0} ref={el => void (el && (el.indeterminate = usable && on > 0 && on < list.length))} onChange={() => setNames(names, on === 0)} />
                  <span className="menu-main">
                    <span className="menu-name">
                      <span className={`dot ${s.state === "ready" ? "ok" : s.state === "error" ? "bad" : ""}`} style={{ marginRight: 6 }} />
                      {s.name}
                      <span className="tag">{s.transport}</span>
                    </span>
                    <span className="menu-desc">
                      {s.state === "error" ? s.error ?? STATE_TEXT.error : s.state === "ready" ? (list.length ? `${on}/${list.length} 个工具已开启` : "没有可用的工具（可能都在设置里关闭了）") : s.state === "disabled" ? "已停用，到「设置 → MCP」启用" : STATE_TEXT[s.state]}
                    </span>
                  </span>
                  {list.length > 0 && (
                    <a
                      className="link"
                      data-testid={`mcp-picker-expand-${s.name}`}
                      onClick={e => {
                        e.preventDefault();
                        setExpanded(m => ({ ...m, [s.name]: !isOpen }));
                      }}
                    >
                      工具 <Icon name={isOpen ? "down" : "right"} size={12} />
                    </a>
                  )}
                </label>
                {isOpen &&
                  list.map(t => (
                    <label key={t.name} className="menu-item check" style={{ paddingLeft: 34 }} data-testid={`mcp-picker-tool-${t.name}`}>
                      <input type="checkbox" checked={!offSet.has(t.name)} onChange={() => setNames([t.name], offSet.has(t.name))} />
                      <span className="menu-main">
                        <span className="menu-name">
                          {t.name.slice(prefixOf(s.name).length)}
                          <span className={`tag risk-${t.risk}`}>{RISK[t.risk] ?? t.risk}</span>
                        </span>
                        <span className="menu-desc">{t.desc.replace(/^\[MCP · [^\]]*\]\s*/, "")}</span>
                      </span>
                    </label>
                  ))}
              </div>
            );
          })}
          <div className="menu-empty" style={{ fontSize: 12 }}>
            内置工具（读写文件、执行命令等）始终可用，写入 / 执行仍需你审批。
          </div>
        </div>
      )}
    </div>
  );
}

import { useCallback, useEffect, useRef, useState } from "react";
import type { AppState, McpServerDTO } from "../../../../shared/api";
import { api } from "../../api";
import { Icon } from "../../components/Icon";
import { ResourceDiscover } from "../../components/ResourceDiscover";
import { useResourceTools } from "../../components/ResourceTools";
import { Req, useRequired } from "../../components/Required";
import { useConfigEditor } from "../../lib/configEdit";
import { Switch } from "./Projects";

const RISK: Record<string, string> = { read: "只读", write: "写入", exec: "执行", network: "联网" };

/** 命令行拆成参数：支持双引号 / 单引号包住含空格的参数 */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(line); m; m = re.exec(line)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

const joinArgs = (args: string[]) => args.map(a => (/\s/.test(a) ? `"${a}"` : a)).join(" ");

/** 每行 KEY=VALUE（或 KEY: VALUE）转成对象 */
function parsePairs(text: string, sep: RegExp): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const m = sep.exec(line);
    if (m && m.index > 0) out[line.slice(0, m.index).trim()] = line.slice(m.index + m[0].length).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

const pairsText = (o: Record<string, string> | undefined, sep: string) => Object.entries(o ?? {}).map(([k, v]) => `${k}${sep}${v}`).join("\n");

/** 只保留认识的字段（导入 Cursor 的 mcp.json 时，可能带有别的字段） */
function cleanServer(raw: any): Record<string, any> | null {
  if (!raw || typeof raw !== "object") return null;
  const out: Record<string, any> = {};
  if (typeof raw.command === "string" && raw.command) {
    out.command = raw.command;
    if (Array.isArray(raw.args)) out.args = raw.args.map(String);
    if (raw.env && typeof raw.env === "object") out.env = raw.env;
    if (typeof raw.cwd === "string") out.cwd = raw.cwd;
  } else if (typeof raw.url === "string" && raw.url) {
    out.url = raw.url;
    if (raw.headers && typeof raw.headers === "object") out.headers = raw.headers;
  } else return null;
  if (raw.disabled === true || raw.enabled === false) out.enabled = false;
  return out;
}

function McpForm({ initial, existing, onSubmit, onCancel }: { initial?: { name: string; cfg: Record<string, any> }; existing: string[]; onSubmit: (name: string, cfg: Record<string, any>) => Promise<string | null>; onCancel: () => void }) {
  const c = initial?.cfg ?? {};
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<"stdio" | "http">(c.url ? "http" : "stdio");
  const [command, setCommand] = useState(c.command ? joinArgs([c.command, ...(c.args ?? [])]) : "");
  const [env, setEnv] = useState(pairsText(c.env, "="));
  const [url, setUrl] = useState(c.url ?? "");
  const [headers, setHeaders] = useState(pairsText(c.headers, ": "));
  const [err, setErr] = useState("");
  const req = useRequired();

  const submit = async () => {
    const n = name.trim();
    const miss = req.check([
      ...(initial ? [] : [{ key: "name", label: "名称", ok: !!n }]),
      ...(kind === "stdio" ? [{ key: "command", label: "命令", ok: !!command.trim() }] : [{ key: "url", label: "地址", ok: !!url.trim() }]),
    ]);
    if (miss) return setErr(miss);
    if (!/^[\w.-]+$/.test(n)) return setErr("名称只能包含字母、数字、下划线、点和短横线");
    if (!initial && existing.includes(n)) return setErr("已有同名服务");
    const next: Record<string, any> = { ...c };
    for (const k of ["command", "args", "env", "cwd", "url", "headers"]) delete next[k];
    if (kind === "stdio") {
      const parts = splitArgs(command);
      if (!parts.length) return setErr("请填写启动命令");
      next.command = parts[0];
      next.args = parts.slice(1);
      const e = parsePairs(env, /=/);
      if (e) next.env = e;
    } else {
      try {
        new URL(url);
      } catch {
        return setErr("请填写有效的地址，例如 https://example.com/mcp");
      }
      next.url = url.trim();
      const h = parsePairs(headers, /:/);
      if (h) next.headers = h;
    }
    const e = await onSubmit(n, next);
    if (e) setErr(e);
  };

  return (
    <div className="pcard add" data-testid="mcp-form">
      <div className="field">
        <div className="field-label">
          名称
          <Req />
        </div>
        <input className={req.cls("name", "input mono")} data-req="name" data-testid="mcp-name" value={name} disabled={!!initial} placeholder="github" onChange={e => (setName(e.target.value), req.clear("name"), setErr(""))} />
      </div>
      <div className="field">
        <div className="field-label">类型</div>
        <select className="input" data-testid="mcp-kind" value={kind} onChange={e => setKind(e.target.value as "stdio" | "http")}>
          <option value="stdio">本地命令（stdio）</option>
          <option value="http">远程地址（HTTP）</option>
        </select>
      </div>
      {kind === "stdio" ? (
        <>
          <div className="field">
            <div className="field-label">
              命令
              <Req />
            </div>
            <input className={req.cls("command", "input mono")} data-req="command" data-testid="mcp-command" value={command} placeholder="npx -y @modelcontextprotocol/server-filesystem D:/work" onChange={e => (setCommand(e.target.value), req.clear("command"), setErr(""))} />
          </div>
          <div className="field">
            <div className="field-label">环境变量（每行 KEY=VALUE，可写 {"${NAME}"} 引用 .env）</div>
            <textarea className="input mono" rows={2} data-testid="mcp-env" value={env} onChange={e => setEnv(e.target.value)} />
          </div>
        </>
      ) : (
        <>
          <div className="field">
            <div className="field-label">
              地址
              <Req />
            </div>
            <input className={req.cls("url", "input mono")} data-req="url" data-testid="mcp-url" value={url} placeholder="https://example.com/mcp" onChange={e => (setUrl(e.target.value), req.clear("url"), setErr(""))} />
          </div>
          <div className="field">
            <div className="field-label">请求头（每行 Name: Value）</div>
            <textarea className="input mono" rows={2} data-testid="mcp-headers" value={headers} placeholder="Authorization: Bearer ${TOKEN}" onChange={e => setHeaders(e.target.value)} />
          </div>
        </>
      )}
      {err && <div className="inline-warn">{err}</div>}
      <div className="pcard-actions">
        <button className="btn primary" data-testid="mcp-save" onClick={() => void submit()}>
          保存
        </button>
        <button className="btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

function ImportBox({ existing, onImport, onCancel }: { existing: string[]; onImport: (servers: Record<string, any>) => Promise<string | null>; onCancel: () => void }) {
  const [text, setText] = useState("");
  const [err, setErr] = useState("");
  const req = useRequired();
  const go = async () => {
    const miss = req.check([{ key: "text", label: "mcp.json 内容", ok: !!text.trim() }]);
    if (miss) return setErr(miss);
    let v: any;
    try {
      v = JSON.parse(text);
    } catch {
      return setErr("不是有效的 JSON");
    }
    const map = v?.mcpServers ?? v;
    const out: Record<string, any> = {};
    for (const [k, raw] of Object.entries<any>(map ?? {})) {
      const s = cleanServer(raw);
      if (s && /^[\w.-]+$/.test(k)) out[k] = s;
    }
    if (!Object.keys(out).length) return setErr("没有找到可用的服务（需要 mcpServers，且每项有 command 或 url）");
    const dup = Object.keys(out).filter(k => existing.includes(k));
    if (dup.length) return setErr(`已有同名服务：${dup.join("、")}`);
    const e = await onImport(out);
    if (e) setErr(e);
  };
  return (
    <div className="pcard add" data-testid="mcp-import">
      <div className="field">
        <div className="field-label">
          粘贴 mcp.json（Cursor / Claude 的格式都可以）
          <Req />
        </div>
        <textarea className={req.cls("text", "input mono")} data-req="text" rows={8} data-testid="mcp-import-text" value={text} placeholder={'{ "mcpServers": { "name": { "command": "npx", "args": ["-y", "..."] } } }'} onChange={e => (setText(e.target.value), req.clear("text"), setErr(""))} />
      </div>
      {err && <div className="inline-warn">{err}</div>}
      <div className="pcard-actions">
        <button className="btn primary" data-testid="mcp-import-go" onClick={() => void go()}>
          导入
        </button>
        <button className="btn" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  );
}

function StateChip({ s }: { s: McpServerDTO }) {
  if (s.state === "disabled") return <span className="chip">已停用</span>;
  if (s.state === "idle" || s.state === "connecting")
    return (
      <span className="chip">
        <span className="spinner" style={{ width: 10, height: 10 }} /> 连接中
      </span>
    );
  if (s.state === "error")
    return (
      <span className="chip bad">
        <span className="dot bad" /> 连接失败
      </span>
    );
  return (
    <span className="chip ok">
      <span className="dot ok" /> 已连接 · {s.tools.length} 个工具
    </span>
  );
}

export function Mcp({ state, onChanged }: { state: AppState; onChanged: () => void }) {
  const ed = useConfigEditor(state, onChanged);
  const servers: Record<string, Record<string, any>> = ed.cfg?.mcpServers ?? {};
  const [status, setStatus] = useState<McpServerDTO[]>([]);
  const [mode, setMode] = useState<null | "import" | { edit?: string }>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [err, setErr] = useState("");
  const timer = useRef<number>(0);
  const tools = useResourceTools("mcp", onChanged);

  const refresh = useCallback(() => void api.mcpStatus().then(setStatus), []);
  useEffect(refresh, [refresh, state.configText]);
  // 有服务还在连接时轮询
  useEffect(() => {
    if (!status.some(s => s.state === "idle" || s.state === "connecting")) return;
    timer.current = window.setTimeout(refresh, 1200);
    return () => window.clearTimeout(timer.current);
  }, [status, refresh]);

  const run = async (fn: (m: Record<string, any>) => void): Promise<string | null> => {
    setErr("");
    const r = await ed.update(c => {
      c.mcpServers ??= {};
      fn(c.mcpServers);
    });
    if (!r.ok) {
      setErr(r.error ?? "保存失败");
      return r.error ?? "保存失败";
    }
    return null;
  };

  const names = Object.keys(servers);
  const byName = new Map(status.map(s => [s.name, s]));

  return (
    <>
    <div className="card-section">
      <div className="shead">
        <h2>MCP 服务</h2>
        <span className="spacer" />
        {tools.buttons}
        <button className="btn" data-testid="mcp-import-btn" onClick={() => setMode("import")}>
          导入 JSON
        </button>
        <button className="btn" data-testid="mcp-add" onClick={() => setMode({})}>
          <Icon name="plus" size={14} /> 新增
        </button>
      </div>
      {tools.panel}
      {err && <div className="inline-warn">{err}</div>}

      {mode === "import" && (
        <ImportBox
          existing={names}
          onCancel={() => setMode(null)}
          onImport={async add => {
            const e = await run(m => void Object.assign(m, add));
            if (!e) setMode(null);
            return e;
          }}
        />
      )}
      {mode && mode !== "import" && (
        <McpForm
          initial={mode.edit ? { name: mode.edit, cfg: servers[mode.edit] } : undefined}
          existing={names}
          onCancel={() => setMode(null)}
          onSubmit={async (n, cfg) => {
            const e = await run(m => void (m[n] = cfg));
            if (!e) setMode(null);
            return e;
          }}
        />
      )}

      {!names.length && !mode && <div className="muted">暂无</div>}
      {names.map(n => {
        const cfg = servers[n];
        const st = byName.get(n);
        const enabled = cfg.enabled !== false;
        const disabledTools: string[] = cfg.disabledTools ?? [];
        return (
          <div className="pcard" key={n} data-testid={`mcp-${n}`}>
            <div className="pcard-head">
              <span className="pcard-name">{n}</span>
              <span className="tag">{cfg.url ? "远程" : "本地"}</span>
              {st && <StateChip s={st} />}
              <span className="spacer" />
              <Switch on={enabled} testid="mcp-switch" onChange={v => void run(m => void (m[n].enabled = v))} />
            </div>
            <div className="muted mono-line">{st?.target ?? (cfg.url || [cfg.command, ...(cfg.args ?? [])].join(" "))}</div>
            {st?.state === "error" && (
              <div className="inline-warn" data-testid="mcp-error" style={{ whiteSpace: "pre-wrap" }}>
                {st.error}
              </div>
            )}
            <div className="pcard-actions">
              {enabled && (
                <button className="btn sm" data-testid="mcp-reconnect" onClick={() => void api.mcpReconnect(n).then(setStatus)}>
                  <Icon name="refresh" size={13} /> 重连
                </button>
              )}
              <button className="btn sm" data-testid="mcp-edit" onClick={() => setMode({ edit: n })}>
                编辑
              </button>
              <button className="btn sm" data-testid="mcp-delete" onClick={() => void run(m => void delete m[n])}>
                删除
              </button>
              {st?.state === "ready" && (
                <button className="btn sm" data-testid="mcp-tools-toggle" onClick={() => setOpen(open === n ? null : n)}>
                  工具 <Icon name={open === n ? "down" : "right"} size={12} />
                </button>
              )}
              <span className="spacer" />
              <span className="muted" style={{ margin: 0 }}>
                调用
              </span>
              <select className="input sm" data-testid="mcp-permission" value={cfg.permission ?? "confirm"} onChange={e => {
                  const v = e.target.value; // 先取值：保存是异步的，等会儿再读 e.target 会拿到被界面还原的旧值
                  void run(m => void (m[n].permission = v));
                }}>
                <option value="confirm">每次确认</option>
                <option value="auto">直接执行</option>
              </select>
            </div>
            {open === n && st && (
              <div className="sgroup" data-testid="mcp-tools">
                {st.tools.map(t => (
                  <div className="srow" key={t.name}>
                    <div className="srow-text">
                      <div className="srow-title">
                        <code>{t.name}</code>
                        <span className={`tag risk-${t.risk}`}>{RISK[t.risk] ?? t.risk}</span>
                      </div>
                      {t.desc && <div className="srow-desc">{t.desc}</div>}
                    </div>
                    <div className="srow-ctl">
                      <Switch
                        on={!disabledTools.includes(t.name)}
                        testid={`mcp-tool-${t.name}`}
                        onChange={v => void run(m => void (m[n].disabledTools = v ? disabledTools.filter(x => x !== t.name) : [...disabledTools, t.name]))}
                      />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
    <ResourceDiscover kind="mcp" onAdded={onChanged} />
    </>
  );
}

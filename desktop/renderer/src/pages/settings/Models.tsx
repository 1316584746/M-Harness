import { useEffect, useMemo, useRef, useState } from "react";
import type { AppState, KeyProbeDTO } from "../../../../shared/api";
import { api } from "../../api";
import { Icon } from "../../components/Icon";
import { Req, useRequired } from "../../components/Required";
import { SearchSelect } from "../../components/SearchSelect";
import { envVarFor, useConfigEditor, type Cfg } from "../../lib/configEdit";
import { normalizeEndpoint } from "../../../../shared/endpoint";

const TYPE_LABEL: Record<string, string> = {
  "openai-compat": "OpenAI 兼容",
  anthropic: "Anthropic",
  "cursor-sdk": "Cursor SDK",
  cli: "命令行 Agent",
};
const PRESETS = ["codex", "cursor-cli", "claude-code"];
const HAS_KEY = new Set(["openai-compat", "anthropic", "cursor-sdk"]);
interface Draft {
  apiKey: string;
  baseURL: string;
  model: string;
  preset: string;
  command: string;
}

export function Field({ label, hint, required, children }: { label: string; hint?: React.ReactNode; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="field">
      <div className="field-label">
        {label}
        {required && <Req />}
      </div>
      {hint && <div className="field-hint">{hint}</div>}
      {children}
    </div>
  );
}

export function KeyInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder?: string }) {
  const [show, setShow] = useState(false);
  return (
    <div className="inputrow">
      <input className="input mono" type={show ? "text" : "password"} value={value} placeholder={placeholder ?? "粘贴 API Key"} autoComplete="off" spellCheck={false} onChange={e => onChange(e.target.value)} />
      <button className="btn icon" type="button" onClick={() => setShow(!show)} title={show ? "隐藏" : "显示"}>
        <Icon name={show ? "eyeOff" : "eye"} size={16} />
      </button>
    </div>
  );
}

interface ProbeState {
  status: "idle" | "loading" | "ok" | "bad";
  res?: KeyProbeDTO;
}

/** Key（和 Base URL）一变化就自动校验，并拉取模型列表与账号信息（防抖 0.6 秒，旧请求结果会被丢弃） */
function useKeyProbe(type: string, baseURL: string, apiKey: string) {
  const [st, setSt] = useState<ProbeState>({ status: "idle" });
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const delay = useRef(600);
  useEffect(() => {
    const key = apiKey.trim();
    const url = baseURL.trim();
    const ready = HAS_KEY.has(type) && key.length >= 8 && (type !== "openai-compat" || /^https?:\/\//i.test(url));
    const my = ++seq.current;
    if (!ready) {
      setSt({ status: "idle" });
      return;
    }
    setSt(s => ({ status: "loading", res: s.res }));
    const wait = delay.current;
    delay.current = 600;
    const t = setTimeout(async () => {
      const r = await api.listModels({ type, baseURL: url, apiKey: key });
      if (my === seq.current) setSt({ status: r.ok ? "ok" : "bad", res: r });
    }, wait);
    return () => clearTimeout(t);
  }, [type, baseURL, apiKey, tick]);
  return {
    ...st,
    models: st.res?.models ?? [],
    labels: st.res?.labels ?? {},
    refresh: () => {
      delay.current = 0;
      setTick(n => n + 1);
    },
  };
}

export function fmtDate(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Key 下方的账号信息框：姓名 / 邮箱 / 密钥名 / 创建日期，或校验状态 */
function KeyInfo({ probe }: { probe: ReturnType<typeof useKeyProbe> }) {
  if (probe.status === "idle") return null;
  if (probe.status === "loading" && !probe.res?.ok)
    return (
      <div className="keyinfo loading" data-testid="key-info">
        <Icon name="refresh" size={15} />
        <div>正在验证 Key 并加载模型…</div>
      </div>
    );
  if (probe.status === "bad" || !probe.res?.ok)
    return (
      <div className="keyinfo bad" data-testid="key-info">
        <Icon name="alert" size={15} />
        <div>{probe.res?.error ?? "验证失败"}</div>
      </div>
    );
  const u = probe.res.user ?? {};
  return (
    <div className="keyinfo" data-testid="key-info">
      <Icon name="user" size={15} />
      <div>
        {(u.name || u.email) && (
          <div>
            {u.name && <span className="ki-name">{u.name}</span>}
            {u.email && <span className="ki-sub">{u.email}</span>}
          </div>
        )}
        {(u.keyName || u.createdAt) && (
          <div>
            {u.keyName && <>密钥「{u.keyName}」</>}
            {u.keyName && u.createdAt && "· "}
            {u.createdAt && <>创建于 {fmtDate(u.createdAt)}</>}
          </div>
        )}
        {u.note && <div className="ki-sub">{u.note}</div>}
        <div className="ki-sub">已加载 {probe.models.length} 个可用模型</div>
      </div>
    </div>
  );
}

/** 默认模型：拿到列表后是下拉框；没有列表时退回手填 */
function ModelPicker({
  value,
  onChange,
  probe,
  placeholder,
  listId,
  reqKey,
  invalid,
}: {
  value: string;
  onChange: (v: string) => void;
  probe: ReturnType<typeof useKeyProbe>;
  placeholder?: string;
  listId: string;
  reqKey?: string;
  invalid?: boolean;
}) {
  const { models, labels } = probe;
  const options = useMemo(
    () => [...(value && !models.includes(value) ? [{ value, label: value, hint: "当前，不在列表中" }] : []), ...models.map(m => ({ value: m, label: labels[m] ?? m, hint: labels[m] ? m : undefined }))],
    [models, labels, value],
  );
  return (
    <div className="inputrow">
      {models.length > 0 ? (
        <SearchSelect mono allowCustom value={value} onChange={onChange} options={options} placeholder="请选择模型" searchPlaceholder="搜索模型名称或 id" invalid={invalid} reqKey={reqKey} testid={`model-pick-${listId}`} />
      ) : (
        <input className={invalid ? "input mono invalid" : "input mono"} data-req={reqKey} value={value} placeholder={placeholder ?? "模型名称"} onChange={e => onChange(e.target.value)} />
      )}
      <button className="btn" type="button" onClick={probe.refresh} disabled={probe.status === "loading" || probe.status === "idle"} title="重新验证并获取模型列表">
        <Icon name="refresh" size={14} /> 刷新
      </button>
    </div>
  );
}

/** 内置提供方（默认配置里自带的）；其余都算自定义 */
export const BUILTIN = new Set(["deepseek", "openai", "claude", "codex", "cursor"]);

export function ProviderCard({
  name,
  conf,
  info,
  cfgSetters,
  isDefault,
  onRemoved,
}: {
  name: string;
  conf: Cfg;
  info?: AppState["providers"][number];
  cfgSetters: ReturnType<typeof useConfigEditor> & { onChanged: () => void };
  isDefault: boolean;
  onRemoved: () => void;
}) {
  const type: string = conf.type;
  const envVar = envVarFor(name, conf.apiKey);
  const initial: Draft = { apiKey: "", baseURL: conf.baseURL ?? "", model: conf.model ?? "", preset: conf.preset ?? "", command: conf.command ?? "" };
  const [orig, setOrig] = useState<Draft>(initial);
  const [d, setD] = useState<Draft>(initial);
  const probe = useKeyProbe(type, d.baseURL, d.apiKey);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // 读出已保存的 Key（来自 .env）
  useEffect(() => {
    if (!HAS_KEY.has(type)) return;
    const literal = typeof conf.apiKey === "string" && conf.apiKey && !/^\$\{/.test(conf.apiKey) ? conf.apiKey : null;
    if (literal !== null) {
      // 配置里直接写了明文 Key：原样显示；改动并保存后会迁移到 .env
      setOrig(o => ({ ...o, apiKey: literal }));
      setD(x => ({ ...x, apiKey: literal }));
      return;
    }
    void api.getSecret(envVar).then(v => {
      setOrig(o => ({ ...o, apiKey: v }));
      setD(x => ({ ...x, apiKey: v }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [type, envVar, conf.apiKey]);

  // 外部配置变化（如在「配置文件」里手改）时同步
  const sig = JSON.stringify([conf.baseURL, conf.model, conf.preset, conf.command]);
  useEffect(() => {
    setOrig(o => ({ ...o, baseURL: conf.baseURL ?? "", model: conf.model ?? "", preset: conf.preset ?? "", command: conf.command ?? "" }));
    setD(x => ({ ...x, baseURL: conf.baseURL ?? "", model: conf.model ?? "", preset: conf.preset ?? "", command: conf.command ?? "" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  const dirty = (Object.keys(d) as Array<keyof Draft>).some(k => d[k] !== orig[k]);
  const set = (k: keyof Draft, v: string) => {
    setD({ ...d, [k]: v });
    setMsg(null);
    req.clear(k);
  };

  const req = useRequired();
  const modelRequired = type === "openai-compat" || type === "anthropic";
  // 类型和地址对不上（选了 OpenAI 兼容却填了 …/anthropic）：运行时按地址判断协议，这里显示真实协议，保存时一并纠正
  const real = type === "openai-compat" || type === "anthropic" ? normalizeEndpoint(type, d.baseURL) : { type, baseURL: d.baseURL, notes: [] as string[] };
  const [testing, setTesting] = useState(false);
  const test = async () => {
    setTesting(true);
    setMsg(null);
    const r = await api.testModel({ type, baseURL: d.baseURL, apiKey: d.apiKey, model: d.model });
    setTesting(false);
    setMsg(r.ok ? { ok: true, text: `测试调用成功（${r.ms} ms）${r.notes?.length ? "；" + r.notes.join("；") : ""}` } : { ok: false, text: `测试调用没通过：${r.error}` });
  };
  const save = async () => {
    const miss = req.check([
      ...(type === "openai-compat" ? [{ key: "baseURL", label: "Base URL", ok: !!d.baseURL.trim() }] : []),
      ...(modelRequired ? [{ key: "model", label: "默认模型", ok: !!d.model.trim() }] : []),
      ...(type === "cli" && !d.preset ? [{ key: "command", label: "命令", ok: !!d.command.trim() }] : []),
    ]);
    if (miss) return setMsg({ ok: false, text: miss });
    setBusy(true);
    const keyChanged = HAS_KEY.has(type) && d.apiKey !== orig.apiKey;
    if (keyChanged) {
      const s = await api.setSecret(envVar, d.apiKey);
      if (!s.ok) {
        setBusy(false);
        return setMsg({ ok: false, text: s.error ?? "保存 Key 失败" });
      }
    }
    const r = await cfgSetters.update(c => {
      c.defaultProvider = name; // 保存即设为全局使用的 Agent
      const p = c.providers[name];
      if (keyChanged) p.apiKey = "${" + envVar + "}";
      if (type === "openai-compat" || type === "anthropic") {
        const n = normalizeEndpoint(type, d.baseURL);
        p.type = n.type;
        if (n.baseURL) p.baseURL = n.baseURL;
        else if (n.type === "anthropic") delete p.baseURL;
      }
      if (type !== "cli") {
        if (d.model) p.model = d.model;
        else if (type === "cursor-sdk") delete p.model;
      }
      if (type === "cli") {
        if (d.preset) p.preset = d.preset;
        else delete p.preset;
        if (d.command) p.command = d.command;
        else delete p.command;
      }
    });
    setBusy(false);
    if (r.ok) {
      setOrig(d);
      setMsg({ ok: true, text: "已保存，并设为全局使用的 Agent（新对话默认使用它）" });
    } else setMsg({ ok: false, text: r.error ?? "保存失败" });
  };

  const remove = async () => {
    if (!confirm(`删除提供方「${name}」？（.env 里的 Key 不会被删除）`)) return;
    const r = await cfgSetters.update(c => {
      delete c.providers[name];
      if (c.defaultProvider === name) c.defaultProvider = Object.keys(c.providers)[0] ?? "";
    });
    if (!r.ok) setMsg({ ok: false, text: r.error ?? "删除失败" });
    else onRemoved();
  };

  return (
    <div className="pcard" data-testid={`provider-card-${name}`}>
      <div className="pcard-head">
        <div className="pcard-name">{name}</div>
        <span className="tag">{TYPE_LABEL[real.type] ?? TYPE_LABEL[type] ?? type}</span>
        {info?.problem ? <span className="chip bad">{info.problem}</span> : <span className="chip ok">可用</span>}
        {isDefault && <span className="chip run">全局使用中</span>}
        <span className="spacer" />
        {!BUILTIN.has(name) && (
          <button className="icon-btn sm" onClick={remove} title="删除该提供方">
            <Icon name="trash" size={14} />
          </button>
        )}
      </div>

      {HAS_KEY.has(type) && (
        <Field label="API Key" hint={<>保存在 <code>.env</code>（{envVar}）</>}>
          <KeyInput value={d.apiKey} onChange={v => set("apiKey", v)} />
          <KeyInfo probe={probe} />
        </Field>
      )}

      {(type === "openai-compat" || type === "anthropic") && (
        <Field label="Base URL" required={type === "openai-compat"} hint={type === "anthropic" ? "留空使用官方地址" : "例如 https://api.deepseek.com"}>
          <input className={req.cls("baseURL", "input mono")} data-req="baseURL" value={d.baseURL} placeholder={type === "anthropic" ? "https://api.anthropic.com" : "https://…"} onChange={e => set("baseURL", e.target.value)} />
        </Field>
      )}

      {type !== "cli" && (
        <Field label="默认模型" required={modelRequired}>
          <ModelPicker value={d.model} onChange={v => set("model", v)} probe={probe} placeholder={type === "cursor-sdk" ? "composer-2" : "模型名称"} listId={name} reqKey="model" invalid={req.bad.includes("model")} />
        </Field>
      )}

      {type === "cli" && (
        <>
          <Field label="预设">
            <select className="input" value={d.preset} onChange={e => set("preset", e.target.value)}>
              <option value="">自定义命令</option>
              {PRESETS.map(p => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </Field>
          <Field label="命令" required={!d.preset} hint="留空使用预设命令">
            <input className={req.cls("command", "input mono")} data-req="command" value={d.command} placeholder="codex" onChange={e => set("command", e.target.value)} />
          </Field>
        </>
      )}

      {real.notes.length > 0 && !msg && <div className="field-hint">{real.notes.join("；")}（保存时会一并纠正）</div>}
      {msg && <div className={msg.ok ? "inline-ok" : "inline-warn"}>{msg.text}</div>}
      <div className="pcard-actions">
        {HAS_KEY.has(type) && type !== "cursor-sdk" && (
          <button className="btn sm" data-testid={`provider-test-${name}`} disabled={testing || busy || !d.apiKey || !d.model} onClick={test} title="真发一次很小的对话请求，验证地址、Key、模型名都对得上">
            {testing ? "测试中…" : "测试调用"}
          </button>
        )}
        <button className="btn primary sm" data-testid={`provider-save-${name}`} disabled={(!dirty && isDefault) || busy} onClick={save}>
          {isDefault ? "保存" : "保存并设为全局使用"}
        </button>
        {dirty && (
          <button className="btn sm" onClick={() => (setD(orig), setMsg(null))}>
            还原
          </button>
        )}
      </div>
    </div>
  );
}

export function AddProvider({
  names,
  update,
  onDone,
  onAdded,
}: {
  names: string[];
  update: ReturnType<typeof useConfigEditor>["update"];
  onDone: () => void;
  onAdded: (name: string) => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState("openai-compat");
  const [baseURL, setBaseURL] = useState("");
  const [model, setModel] = useState("");
  const [key, setKey] = useState("");
  const [err, setErr] = useState("");
  /** 测试调用没通过：给出原因，再点一次「仍然添加」才会保存 */
  const [force, setForce] = useState(false);
  const [testing, setTesting] = useState(false);
  const [note, setNote] = useState("");
  const probe = useKeyProbe(type, baseURL, key);
  const req = useRequired();
  // Key / 模型 / 类型一改，上一次的测试结论作废
  useEffect(() => setForce(false), [key, model, type]);

  /** 地址一填就按地址判断协议：…/anthropic 结尾的是 Anthropic 兼容地址，类型自动切过去 */
  const onBase = (v: string) => {
    setBaseURL(v);
    req.clear("baseURL");
    setErr("");
    setForce(false);
    if (type === "cli") return;
    const n = normalizeEndpoint(type, v);
    if (n.type !== type) {
      setType(n.type);
      setNote(n.notes.join("；"));
    } else setNote("");
  };

  const add = async () => {
    const miss = req.check([
      { key: "name", label: "名称", ok: !!name.trim() },
      ...(type === "openai-compat" ? [{ key: "baseURL", label: "Base URL", ok: !!baseURL.trim() }] : []),
      ...(type !== "cli" ? [{ key: "model", label: "默认模型", ok: !!model.trim() }] : []),
    ]);
    if (miss) return setErr(miss);
    if (!/^[\p{L}\p{N}_.-]+$/u.test(name)) return setErr("名称只能包含文字、数字、下划线、点和短横线（不能有空格）");
    if (names.includes(name)) return setErr("已存在同名提供方");
    if (type !== "cli" && !model) return setErr("请填写默认模型");
    if (type === "openai-compat" && !baseURL) return setErr("请填写 Base URL");
    // 按地址纠正类型、去掉粘贴时多带的接口路径
    const ep = type === "cli" ? null : normalizeEndpoint(type, baseURL);
    const realType = ep ? ep.type : type;
    const realBase = ep ? ep.baseURL : baseURL;
    if (type !== "cli" && key.trim() && !force) {
      setTesting(true);
      setErr("");
      const t = await api.testModel({ type: realType, baseURL: realBase, apiKey: key.trim(), model });
      setTesting(false);
      if (!t.ok) {
        setForce(true);
        return setErr(`测试调用没通过：${t.error}。改好后再点「添加」；确定没问题也可以点「仍然添加」。`);
      }
    }
    const envVar = envVarFor(name, "");
    if (HAS_KEY.has(type) && key) {
      const s = await api.setSecret(envVar, key);
      if (!s.ok) return setErr(s.error ?? "保存 Key 失败");
    }
    const r = await update(c => {
      c.providers ??= {};
      if (type === "cli") c.providers[name] = { type, preset: "codex", timeoutSec: 900 };
      else if (realType === "anthropic") c.providers[name] = { type: "anthropic", apiKey: "${" + envVar + "}", model, ...(realBase ? { baseURL: realBase } : {}) };
      else c.providers[name] = { type: realType, apiKey: "${" + envVar + "}", baseURL: realBase, model };
    });
    if (!r.ok) return setErr(r.error ?? "添加失败");
    onAdded(name);
  };

  return (
    <div className="pcard add">
      <div className="pcard-head">
        <div className="pcard-name">新增自定义提供方</div>
      </div>
      <div className="grid2">
        <Field label="名称" required>
          <input className={req.cls("name")} data-req="name" value={name} placeholder="如 qwen、my-gpt" onChange={e => (setName(e.target.value), req.clear("name"), setErr(""))} />
        </Field>
        <Field label="类型">
          <select className="input" value={type} onChange={e => (setType(e.target.value), setNote(""), setForce(false))}>
            <option value="openai-compat">OpenAI 兼容（DeepSeek、Qwen、Kimi、vLLM 等）</option>
            <option value="anthropic">Anthropic</option>
            <option value="cli">命令行 Agent（Codex / Claude Code / Cursor CLI）</option>
          </select>
        </Field>
      </div>
      {(type === "openai-compat" || type === "anthropic") && (
        <Field label="Base URL" required={type === "openai-compat"} hint={type === "anthropic" ? "留空使用官方地址；填 …/anthropic 结尾的兼容地址也行" : undefined}>
          <input className={req.cls("baseURL", "input mono")} data-req="baseURL" value={baseURL} placeholder={type === "anthropic" ? "https://api.anthropic.com" : "https://…/v1"} onChange={e => onBase(e.target.value)} />
          {note && <div className="field-hint">{note}，类型已自动切换</div>}
        </Field>
      )}
      {type !== "cli" && (
        <>
          <Field label="API Key">
            <KeyInput value={key} onChange={setKey} />
            <KeyInfo probe={probe} />
          </Field>
          <Field label="默认模型" required>
            <ModelPicker value={model} onChange={v => (setModel(v), req.clear("model"), setErr(""))} probe={probe} listId="add" reqKey="model" invalid={req.bad.includes("model")} />
          </Field>
        </>
      )}
      {err && <div className="inline-warn">{err}</div>}
      <div className="pcard-actions">
        <button className="btn primary sm" data-testid="provider-add-confirm" disabled={testing} onClick={add}>
          {testing ? "正在测试连接…" : force ? "仍然添加" : "添加"}
        </button>
        <button className="btn sm" onClick={onDone}>
          取消
        </button>
      </div>
    </div>
  );
}


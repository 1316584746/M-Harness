import { useEffect, useState } from "react";
import type { AppState } from "../../../../shared/api";
import { Icon } from "../../components/Icon";
import { useConfigEditor } from "../../lib/configEdit";

interface ActionItem {
  id: string;
  name: string;
  prompt: string;
  description?: string;
}

function ActionCard({ item, onSave, onDelete }: { item: ActionItem; onSave: (patch: Partial<ActionItem>) => void; onDelete: () => void }) {
  const [name, setName] = useState(item.name);
  const [prompt, setPrompt] = useState(item.prompt);
  useEffect(() => setName(item.name), [item.name]);
  useEffect(() => setPrompt(item.prompt), [item.prompt]);

  return (
    <div className="pcard" data-testid={`action-${item.id}`}>
      <div className="pcard-head">
        <input className="input" style={{ flex: 1 }} data-testid="action-name" value={name} placeholder="动作名称，例如：写周报" onChange={e => setName(e.target.value)} onBlur={() => name.trim() && name !== item.name && onSave({ name: name.trim() })} />
        <button className="icon-btn sm" title="删除" data-testid="action-delete" onClick={onDelete}>
          <Icon name="trash" size={14} />
        </button>
      </div>
      <textarea
        className="input"
        rows={4}
        data-testid="action-prompt"
        value={prompt}
        placeholder="提示词模板。{{input}} 会替换成你在输入框里写的内容"
        onChange={e => setPrompt(e.target.value)}
        onBlur={() => prompt !== item.prompt && onSave({ prompt })}
      />
    </div>
  );
}

export function Actions({ state, onChanged }: { state: AppState; onChanged: () => void }) {
  const ed = useConfigEditor(state, onChanged);
  const items: ActionItem[] = ed.cfg?.actions ?? [];
  const [err, setErr] = useState("");

  const run = async (fn: (list: ActionItem[]) => ActionItem[] | void) => {
    setErr("");
    const r = await ed.update(c => {
      c.actions = fn(c.actions ?? []) ?? c.actions;
    });
    if (!r.ok) setErr(r.error ?? "保存失败");
  };

  return (
    <div className="card-section">
      <div className="shead">
        <h2>ACTIONS</h2>
        <span className="spacer" />
        <button className="btn" data-testid="action-add" onClick={() => void run(l => [...l, { id: `a${Date.now().toString(36)}`, name: "新动作", prompt: "" }])}>
          <Icon name="plus" size={14} /> 新增
        </button>
      </div>
      <div className="muted" style={{ marginBottom: 10 }}>
        在对话输入框里输入 <code>/</code> 选择动作
      </div>
      {err && <div className="inline-warn">{err}</div>}
      {!items.length && <div className="muted">暂无</div>}
      {items.map(it => (
        <ActionCard key={it.id} item={it} onSave={patch => void run(l => l.map(x => (x.id === it.id ? { ...x, ...patch } : x)))} onDelete={() => void run(l => l.filter(x => x.id !== it.id))} />
      ))}
    </div>
  );
}

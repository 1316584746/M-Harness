import { useEffect, useState } from "react";
import { api } from "../../api";
import { Icon } from "../../components/Icon";
import type { useConfigEditor } from "../../lib/configEdit";

type Branches = { base: string; test: string; integration: string };
const FIELDS: Array<{ key: keyof Branches; label: string; hint: string }> = [
  { key: "base", label: "基线分支", hint: "feature 从这个分支拉；留空则 build 时自动探测默认分支" },
  { key: "test", label: "提测分支", hint: "提测时合入 / 提 MR 的目标分支" },
  { key: "integration", label: "联调分支", hint: "联调环境对应的分支" },
];

function ClearInput({ value, onChange, listId, placeholder, testid }: { value: string; onChange: (v: string) => void; listId: string; placeholder: string; testid: string }) {
  return (
    <div className="clearable">
      <input className="input mono" data-testid={testid} list={listId} value={value} placeholder={placeholder} spellCheck={false} onChange={e => onChange(e.target.value)} />
      {value && (
        <button type="button" className="clear-btn" title="清空" onClick={() => onChange("")}>
          <Icon name="x" size={14} />
        </button>
      )}
    </div>
  );
}

/** 仓库的分支约定：基线 / 提测 / 联调分支，存进配置的 repos.<name>.branches */
export function RepoBranches({ name, dir, saved, update }: { name: string; dir: string; saved?: Partial<Branches>; update: ReturnType<typeof useConfigEditor>["update"] }) {
  const init: Branches = { base: saved?.base ?? "", test: saved?.test ?? "", integration: saved?.integration ?? "" };
  const [d, setD] = useState<Branches>(init);
  const [candidates, setCandidates] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const sig = JSON.stringify(init);
  useEffect(() => setD(init), [sig]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    let alive = true;
    void api.listBranches(dir).then(b => alive && setCandidates(b));
    return () => {
      alive = false;
    };
  }, [dir]);

  const dirty = FIELDS.some(f => d[f.key].trim() !== init[f.key]);

  const save = async () => {
    setBusy(true);
    const r = await update(c => {
      const repo = c.repos?.[name];
      if (!repo) return;
      const b: Record<string, string> = {};
      for (const f of FIELDS) if (d[f.key].trim()) b[f.key] = d[f.key].trim();
      if (Object.keys(b).length) repo.branches = b;
      else delete repo.branches;
    });
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: "分支设置已保存" } : { ok: false, text: r.error ?? "保存失败" });
  };

  const listId = `branches-${name}`;
  return (
    <div className="branches" data-testid={`repo-branches-${name}`}>
      <datalist id={listId}>
        {candidates.map(b => (
          <option key={b} value={b} />
        ))}
      </datalist>
      <div className="grid3">
        {FIELDS.map(f => (
          <div className="field" key={f.key} title={f.hint}>
            <div className="field-label">{f.label}</div>
            <ClearInput value={d[f.key]} onChange={v => (setD({ ...d, [f.key]: v }), setMsg(null))} listId={listId} placeholder={f.key === "base" ? "自动探测" : "未设置"} testid={`branch-${f.key}-${name}`} />
          </div>
        ))}
      </div>
      <div className="field-hint" style={{ marginTop: 6 }}>留空则自动探测默认分支</div>
      {msg && <div className={msg.ok ? "inline-ok" : "inline-warn"}>{msg.text}</div>}
      {dirty && (
        <div className="pcard-actions">
          <button className="btn primary sm" data-testid={`branch-save-${name}`} disabled={busy} onClick={save}>
            保存分支设置
          </button>
          <button className="btn sm" onClick={() => (setD(init), setMsg(null))}>
            还原
          </button>
        </div>
      )}
    </div>
  );
}

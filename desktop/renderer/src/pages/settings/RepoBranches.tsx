import { useEffect, useState } from "react";
import { api } from "../../api";
import { BranchInput } from "../../components/BranchInput";
import type { useConfigEditor } from "../../lib/configEdit";

type Draft = { base: string; test: string; integration: string; installCmd: string };
type Saved = { branches?: { base?: string; test?: string; integration?: string }; installCmd?: string };

const BRANCHES: Array<{ key: "base" | "test" | "integration"; label: string; hint: string; placeholder: string }> = [
  { key: "base", label: "线上分支", hint: "feature 从这个分支拉；留空则自动探测默认分支", placeholder: "留空自动探测" },
  { key: "test", label: "提测分支", hint: "提测时合入 / 提 MR 的目标分支", placeholder: "留空默认 test" },
  { key: "integration", label: "联调分支", hint: "联调环境对应的分支；没填就不能推联调", placeholder: "选填" },
];

const draftOf = (s?: Saved): Draft => ({
  base: s?.branches?.base ?? "",
  test: s?.branches?.test ?? "",
  integration: s?.branches?.integration ?? "",
  installCmd: s?.installCmd ?? "",
});

/** 仓库的分支约定和几条命令，存进配置的 repos.<name>（branches / installCmd） */
export function RepoBranches({ name, dir, saved, update }: { name: string; dir: string; saved?: Saved; update: ReturnType<typeof useConfigEditor>["update"] }) {
  const init = draftOf(saved);
  const [d, setD] = useState<Draft>(init);
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

  const dirty = (Object.keys(init) as Array<keyof Draft>).some(k => d[k].trim() !== init[k]);
  const set = (k: keyof Draft, v: string) => (setD(o => ({ ...o, [k]: v })), setMsg(null));

  const save = async () => {
    setBusy(true);
    const r = await update(c => {
      const repo = c.repos?.[name];
      if (!repo) return;
      const b: Record<string, string> = {};
      for (const f of BRANCHES) if (d[f.key].trim()) b[f.key] = d[f.key].trim();
      if (Object.keys(b).length) repo.branches = b;
      else delete repo.branches;
      for (const k of ["installCmd"] as const) {
        if (d[k].trim()) repo[k] = d[k].trim();
        else delete repo[k];
      }
    });
    setBusy(false);
    setMsg(r.ok ? { ok: true, text: "已保存" } : { ok: false, text: r.error ?? "保存失败" });
  };

  return (
    <div className="repo-fields" data-testid={`repo-branches-${name}`}>
      <div className="grid3">
        {BRANCHES.map(f => (
          <label className="rf" key={f.key} title={f.hint}>
            <span className="rf-label">{f.label}</span>
            <BranchInput className="input mono rf-dl" testid={`branch-${f.key}-${name}`} options={candidates} value={d[f.key]} placeholder={f.placeholder} onChange={v => set(f.key, v)} />
          </label>
        ))}
      </div>
      <label className="rf rf-row" title="新拉下来的仓库先跑这条命令装依赖">
        <span className="rf-label">依赖初始化命令</span>
        <input className="input mono" data-testid={`repo-install-${name}`} value={d.installCmd} placeholder="如 yarn install --frozen-lockfile --prefer-offline" spellCheck={false} onChange={e => set("installCmd", e.target.value)} />
      </label>
      {msg && <div className={msg.ok ? "inline-ok" : "inline-warn"}>{msg.text}</div>}
      {dirty && (
        <div className="pcard-actions">
          <button className="btn primary sm" data-testid={`branch-save-${name}`} disabled={busy} onClick={save}>
            保存
          </button>
          <button className="btn sm" onClick={() => (setD(init), setMsg(null))}>
            还原
          </button>
        </div>
      )}
    </div>
  );
}

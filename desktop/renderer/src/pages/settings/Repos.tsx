import { useCallback, useEffect, useState } from "react";
import type { AppState, RepoInfo } from "../../../../shared/api";
import { api } from "../../api";
import { Icon } from "../../components/Icon";
import { useConfigEditor } from "../../lib/configEdit";
import { GitHosts } from "./GitHosts";
import { RepoBranches } from "./RepoBranches";

const PLATFORM: Record<string, string> = { github: "GitHub", gitlab: "GitLab", gitee: "Gitee", codeup: "云效 Codeup", other: "远程仓库", local: "本地" };

function repoNameFromUrl(url: string): string {
  const last = url.trim().replace(/\/+$/, "").split(/[/:]/).pop() ?? "";
  return last.replace(/\.git$/i, "").replace(/[^\w.-]/g, "") || "repo";
}

export function Repos({ state, onChanged, onUse }: { state: AppState; onChanged: () => void; onUse: (path: string) => void }) {
  const ed = useConfigEditor(state, onChanged);
  const [repos, setRepos] = useState<RepoInfo[] | null>(null);
  const [adding, setAdding] = useState<"" | "clone">("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [url, setUrl] = useState("");
  const [parent, setParent] = useState("");
  const [dirName, setDirName] = useState("");

  const refresh = useCallback(() => void api.listRepos().then(setRepos), []);
  const sig = JSON.stringify(ed.cfg?.repos ?? {});
  useEffect(refresh, [refresh, sig]);

  const register = async (root: string, info: { name?: string; url?: string; branch?: string; platform?: string }) => {
    const existing = Object.entries(ed.cfg?.repos ?? {}).find(([, r]) => (r as any).path?.toLowerCase() === root.toLowerCase());
    if (existing) return setMsg({ ok: false, text: `这个仓库已经登记为「${existing[0]}」` });
    let name = (info.name ?? "repo").replace(/[^\w.-]/g, "") || "repo";
    const taken = new Set(Object.keys(ed.cfg?.repos ?? {}));
    for (let i = 2; taken.has(name); i++) name = `${info.name}-${i}`;
    const r = await ed.update(c => {
      c.repos ??= {};
      c.repos[name] = { path: root, ...(info.url ? { url: info.url } : {}), ...(info.platform ? { platform: info.platform } : {}) };
    });
    setMsg(r.ok ? { ok: true, text: `已添加「${name}」` } : { ok: false, text: r.error ?? "保存失败" });
  };

  const addLocal = async () => {
    setMsg(null);
    const dir = await api.pickFolder("选择一个 Git 仓库所在的文件夹");
    if (!dir) return;
    setBusy(true);
    const r = await api.inspectRepo(dir);
    if (!r.ok) setMsg({ ok: false, text: r.error ?? "不是 Git 仓库" });
    else await register(r.root!, r);
    setBusy(false);
  };

  const chooseParent = async () => {
    const d = await api.pickFolder("选择克隆到哪个文件夹下");
    if (d) setParent(d);
  };

  const clone = async () => {
    setMsg(null);
    if (!url.trim()) return setMsg({ ok: false, text: "请填写仓库地址" });
    if (!parent) return setMsg({ ok: false, text: "请选择克隆到哪个文件夹下" });
    const name = dirName.trim() || repoNameFromUrl(url);
    setBusy(true);
    setMsg({ ok: true, text: "正在克隆，大仓库可能需要几分钟…" });
    const r = await api.cloneRepo(url.trim(), parent, name);
    if (!r.ok) {
      setMsg({ ok: false, text: r.error ?? "克隆失败" });
    } else {
      const info = await api.inspectRepo(r.path!);
      await register(r.path!, info.ok ? info : { name, url: url.trim() });
      setAdding("");
      setUrl("");
      setDirName("");
    }
    setBusy(false);
  };

  const remove = async (name: string) => {
    if (!confirm(`移除仓库「${name}」？（只是取消登记，不会删除本地文件）`)) return;
    await ed.update(c => void delete c.repos?.[name]);
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>代码仓库</h1>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn" data-testid="repo-add-local" onClick={addLocal} disabled={busy}>
            <Icon name="folder" size={14} /> 添加本地仓库
          </button>
          <button className="btn" data-testid="repo-clone-open" onClick={() => setAdding(adding ? "" : "clone")} disabled={busy}>
            <Icon name="plus" size={14} /> 克隆
          </button>
        </div>
      </div>

      {adding === "clone" && (
        <div className="pcard add">
          <div className="pcard-head">
            <div className="pcard-name">克隆仓库</div>
          </div>
          <div className="field">
            <div className="field-label">仓库地址</div>
            <div className="field-hint">https://… 或 git@host:group/name.git</div>
            <input className="input mono" value={url} placeholder="https://github.com/org/repo.git" onChange={e => setUrl(e.target.value)} />
          </div>
          <div className="grid2">
            <div className="field">
              <div className="field-label">克隆到</div>
              <div className="inputrow">
                <input className="input mono" readOnly value={parent} placeholder="选择文件夹" onClick={chooseParent} />
                <button className="btn" onClick={chooseParent}>
                  选择
                </button>
              </div>
            </div>
            <div className="field">
              <div className="field-label">目录名</div>
              <input className="input mono" value={dirName} placeholder={url ? repoNameFromUrl(url) : "默认取仓库名"} onChange={e => setDirName(e.target.value)} />
            </div>
          </div>
          <div className="pcard-actions">
            <button className="btn primary sm" data-testid="repo-clone-run" onClick={clone} disabled={busy}>
              {busy ? "克隆中…" : "开始克隆"}
            </button>
            <button className="btn sm" onClick={() => setAdding("")} disabled={busy}>
              取消
            </button>
          </div>
        </div>
      )}

      <div style={{ marginTop: 12 }}>
        <GitHosts state={state} onChanged={onChanged} />
      </div>

      {msg && <div className={msg.ok ? "inline-ok" : "inline-warn"} style={{ marginTop: 12 }}>{msg.text}</div>}

      {repos && !repos.length && (
        <div className="empty">
          <Icon name="folder" size={24} />
          <div>还没有登记仓库。点右上角「添加本地仓库」选择一个文件夹，或「克隆」远程仓库。</div>
        </div>
      )}

      {repos?.map(r => (
        <div key={r.name} className="pcard" data-testid={`repo-card-${r.name}`}>
          <div className="pcard-head">
            <div className="pcard-name">{r.name}</div>
            {r.platform && <span className="tag">{PLATFORM[r.platform] ?? r.platform}</span>}
            {r.status.error ? (
              <span className="chip bad">{r.status.error}</span>
            ) : (
              <>
                <span className="chip">
                  <Icon name="spark" size={11} /> {r.status.branch ?? "游离 HEAD"}
                </span>
                {r.status.changed > 0 ? <span className="chip warn">{r.status.changed} 处未提交</span> : <span className="chip ok">干净</span>}
                {(r.status.ahead > 0 || r.status.behind > 0) && (
                  <span className="chip">
                    ↑{r.status.ahead} ↓{r.status.behind}
                  </span>
                )}
              </>
            )}
            <span className="spacer" />
            <button className="icon-btn sm" onClick={() => void remove(r.name)} title="移除">
              <Icon name="trash" size={14} />
            </button>
          </div>
          <div className="kv-line">
            <code className="path">{r.path}</code>
          </div>
          {r.url && <div className="muted" style={{ marginTop: 4 }}>{r.url}</div>}
          {r.status.last && <div className="muted" style={{ marginTop: 4 }}>最近提交：{r.status.last}</div>}
          <RepoBranches name={r.name} dir={r.path} saved={ed.cfg?.repos?.[r.name]?.branches} update={ed.update} />
          <div className="pcard-actions">
            <button className="btn sm" data-testid={`repo-use-${r.name}`} disabled={!!r.status.error} onClick={() => onUse(r.path)}>
              <Icon name="chat" size={13} /> 在新对话中使用
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

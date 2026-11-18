import { useEffect, useState } from "react";
import type { AppState, RuleFileDTO } from "../../../../shared/api";
import { api } from "../../api";
import { Icon } from "../../components/Icon";
import { useConfigEditor } from "../../lib/configEdit";
import { Switch } from "./Projects";

interface RuleItem {
  id: string;
  title: string;
  content: string;
  enabled: boolean;
}

function RuleCard({ item, onSave, onDelete }: { item: RuleItem; onSave: (patch: Partial<RuleItem>) => void; onDelete: () => void }) {
  const [title, setTitle] = useState(item.title);
  const [content, setContent] = useState(item.content);
  useEffect(() => setTitle(item.title), [item.title]);
  useEffect(() => setContent(item.content), [item.content]);

  return (
    <div className="pcard" data-testid={`rule-${item.id}`}>
      <div className="pcard-head">
        <input className="input" style={{ flex: 1 }} data-testid="rule-title" value={title} placeholder="规则名称（可选）" onChange={e => setTitle(e.target.value)} onBlur={() => title !== item.title && onSave({ title })} />
        <Switch on={item.enabled} testid="rule-switch" onChange={v => onSave({ enabled: v })} />
        <button className="icon-btn sm" title="删除" data-testid="rule-delete" onClick={onDelete}>
          <Icon name="trash" size={14} />
        </button>
      </div>
      <textarea
        className="input"
        data-testid="rule-content"
        rows={4}
        value={content}
        placeholder="例如：回复一律使用中文；提交信息遵循 Conventional Commits；不要修改 dist 目录"
        onChange={e => setContent(e.target.value)}
        onBlur={() => content !== item.content && onSave({ content })}
      />
    </div>
  );
}

export function Rules({ state, onChanged }: { state: AppState; onChanged: () => void }) {
  const ed = useConfigEditor(state, onChanged);
  const items: RuleItem[] = ed.cfg?.rules?.items ?? [];
  const useFiles: boolean = ed.cfg?.rules?.useProjectFiles ?? true;
  const [files, setFiles] = useState<RuleFileDTO[]>([]);
  const [err, setErr] = useState("");

  useEffect(() => void api.rulesPreview().then(setFiles), [state.configText, state.workspace]);

  const run = async (fn: (rules: Record<string, any>) => void) => {
    setErr("");
    const r = await ed.update(c => {
      c.rules ??= {};
      c.rules.items ??= [];
      fn(c.rules);
    });
    if (!r.ok) setErr(r.error ?? "保存失败");
  };

  return (
    <>
      <div className="card-section">
        <div className="shead">
          <h2>RULES</h2>
          <span className="spacer" />
          <button className="btn" data-testid="rule-add" onClick={() => void run(r => r.items.push({ id: `r${Date.now().toString(36)}`, title: "", content: "", enabled: true }))}>
            <Icon name="plus" size={14} /> 新增
          </button>
        </div>
        {err && <div className="inline-warn">{err}</div>}
        {!items.length && <div className="muted">暂无</div>}
        {items.map(it => (
          <RuleCard
            key={it.id}
            item={it}
            onSave={patch => void run(r => void Object.assign(r.items.find((x: RuleItem) => x.id === it.id) ?? {}, patch))}
            onDelete={() => void run(r => void (r.items = r.items.filter((x: RuleItem) => x.id !== it.id)))}
          />
        ))}
      </div>

      <div className="card-section">
        <h3>项目规则</h3>
        <div className="sgroup">
          <div className="srow">
            <div className="srow-text">
              <div className="srow-title">读取工作区里的规则文件</div>
              <div className="srow-desc">AGENTS.md、.cursor/rules</div>
            </div>
            <div className="srow-ctl">
              <Switch on={useFiles} testid="rule-use-files" onChange={v => void run(r => void (r.useProjectFiles = v))} />
            </div>
          </div>
          {useFiles &&
            (files.length ? (
              files.map(f => (
                <div className="srow" key={f.file} data-testid="rule-file">
                  <div className="srow-text">
                    <div className="srow-title">
                      <code>{f.file}</code>
                      <span className={`tag ${f.kind === "always" ? "accent" : ""}`}>{f.kind === "always" ? "始终生效" : "按需读取"}</span>
                    </div>
                    {f.description && <div className="srow-desc">{f.description}</div>}
                  </div>
                  <div className="srow-ctl muted">{f.chars} 字</div>
                </div>
              ))
            ) : (
              <div className="srow">
                <div className="srow-text muted">当前工作区没有规则文件</div>
              </div>
            ))}
        </div>
      </div>
    </>
  );
}

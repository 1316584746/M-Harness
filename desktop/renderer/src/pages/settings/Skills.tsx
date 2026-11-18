import { useCallback, useEffect, useState } from "react";
import type { AppState, SkillDTO } from "../../../../shared/api";
import { api } from "../../api";
import { Icon } from "../../components/Icon";
import { useConfigEditor } from "../../lib/configEdit";
import { Switch } from "./Projects";

const SOURCE: Record<SkillDTO["source"], string> = { project: "工作区", app: "本应用", custom: "自定义目录", user: "用户目录" };

/** 去掉 SKILL.md 开头的 yaml 头，只留正文给编辑框 */
const bodyOf = (text: string) => text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/^---\n[\s\S]*?\n---\n?/, "").trim();

function SkillForm({ initial, onDone }: { initial?: SkillDTO; onDone: () => void }) {
  const [name, setName] = useState(initial?.name ?? "");
  const [desc, setDesc] = useState(initial?.description ?? "");
  const [content, setContent] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    if (initial) void api.readSkill(initial.name).then(r => r.ok && setContent(bodyOf(r.content ?? "")));
  }, [initial]);

  const save = async () => {
    const r = await api.saveSkill({ name, description: desc, content });
    if (!r.ok) return setErr(r.error ?? "保存失败");
    onDone();
  };

  return (
    <div className="pcard add" data-testid="skill-form">
      <div className="field">
        <div className="field-label">名称</div>
        <input className="input mono" data-testid="skill-name" value={name} disabled={!!initial} placeholder="code-review" onChange={e => setName(e.target.value)} />
      </div>
      <div className="field">
        <div className="field-label">描述（模型据此判断什么时候用它）</div>
        <input className="input" data-testid="skill-desc" value={desc} placeholder="审查代码改动并给出问题清单" onChange={e => setDesc(e.target.value)} />
      </div>
      <div className="field">
        <div className="field-label">说明（SKILL.md 正文）</div>
        <textarea className="input" data-testid="skill-content" rows={8} value={content} placeholder="一步步写清楚该怎么做" onChange={e => setContent(e.target.value)} />
      </div>
      {err && <div className="inline-warn">{err}</div>}
      <div className="pcard-actions">
        <button className="btn primary" data-testid="skill-save" disabled={!name.trim() || !content.trim()} onClick={() => void save()}>
          保存
        </button>
        <button className="btn" onClick={onDone}>
          取消
        </button>
      </div>
    </div>
  );
}

export function Skills({ state, onChanged }: { state: AppState; onChanged: () => void }) {
  const ed = useConfigEditor(state, onChanged);
  const [skills, setSkills] = useState<SkillDTO[]>([]);
  const [form, setForm] = useState<{ initial?: SkillDTO } | null>(null);
  const [err, setErr] = useState("");
  const dirs: string[] = ed.cfg?.skills?.dirs ?? [];
  const scanUser: boolean = ed.cfg?.skills?.scanUserDirs ?? true;

  const load = useCallback(() => void api.listSkills().then(setSkills), []);
  useEffect(load, [load, state.configText, state.workspace]);

  const run = async (fn: (s: Record<string, any>) => void) => {
    setErr("");
    const r = await ed.update(c => {
      c.skills ??= {};
      c.skills.dirs ??= [];
      c.skills.disabled ??= [];
      fn(c.skills);
    });
    if (!r.ok) setErr(r.error ?? "保存失败");
  };

  const addDir = async () => {
    const p = await api.pickFolder("选择技能目录（其下每个子文件夹是一个技能）");
    if (p && !dirs.includes(p)) await run(s => void s.dirs.push(p));
  };

  return (
    <>
      <div className="card-section">
        <div className="shead">
          <h2>SKILLS</h2>
          <span className="spacer" />
          <button className="btn" data-testid="skill-add" onClick={() => setForm({})}>
            <Icon name="plus" size={14} /> 新建
          </button>
        </div>
        {err && <div className="inline-warn">{err}</div>}
        {form && (
          <SkillForm
            initial={form.initial}
            onDone={() => {
              setForm(null);
              load();
            }}
          />
        )}
        {!skills.length && !form && <div className="muted">暂无</div>}
        {skills.length > 0 && (
          <div className="sgroup">
            {skills.map(s => (
              <div className="srow" key={s.name} data-testid={`skill-${s.name}`}>
                <div className="srow-text">
                  <div className="srow-title">
                    {s.name}
                    <span className="tag">{SOURCE[s.source]}</span>
                  </div>
                  {s.description && <div className="srow-desc">{s.description}</div>}
                </div>
                <div className="srow-ctl">
                  {s.editable && (
                    <>
                      <button className="btn sm" data-testid="skill-edit" onClick={() => setForm({ initial: s })}>
                        编辑
                      </button>
                      <button
                        className="icon-btn sm"
                        title="删除"
                        data-testid="skill-delete"
                        onClick={() => void api.deleteSkill(s.name).then(r => (r.ok ? load() : setErr(r.error ?? "删除失败")))}
                      >
                        <Icon name="trash" size={14} />
                      </button>
                    </>
                  )}
                  <Switch
                    on={s.enabled}
                    testid="skill-switch"
                    onChange={v => void run(c => void (c.disabled = v ? c.disabled.filter((n: string) => n !== s.name) : [...new Set([...c.disabled, s.name])]))}
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card-section">
        <div className="shead">
          <h3 style={{ margin: 0 }}>额外的技能目录</h3>
          <span className="spacer" />
          <button className="btn sm" data-testid="skill-add-dir" onClick={() => void addDir()}>
            <Icon name="folder" size={13} /> 添加
          </button>
        </div>
        {dirs.length ? (
          <div className="chips">
            {dirs.map(d => (
              <span className="chip" key={d}>
                <code>{d}</code>
                <button className="chip-x" title="移除" onClick={() => void run(s => void (s.dirs = s.dirs.filter((x: string) => x !== d)))}>
                  <Icon name="x" size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : (
          <div className="muted">已自动扫描工作区的 .cursor/skills、.agents/skills</div>
        )}
        <div className="sgroup" style={{ marginTop: 10 }}>
          <div className="srow">
            <div className="srow-text">
              <div className="srow-title">扫描用户目录</div>
              <div className="srow-desc">~/.cursor/skills、~/.agents/skills</div>
            </div>
            <div className="srow-ctl">
              <Switch on={scanUser} testid="skill-user-dirs" onChange={v => void run(s => void (s.scanUserDirs = v))} />
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

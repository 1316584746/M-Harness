import { useState } from "react";
import type { AppState } from "../../../../shared/api";
import { ActionDialog } from "../../components/ActionDialog";
import { Icon } from "../../components/Icon";
import { useResourceTools } from "../../components/ResourceTools";
import { builtinSteps, customActions, moveItem, type ActionItem } from "../../lib/actionSteps";
import { useConfigEditor } from "../../lib/configEdit";
import { Switch } from "./Projects";

/** 一组的灰色标题条：名称、数量、折叠 */
function GroupBar({ title, count, open, onToggle }: { title: string; count: number; open: boolean; onToggle: () => void }) {
  return (
    <button className="act-group" onClick={onToggle} aria-expanded={open}>
      <Icon name={open ? "down" : "right"} size={13} />
      <span>{title}</span>
      <span className="act-count">{count}</span>
    </button>
  );
}

function Row({ name, desc, tag, first, last, shown, onMove, onShow, children, extra }: { name: string; desc?: string; tag?: string; first: boolean; last: boolean; shown: boolean; onMove: (d: -1 | 1) => void; onShow: (v: boolean) => void; children?: React.ReactNode; extra?: React.ReactNode }) {
  return (
    <div className={`act-row${shown ? "" : " off"}`} data-testid="action-row">
      <div className="act-main">
        <div className="act-name">
          {name}
          {tag && <span className="act-tag">{tag}</span>}
        </div>
        {desc && <div className="act-desc">{desc}</div>}
      </div>
      <div className="act-ctl">
        <button className="act-ico" title="上移" disabled={first} onClick={() => onMove(-1)}>
          <Icon name="down" size={13} style={{ transform: "rotate(180deg)" }} />
        </button>
        <button className="act-ico" title="下移" disabled={last} onClick={() => onMove(1)}>
          <Icon name="down" size={13} />
        </button>
        {children}
        <Switch on={shown} onChange={onShow} testid="action-switch" />
      </div>
      {extra}
    </div>
  );
}

export function Actions({ state, onChanged }: { state: AppState; onChanged: () => void }) {
  const ed = useConfigEditor(state, onChanged);
  const builtins = builtinSteps(ed.cfg);
  const items = customActions(ed.cfg);
  const [err, setErr] = useState("");
  const [shut, setShut] = useState<Set<string>>(new Set());
  const [look, setLook] = useState<string | null>(null);
  const [dlg, setDlg] = useState<{ item?: ActionItem } | null>(null);
  const tools = useResourceTools("action", onChanged);

  const run = async (fn: (c: Record<string, any>) => void) => {
    setErr("");
    const r = await ed.update(fn);
    if (!r.ok) setErr(r.error ?? "保存失败");
  };
  const runList = (fn: (list: ActionItem[]) => ActionItem[] | void) =>
    run(c => {
      c.actions = fn(c.actions ?? []) ?? c.actions;
    });
  const prefs = (c: Record<string, any>) => (c.actionPrefs ??= { order: [], hidden: [] });
  const toggleShut = (k: string) => setShut(s => (s.has(k) ? new Set([...s].filter(x => x !== k)) : new Set([...s, k])));

  const saveDialog = (v: Omit<ActionItem, "id">) => {
    const cur = dlg?.item;
    if (cur) void runList(l => l.map(x => (x.id === cur.id ? { ...x, ...v } : x)));
    else void runList(l => [...l, { id: `a${Date.now().toString(36)}`, ...v }]);
  };
  return (
    <>
      <div className="card-section">
        <div className="shead">
          <h2>ACTIONS</h2>
          <span className="spacer" />
          {tools.buttons}
          <button className="btn" data-testid="action-add" onClick={() => setDlg({})}>
            <Icon name="plus" size={14} /> 新增
          </button>
        </div>
        <div className="muted" style={{ marginBottom: 10 }}>
          推进动作：内置 + 自定义统一一列表，排序 / 显隐 / 编辑。在对话输入框里输入 <code>/</code> 也能选自定义动作
        </div>
        {tools.panel}
        {err && <div className="inline-warn">{err}</div>}

        <div className="act-list">
          <GroupBar title="通用" count={builtins.length} open={!shut.has("builtin")} onToggle={() => toggleShut("builtin")} />
          {!shut.has("builtin") &&
            builtins.map((b, i) => (
              <Row
                key={b.id}
                name={b.name}
                desc={b.description}
                tag="内置"
                first={i === 0}
                last={i === builtins.length - 1}
                shown={!b.hidden}
                onMove={d => void run(c => (prefs(c).order = moveItem(builtins.map(x => x.id), i, d)))}
                onShow={v => void run(c => (prefs(c).hidden = v ? (prefs(c).hidden ?? []).filter((x: string) => x !== b.id) : [...new Set([...(prefs(c).hidden ?? []), b.id])]))}
                extra={look === b.id && <div className="act-look" data-testid="action-look"><div className="act-file">提示词文件：prompts/_shared.md（共享规范）+ prompts/{b.file}。软件自带，只读；{"{{taskTitle}} {{taskId}} {{repoPath}} {{input}}"} 会在发送时替换。</div><pre className="act-pre">{b.prompt}</pre></div>}
              >
                <button className="act-link" onClick={() => setLook(look === b.id ? null : b.id)}>
                  {look === b.id ? "收起" : "查看"}
                </button>
              </Row>
            ))}

          <GroupBar title="自定义" count={items.length} open={!shut.has("custom")} onToggle={() => toggleShut("custom")} />
          {!shut.has("custom") && !items.length && <div className="act-empty">暂无自定义动作。点右上角「新增」，挑一个技能挂到推进面板。</div>}
          {!shut.has("custom") &&
            items.map((it, i) => (
              <Row
                key={it.id}
                name={it.name}
                desc={it.description || (it.skill ? `技能：${it.skill}` : it.prompt.replace(/\s+/g, " ").slice(0, 60))}
                first={i === 0}
                last={i === items.length - 1}
                shown={!it.hidden}
                onMove={d => void runList(l => moveItem(l, i, d))}
                onShow={v => void runList(l => l.map(x => (x.id === it.id ? { ...x, hidden: v ? undefined : true } : x)))}
              >
                <button className="act-link" data-testid="action-edit" onClick={() => setDlg({ item: it })}>
                  编辑
                </button>
                <button className="act-link bad" onClick={() => void runList(l => l.filter(x => x.id !== it.id))}>
                  删除
                </button>
              </Row>
            ))}
        </div>
      </div>
      {dlg && <ActionDialog item={dlg.item} onClose={() => setDlg(null)} onSave={saveDialog} />}
    </>
  );
}

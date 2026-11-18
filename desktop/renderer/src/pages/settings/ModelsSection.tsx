import { useEffect, useState } from "react";
import type { AppState } from "../../../../shared/api";
import { Icon } from "../../components/Icon";
import { useConfigEditor, type Cfg } from "../../lib/configEdit";
import { AddProvider, BUILTIN, ProviderCard } from "./Models";

const TYPE_LABEL: Record<string, string> = {
  "openai-compat": "OpenAI 兼容",
  anthropic: "Anthropic",
  "cursor-sdk": "Cursor SDK",
  cli: "命令行 Agent",
};

/** 模型：下拉选择 → 展示该提供方的配置 → 保存即设为全局使用；自定义提供方单独一个入口 */
export function ModelsSection({ state, onChanged }: { state: AppState; onChanged: () => void }) {
  const ed = useConfigEditor(state, onChanged);
  const providers: Record<string, Cfg> = ed.cfg?.providers ?? {};
  const names = Object.keys(providers);
  const builtin = names.filter(n => BUILTIN.has(n));
  const custom = names.filter(n => !BUILTIN.has(n));
  const current: string = ed.cfg?.defaultProvider ?? "";

  const [selected, setSelected] = useState<string>(current);
  const [adding, setAdding] = useState(false);

  // 选中的被删除时回退到全局使用的那个
  useEffect(() => {
    if (names.length && !names.includes(selected)) setSelected(names.includes(current) ? current : names[0]);
  }, [names.join("|"), current]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ed.cfg) return <div className="inline-warn">配置文件不是有效的 JSON，请先到「配置文件」里修复。</div>;

  const label = (n: string) => {
    const info = state.providers.find(p => p.name === n);
    return `${n} · ${TYPE_LABEL[providers[n]?.type] ?? providers[n]?.type}${info?.problem ? "（未配置）" : ""}`;
  };

  return (
    <>
      <div className="card-section">
        <div className="shead">
          <h2>模型</h2>
          <span className="spacer" />
          <span className="muted" style={{ margin: 0 }}>
            全局使用：<b data-testid="current-provider">{current}</b>
          </span>
        </div>

        <div className="field">
          <div className="field-label">选择模型 / Agent</div>
          <select className="input" data-testid="model-select" value={selected} onChange={e => setSelected(e.target.value)}>
            <optgroup label="内置">
              {builtin.map(n => (
                <option key={n} value={n}>
                  {label(n)}
                  {n === current ? "　✓ 全局使用中" : ""}
                </option>
              ))}
            </optgroup>
            {custom.length > 0 && (
              <optgroup label="自定义">
                {custom.map(n => (
                  <option key={n} value={n}>
                    {label(n)}
                    {n === current ? "　✓ 全局使用中" : ""}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </div>

        {providers[selected] && (
          <ProviderCard
            key={selected}
            name={selected}
            conf={providers[selected]}
            info={state.providers.find(p => p.name === selected)}
            cfgSetters={{ ...ed, onChanged }}
            isDefault={selected === current}
            onRemoved={() => setSelected(current)}
          />
        )}
      </div>

      <div className="card-section">
        <div className="shead">
          <h3 style={{ margin: 0 }}>自定义提供方</h3>
          <span className="spacer" />
          <button className="btn" data-testid="provider-add" onClick={() => setAdding(!adding)}>
            <Icon name="plus" size={14} /> 新增
          </button>
        </div>

        {adding && (
          <AddProvider
            names={names}
            update={ed.update}
            onDone={() => setAdding(false)}
            onAdded={n => {
              setAdding(false);
              setSelected(n);
            }}
          />
        )}

        {!custom.length && !adding && <div className="muted">暂无</div>}
        {custom.length > 0 && (
          <div className="sgroup">
            {custom.map(n => (
              <div key={n} className="srow" data-testid={`custom-row-${n}`}>
                <div className="srow-text">
                  <div className="srow-title">
                    {n}
                    <span className="tag">{TYPE_LABEL[providers[n].type] ?? providers[n].type}</span>
                    {n === current && <span className="chip run">全局使用中</span>}
                  </div>
                  <div className="srow-desc">{state.providers.find(p => p.name === n)?.desc}</div>
                </div>
                <div className="srow-ctl">
                  <button
                    className="btn sm"
                    onClick={() => {
                      setSelected(n);
                      document.querySelector(".settings-body")?.scrollTo({ top: 0, behavior: "smooth" });
                    }}
                  >
                    编辑
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

import type { UiPlugin } from "../../../shared/pluginhost";
import { Icon } from "./Icon";

/** 右侧插件栏：每个带界面的已装插件一个图标，点击在主区域打开 */
export function PluginRail({ plugins, activeId, onOpen, onManage }: { plugins: UiPlugin[]; activeId: string | null; onOpen: (id: string) => void; onManage: () => void }) {
  return (
    <aside className="plug-rail" data-testid="plugin-rail" aria-label="插件">
      <div className="plug-rail-list">
        {plugins.map(p => (
          <button key={p.id} className={`plug-rail-btn ${activeId === p.id ? "on" : ""}`} data-testid="rail-plugin" data-id={p.id} title={p.name} onClick={() => onOpen(p.id)}>
            {p.icon ? <img src={p.icon} alt="" width={20} height={20} /> : <span className="plug-rail-letter">{p.name.slice(0, 1)}</span>}
          </button>
        ))}
      </div>
      <button className="plug-rail-btn" data-testid="rail-manage" title="管理插件" onClick={onManage}>
        <Icon name="sliders" size={17} />
      </button>
    </aside>
  );
}

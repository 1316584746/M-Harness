import { useCallback, useEffect, useState } from "react";
import type { AppState } from "../../../shared/api";
import type { MarketResult } from "../../../shared/plugins";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { usePackageInstall } from "../lib/pkgInstall";
import { haveVersions } from "./plugins/common";
import { Installed } from "./plugins/Installed";
import { PluginSettings } from "./plugins/PluginSettings";
import { Store } from "./plugins/Store";

type Tab = "store" | "installed" | "settings";

const TABS: Array<{ id: Tab; label: string; icon: "store" | "box" | "sliders" }> = [
  { id: "store", label: "插件商店", icon: "store" },
  { id: "installed", label: "已安装", icon: "box" },
  { id: "settings", label: "设置", icon: "sliders" },
];

/** 插件中心：DBX 插件的商店 / 已安装 / 设置（本机 DBX、AI 桥接、插件目录） */
export function Plugins({ state, onChanged, onOpenSettings }: { state: AppState; onChanged: () => void; onOpenSettings: () => void }) {
  const [tab, setTab] = useState<Tab>("store");
  const [market, setMarket] = useState<MarketResult | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async (refresh = false, silent = false) => {
    if (!silent) setLoading(true);
    try {
      setMarket(await api.pluginMarket(refresh));
      window.dispatchEvent(new Event("harness:plugins-changed")); // 右侧插件栏跟着刷新
    } catch (e) {
      setMarket(m => m ?? { entries: [], errors: [{ source: "插件商店", error: e instanceof Error ? e.message : String(e) }] });
    }
    setLoading(false);
  }, []);

  useEffect(() => void reload(false), [reload]);

  const pkg = usePackageInstall(reload);
  const [dragging, setDragging] = useState(false);
  const installedCount = Object.keys(haveVersions(market)).length;

  return (
    <div
      className={`plugins ${dragging ? "dropping" : ""}`}
      data-testid="plugins-page"
      onDragOver={e => {
        if (!e.dataTransfer.types.includes("Files")) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={e => {
        if (e.currentTarget === e.target) setDragging(false);
      }}
      onDrop={e => {
        if (!e.dataTransfer.files.length) return;
        e.preventDefault();
        setDragging(false);
        void pkg.files([...e.dataTransfer.files]);
      }}
    >
      {dragging && <div className="px-drop-hint">松开鼠标，安装 .dbxp 插件包</div>}
      {pkg.msg && tab !== "settings" && (
        <div className={`px-msg ${pkg.msg.ok ? "ok" : "bad"} px-drop-msg`} data-testid="pkg-drop-msg">
          {pkg.msg.text}
        </div>
      )}
      <div className="plugins-top">
        <div className="plugins-tabs">
          {TABS.map(t => (
            <button key={t.id} data-testid={`plugin-tab-${t.id}`} className={`plugins-tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
              <Icon name={t.icon} size={14} />
              {t.label}
              {t.id === "installed" && installedCount > 0 && <span className="px-count">{installedCount}</span>}
            </button>
          ))}
        </div>
      </div>
      <div className="plugins-body">
        <div className="plugins-inner">
          {tab === "store" && <Store market={market} loading={loading} reload={reload} />}
          {tab === "installed" && <Installed market={market} loading={loading} reload={reload} />}
          {tab === "settings" && <PluginSettings state={state} onChanged={onChanged} market={market} loading={loading} reload={reload} pkg={pkg} />}
        </div>
      </div>
    </div>
  );
}

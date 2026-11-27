import { useEffect, useMemo, useState } from "react";
import type { UiPlugin } from "../../../shared/pluginhost";
import { api } from "../api";
import { runIdsOf, scopeKeyOf } from "../lib/pluginFocus";
import { Icon } from "./Icon";
import { PluginView } from "./PluginView";

/** 「上下文洞察」插件的 id（M-Market 里的 context-insight） */
export const CONTEXT_PLUGIN_ID = "context-insight";

type TurnLike = { runId?: string; traceFile?: string };

/**
 * 直接把「上下文洞察」插件的「上下文」页放进来，只分析这一段对话：
 * 插件的后台被限定成只能看到这段对话每一轮的运行记录（不是全局最新的会话，也不会混进别的对话），
 * 所以这一页里的上下文构成、token、耗时、时间线、调用的工具，都是这段对话自己的。
 * 没装 / 没启用插件就提示去装；这段对话还没有跑完过一轮时提示稍后再看。
 */
export function SessionContext({ convId, turns }: { convId: string; turns: TurnLike[] }) {
  const [plugin, setPlugin] = useState<UiPlugin | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .pluginUiList()
        .then(l => live && setPlugin(l.find(p => p.id.toLowerCase() === CONTEXT_PLUGIN_ID) ?? null))
        .catch(() => live && setPlugin(null));
    void load();
    window.addEventListener("harness:plugins-changed", load);
    return () => {
      live = false;
      window.removeEventListener("harness:plugins-changed", load);
    };
  }, []);

  const runs = useMemo(() => runIdsOf(turns), [turns]);
  const scope = useMemo(() => ({ key: scopeKeyOf(convId), runs }), [convId, runs]);

  if (!runs.length) {
    return (
      <div className="sc-empty" data-testid="session-ctx-none">
        <Icon name="list" size={30} />
        <b>这段对话还没有跑完过一轮</b>
        <span>第一轮跑完后，这里会显示它的上下文构成、token 和时间线。</span>
      </div>
    );
  }
  if (plugin === undefined) return <div className="sc-empty">加载中…</div>;
  if (!plugin) {
    return (
      <div className="sc-empty" data-testid="session-ctx-missing">
        <Icon name="plug" size={30} />
        <b>还没有安装「上下文洞察」插件</b>
        <span>到「插件」里安装并信任它，这里就会直接显示这段对话的上下文构成、token 和时间线。</span>
      </div>
    );
  }
  // 弹窗开着时又跑完一轮：用最新一轮的运行 id 当 key，重新载入插件页（顶部的刷新按钮已经藏起来了，不然看到的是旧数据）
  const theme = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
  return (
    <div className="sc-body" data-testid="session-ctx">
      <PluginView key={runs[runs.length - 1]} plugin={plugin} theme={theme} active scope={scope} focus={{ tab: "context", hide: ["header.top", ".toolbar:has(#runSel option:only-child)", ".head .h-t"] }} />
    </div>
  );
}

/** 整屏弹窗版：普通对话里的「上下文」按钮用 */
export function SessionContextDialog({ convId, turns, title = "对话上下文", onClose }: { convId: string; turns: TurnLike[]; title?: string; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    return () => document.removeEventListener("keydown", esc);
  }, [onClose]);
  return (
    <div className="modal-mask" data-testid="session-ctx-dialog" onMouseDown={e => e.target === e.currentTarget && onClose()}>
      <div className="modal sc-modal" role="dialog" aria-label={title}>
        <div className="cx-head">
          <h3 className="sc-title" title={title}>{title}</h3>
          <button className="cx-x" onClick={onClose} aria-label="关闭">
            <Icon name="x" size={16} />
          </button>
        </div>
        <SessionContext convId={convId} turns={turns} />
      </div>
    </div>
  );
}

import { useCallback, useMemo } from "react";
import type { AppState } from "../../../shared/api";
import { api } from "../api";

export type Cfg = Record<string, any>;

export function parseCfg(text: string): Cfg | null {
  try {
    const v = JSON.parse(text.replace(/^\uFEFF/, ""));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

/** 在界面里改配置：读当前配置文件 → 修改 → 校验并写回（等同于手动编辑 JSON）。每次都向主进程重新读最新的文件内容再改，不用界面里可能已过期的副本——否则两次连着保存，后一次会把前一次（比如刚登记的仓库）盖掉 */
export function useConfigEditor(state: AppState, onChanged: () => void) {
  const cfg = useMemo(() => parseCfg(state.configText), [state.configText]);

  const update = useCallback(
    async (fn: (c: Cfg) => void): Promise<{ ok: boolean; error?: string }> => {
      const fresh = await api.configText().catch(() => state.configText);
      const cur = parseCfg(fresh);
      if (!cur) return { ok: false, error: "配置文件不是有效的 JSON，请直接编辑数据目录里的 harness.config.json" };
      fn(cur);
      const r = await api.saveConfig(JSON.stringify(cur, null, 2) + "\n");
      if (r.ok) onChanged();
      return r;
    },
    [state.configText, onChanged],
  );

  return { cfg, update };
}

/** apiKey 字段形如 ${VAR} 时取 VAR；否则按提供方名生成变量名 */
export function envVarFor(name: string, apiKey: unknown): string {
  const m = typeof apiKey === "string" ? /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(apiKey) : null;
  return m ? m[1] : `${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

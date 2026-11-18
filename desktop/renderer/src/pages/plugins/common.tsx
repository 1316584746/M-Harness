import type { MarketResult, PluginKind } from "../../../../shared/plugins";

/** 已经装了的插件：id → 版本。只算装在本软件里的（本机有没有 DBX、DBX 里装了什么都不影响） */
export function haveVersions(market: MarketResult | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, i] of Object.entries(market?.dbx?.local ?? {})) out[id] = i.version;
  return out;
}

const COLORS = ["#3b82f6", "#8b5cf6", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#ec4899", "#6366f1", "#14b8a6", "#f97316"];

/** 没有图标的插件：取名字第一个字，按名字挑一个稳定的颜色 */
export function Avatar({ name, size = 36 }: { name: string; size?: number }) {
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (
    <span className="px-avatar" style={{ width: size, height: size, background: COLORS[h % COLORS.length], fontSize: size * 0.44 }}>
      {Array.from(name.trim())[0]?.toUpperCase() ?? "?"}
    </span>
  );
}

export const KIND_CLASS: Record<PluginKind, string> = { mcp: "k-mcp", skill: "k-skill", action: "k-action", rule: "k-rule", dbx: "k-dbx" };

/** 1.2.0 → v1.2.0；不是数字开头的（比如 reference）原样显示 */
export const verText = (v?: string): string => (v ? (/^\d/.test(v) ? `v${v}` : v) : "");

/** 2026-11-02 → 2026年11月2日 */
export function dateText(d?: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d ?? "");
  return m ? `${m[1]}年${Number(m[2])}月${Number(m[3])}日` : "";
}

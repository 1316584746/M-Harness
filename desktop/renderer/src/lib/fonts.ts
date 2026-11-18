import { api } from "../api";

/** 全局字体与缩放偏好：存在本机 localStorage，启动时立即应用，改动实时生效 */
export interface FontPrefs {
  /** 界面字体（空 = 默认） */
  ui: string;
  /** 代码 / 路径等等宽字体（空 = 默认） */
  mono: string;
  /** 界面缩放百分比 */
  zoom: number;
}

const KEY = "harness.font.v1";
export const DEFAULT_PREFS: FontPrefs = { ui: "", mono: "", zoom: 100 };
export const ZOOMS = [90, 100, 110, 125, 150];

const UI_STACK = '"Segoe UI", "Microsoft YaHei UI", "PingFang SC", system-ui, -apple-system, sans-serif';
const MONO_STACK = '"Cascadia Code", "JetBrains Mono", Consolas, "SFMono-Regular", Menlo, monospace';

export function loadFont(): FontPrefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return {
      ui: typeof v.ui === "string" ? v.ui : "",
      mono: typeof v.mono === "string" ? v.mono : "",
      zoom: ZOOMS.includes(v.zoom) ? v.zoom : 100,
    };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

const quote = (n: string) => `"${n.replace(/["\\;{}<>]/g, "").trim()}"`;

export function applyFont(p: FontPrefs) {
  const root = document.documentElement.style;
  const ui = p.ui.trim();
  const mono = p.mono.trim();
  if (ui) root.setProperty("--font", `${quote(ui)}, ${UI_STACK}`);
  else root.removeProperty("--font");
  if (mono) root.setProperty("--mono", `${quote(mono)}, ${MONO_STACK}`);
  else root.removeProperty("--mono");
  void api.setZoom(p.zoom / 100);
}

export function saveFont(p: FontPrefs) {
  localStorage.setItem(KEY, JSON.stringify(p));
  applyFont(p);
}

/** 本机已安装的字体族（Chromium 的本地字体接口；拿不到时返回空，用户仍可手填字体名） */
export async function listFonts(): Promise<string[]> {
  try {
    const list: Array<{ family: string }> = await (window as any).queryLocalFonts();
    return [...new Set(list.map(f => f.family))].sort((a, b) => a.localeCompare(b, "zh"));
  } catch {
    return [];
  }
}

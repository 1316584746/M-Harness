import { useEffect, useState } from "react";
import { DEFAULT_PREFS, listFonts, loadFont, saveFont, ZOOMS, type FontPrefs } from "../../lib/fonts";

function Row({ title, desc, children }: { title: string; desc?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="srow">
      <div className="srow-text">
        <div className="srow-title">{title}</div>
        {desc && <div className="srow-desc">{desc}</div>}
      </div>
      <div className="srow-ctl">{children}</div>
    </div>
  );
}

/** 偏好里的「字体与缩放」：输入或从本机已安装字体里选，实时作用于整个应用 */
export function FontSettings() {
  const [p, setP] = useState<FontPrefs>(loadFont);
  const [fonts, setFonts] = useState<string[]>([]);
  useEffect(() => void listFonts().then(setFonts), []);

  const change = (patch: Partial<FontPrefs>) => {
    const next = { ...p, ...patch };
    setP(next);
    saveFont(next);
  };
  const isDefault = p.ui === "" && p.mono === "" && p.zoom === 100;

  return (
    <>
      <Row title="界面字体">
        <input className="input" data-testid="font-ui" style={{ width: 240 }} list="font-list" value={p.ui} placeholder="默认（Segoe UI / 微软雅黑）" onChange={e => change({ ui: e.target.value })} />
      </Row>
      <Row title="代码字体">
        <input className="input mono" data-testid="font-mono" style={{ width: 240 }} list="font-list" value={p.mono} placeholder="默认（Cascadia Code / Consolas）" onChange={e => change({ mono: e.target.value })} />
      </Row>
      <datalist id="font-list">
        {fonts.map(f => (
          <option key={f} value={f} />
        ))}
      </datalist>
      <Row title="界面缩放">
        <div className="seg" data-testid="font-zoom">
          {ZOOMS.map(z => (
            <button key={z} className={p.zoom === z ? "on" : ""} onClick={() => change({ zoom: z })}>
              {z}%
            </button>
          ))}
        </div>
      </Row>
      <Row title="预览" desc={isDefault ? undefined : <a className="link" onClick={() => change({ ...DEFAULT_PREFS })}>恢复默认字体与缩放</a>}>
        <div className="font-preview">
          <div>读取 package.json，告诉我这个项目用了哪些依赖 Aa 123</div>
          <code>git log --oneline -n 20</code>
        </div>
      </Row>
    </>
  );
}

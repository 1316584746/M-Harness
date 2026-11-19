import { useEffect, useState } from "react";
import type { AutostartDTO } from "../../../../shared/api";
import { api } from "../../api";
import { Switch } from "./Projects";

/** 偏好里的「开机自启动」：开了以后电脑重启 / 登录时自动打开这个软件（写进系统登录项，不是自己常驻） */
export function AutostartRow() {
  const [s, setS] = useState<AutostartDTO | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void api.autostartGet().then(v => alive && setS(v));
    return () => {
      alive = false;
    };
  }, []);

  const toggle = async (on: boolean) => {
    setBusy(true);
    try {
      setS(await api.autostartSet(on));
    } finally {
      setBusy(false);
    }
  };

  const supported = !!s?.supported;
  const desc = !s ? "读取中…" : !supported ? s.reason : s.reason ? s.reason : s.enabled ? "已开启：电脑重启 / 登录后会自动打开本软件" : "开启后，电脑重启或登录时自动打开本软件";

  return (
    <div className="srow" data-testid="autostart-row">
      <div className="srow-text">
        <div className="srow-title">开机自启动</div>
        <div className={`srow-desc${s?.reason ? " warn" : ""}`}>{desc}</div>
      </div>
      <div className="srow-ctl" style={!supported || busy ? { opacity: 0.5, pointerEvents: "none" } : undefined}>
        <Switch on={!!s?.enabled} onChange={v => void toggle(v)} testid="autostart-switch" />
      </div>
    </div>
  );
}

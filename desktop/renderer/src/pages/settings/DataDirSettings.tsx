import { useEffect, useState } from "react";
import type { DataDirDTO } from "../../../../shared/api";
import { api } from "../../api";

/** 偏好里的「数据目录」：显示当前位置，可以换到别的目录（会重启，旧数据复制过去）或恢复默认位置 */
export function DataDirRow() {
  const [info, setInfo] = useState<DataDirDTO | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void api.dataDirGet().then(v => alive && setInfo(v));
    return () => {
      alive = false;
    };
  }, []);

  const change = async (dir: string) => {
    if (!info) return;
    const ok = window.confirm(`把数据目录换到：\n${dir}\n\n现有的配置、令牌、任务、插件和对话记录会复制到新目录（原目录里的文件不会删），然后软件自动重启。继续？`);
    if (!ok) return;
    setBusy(true);
    setMsg(null);
    const r = await api.dataDirSet(dir);
    if (!r.ok) {
      setBusy(false);
      return setMsg({ ok: false, text: r.error ?? "设置失败" });
    }
    setMsg({ ok: true, text: "正在重启…" });
  };

  const pick = async () => {
    const d = await api.pickFolder("选择数据目录（不存在的话会自动创建）");
    if (d) await change(d);
  };

  return (
    <div className="srow" data-testid="datadir-row">
      <div className="srow-text">
        <div className="srow-title">数据目录</div>
        <div className="srow-desc">
          配置、令牌、任务、插件和对话记录都在这里。
          {info && !info.isDefault && <> 默认位置是 <code className="path">{info.defaultDir}</code>。</>}
          {msg && <span className={msg.ok ? "inline-ok" : "inline-warn"} style={{ marginLeft: 6 }}>{msg.text}</span>}
        </div>
      </div>
      <div className="srow-ctl" style={{ gap: 8 }}>
        <code className="path" data-testid="datadir-path">{info?.current ?? "…"}</code>
        <button className="btn sm" data-testid="datadir-change" disabled={busy || !info} onClick={() => void pick()}>
          更改
        </button>
        {info && !info.isDefault && (
          <button className="btn sm" data-testid="datadir-reset" disabled={busy} onClick={() => void change(info.defaultDir)}>
            恢复默认
          </button>
        )}
      </div>
    </div>
  );
}

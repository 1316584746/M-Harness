import { useEffect, useState } from "react";
import type { AppState } from "../../../../shared/api";
import { api } from "../../api";
import { useConfigEditor } from "../../lib/configEdit";
import { updateSkip, useUpdate } from "../../lib/update";
import { Switch } from "./Projects";

function Row({ title, desc, children }: { title: string; desc?: React.ReactNode; children?: React.ReactNode }) {
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

function statusText(s: ReturnType<typeof useUpdate>): { text: string; tone?: "ok" | "bad" | "warn" } {
  if (!s) return { text: "" };
  switch (s.state) {
    case "checking":
      return { text: "正在检查…" };
    case "none":
      return { text: "已是最新版本", tone: "ok" };
    case "available":
      return { text: `发现新版本 v${s.latest}`, tone: "warn" };
    case "downloading":
      return { text: `正在下载 ${s.percent ?? 0}%`, tone: "warn" };
    case "downloaded":
      return { text: "更新已下载，等待重启安装", tone: "warn" };
    case "error":
      return { text: s.error ?? "检查失败", tone: "bad" };
    case "unconfigured":
      return { text: "还没有设置更新仓库" };
    default:
      return { text: "" };
  }
}

/** 偏好里的「关于与更新」：当前版本、更新仓库、自动检查开关、立即检查 */
export function UpdateSettings({ state, onChanged }: { state: AppState; onChanged: () => void }) {
  const ed = useConfigEditor(state, onChanged);
  const s = useUpdate();
  const saved: string = ed.cfg?.update?.repo ?? "";
  const auto: boolean = ed.cfg?.update?.autoCheck ?? true;
  const [repo, setRepo] = useState(saved);
  useEffect(() => setRepo(saved), [saved]);
  const st = statusText(s);
  const busy = s?.state === "checking" || s?.state === "downloading";

  const commitRepo = async () => {
    const v = repo.trim();
    if (v === saved) return;
    const r = await ed.update(c => void ((c.update ??= {}).repo = v));
    if (r.ok) void api.updateCheck();
  };

  return (
    <div className="card-section">
      <h3>关于与更新</h3>
      <div className="sgroup">
        <Row title="当前版本">
          <code className="path" data-testid="update-current">
            v{s?.current ?? "…"}
          </code>
        </Row>
        <Row title="更新仓库" desc="GitHub 上发布版本的仓库，形如 owner/repo">
          <input
            className="input"
            data-testid="update-repo"
            style={{ width: 240 }}
            value={repo}
            placeholder={s?.repo ?? "owner/repo"}
            onChange={e => setRepo(e.target.value)}
            onBlur={() => void commitRepo()}
            onKeyDown={e => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          />
        </Row>
        <Row title="自动检查更新" desc="启动时和每隔几小时检查一次，有新版本时提示">
          <Switch on={auto} testid="update-auto" onChange={v => void ed.update(c => void ((c.update ??= {}).autoCheck = v))} />
        </Row>
        <Row title="检查更新">
          {st.text && (
            <span className={`muted ${st.tone ?? ""}`} data-testid="update-status">
              {st.text}
            </span>
          )}
          <button
            className="btn sm"
            data-testid="update-check"
            disabled={busy}
            onClick={() => {
              updateSkip.clear();
              void api.updateCheck();
            }}
          >
            立即检查
          </button>
        </Row>
      </div>
    </div>
  );
}

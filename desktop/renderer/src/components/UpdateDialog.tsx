import type { UpdateStateDTO } from "../../../shared/api";
import { api } from "../api";
import { updateSkip } from "../lib/update";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

/** 发现新版本时的提示：更新说明 + 立即更新 / 稍后 / 跳过此版本 */
export function UpdateDialog({ s, onClose }: { s: UpdateStateDTO; onClose: () => void }) {
  const downloading = s.state === "downloading";
  const downloaded = s.state === "downloaded";
  const failed = s.state === "error";

  return (
    <div className="modal-mask" data-testid="update-dialog" role="dialog" aria-modal onMouseDown={e => e.target === e.currentTarget && !downloading && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <span className="modal-icon update">
            <Icon name="cloud" size={20} />
          </span>
          <div>
            <h3>{downloaded ? "更新已下载" : downloading ? "正在下载更新…" : failed ? "更新失败" : `发现新版本 v${s.latest}`}</h3>
            <div className="muted">
              当前 v{s.current}
              {s.latest && ` → v${s.latest}`}
            </div>
          </div>
        </div>

        {failed && <div className="inline-warn">{s.error}</div>}
        {downloading && (
          <div className="progress" data-testid="update-progress">
            <div className="progress-bar" style={{ width: `${s.percent ?? 0}%` }} />
            <span className="progress-text">{s.percent ?? 0}%</span>
          </div>
        )}
        {downloaded && <p className="muted">重启应用即可完成安装，对话记录和配置不受影响。</p>}
        {!downloading && !downloaded && s.notes && (
          <div className="update-notes">
            <Markdown text={s.notes} />
          </div>
        )}
        {!downloading && !downloaded && !s.canAutoInstall && !failed && <p className="muted">当前环境不支持应用内安装，点击更新将打开下载页面。</p>}

        <div className="modal-actions">
          {!downloading && !downloaded && s.latest && !failed && (
            <button
              className="btn"
              data-testid="update-skip"
              onClick={() => {
                updateSkip.skip(s.latest!);
                onClose();
              }}
            >
              跳过此版本
            </button>
          )}
          {!downloading && (
            <button className="btn" data-testid="update-later" onClick={onClose}>
              稍后
            </button>
          )}
          {downloaded ? (
            <button className="btn primary" data-testid="update-install" onClick={() => void api.updateInstall()} autoFocus>
              重启并安装
            </button>
          ) : (
            !downloading && (
              <button className="btn primary" data-testid="update-go" onClick={() => void api.updateDownload()} autoFocus>
                {failed ? "前往下载页" : s.canAutoInstall ? "下载并更新" : "前往下载"}
              </button>
            )
          )}
        </div>
      </div>
    </div>
  );
}

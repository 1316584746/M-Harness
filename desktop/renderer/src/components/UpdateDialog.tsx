import type { UpdateStateDTO } from "../../../shared/api";
import { api } from "../api";
import { updateSkip } from "../lib/update";
import { Icon } from "./Icon";
import { Markdown } from "./Markdown";

/** 更新弹窗：有新版本时是更新说明 + 立即更新 / 稍后 / 跳过此版本；没有新版本时（点标题栏的云朵按钮进来）显示检查结果 */
export function UpdateDialog({ s, onClose }: { s: UpdateStateDTO; onClose: () => void }) {
  const downloading = s.state === "downloading";
  const downloaded = s.state === "downloaded";
  const checking = s.state === "checking" || s.state === "idle";
  const upToDate = s.state === "none";
  const unconfigured = s.state === "unconfigured";
  /** 检查本身出错（没查到新版本），和「有新版本但下载失败」区分开 */
  const checkFailed = s.state === "error" && !s.latest;
  const failed = s.state === "error" && !!s.latest;
  const plain = checking || upToDate || unconfigured || checkFailed;

  return (
    <div className="modal-mask" data-testid="update-dialog" role="dialog" aria-modal onMouseDown={e => e.target === e.currentTarget && !downloading && onClose()}>
      <div className="modal">
        <div className="modal-head">
          <span className="modal-icon update">
            <Icon name="cloud" size={20} />
          </span>
          <div>
            <h3>
              {downloaded
                ? "更新已下载"
                : downloading
                  ? "正在下载更新…"
                  : failed
                    ? "更新失败"
                    : checking
                      ? "正在检查更新…"
                      : upToDate
                        ? "已是最新版本"
                        : unconfigured
                          ? "还没有设置更新仓库"
                          : checkFailed
                            ? "检查更新失败"
                            : `发现新版本 v${s.latest}`}
            </h3>
            <div className="muted">
              当前 v{s.current}
              {!plain && s.latest && ` → v${s.latest}`}
            </div>
          </div>
        </div>

        {checking && (
          <p className="muted" data-testid="update-checking">
            <span className="spinner" /> 正在向更新仓库查询最新版本…
          </p>
        )}
        {upToDate && <p className="muted" data-testid="update-uptodate">没有新版本，你用的就是最新的。</p>}
        {unconfigured && <p className="muted">到「设置 → 关于与更新」里填上发布版本的仓库（owner/repo），就能检查更新了。</p>}
        {(failed || checkFailed) && <div className="inline-warn">{s.error}</div>}
        {downloading && (
          <div className="progress" data-testid="update-progress">
            <div className="progress-bar" style={{ width: `${s.percent ?? 0}%` }} />
            <span className="progress-text">{s.percent ?? 0}%</span>
          </div>
        )}
        {downloaded && <p className="muted">重启应用即可完成安装，对话记录和配置不受影响。</p>}
        {!plain && !downloading && !downloaded && s.notes && (
          <div className="update-notes">
            <Markdown text={s.notes} />
          </div>
        )}
        {!plain && !downloading && !downloaded && !s.canAutoInstall && !failed && <p className="muted">当前环境不支持应用内安装，点击更新将打开下载页面。</p>}

        <div className="modal-actions">
          {!plain && !downloading && !downloaded && s.latest && !failed && (
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
          {(upToDate || checkFailed) && (
            <button
              className="btn"
              data-testid="update-recheck"
              onClick={() => {
                updateSkip.clear();
                void api.updateCheck();
              }}
            >
              重新检查
            </button>
          )}
          {!downloading && (
            <button className="btn" data-testid="update-later" onClick={onClose}>
              {plain ? "关闭" : "稍后"}
            </button>
          )}
          {downloaded ? (
            <button className="btn primary" data-testid="update-install" onClick={() => void api.updateInstall()} autoFocus>
              重启并安装
            </button>
          ) : (
            !downloading &&
            !plain && (
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

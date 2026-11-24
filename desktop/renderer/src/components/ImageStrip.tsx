import { useEffect, useState } from "react";
import { api } from "../api";
import { Icon } from "./Icon";

/** 路径 → 缩略图（经主进程读成 data URL）；读不到显示占位 */
export function Thumb({ path, onClick }: { path: string; onClick?: () => void }) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let alive = true;
    setUrl(undefined);
    void api.imageDataUrl(path).then(u => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [path]);
  const name = path.split(/[\\/]/).pop() ?? path;
  if (url === null) return <span className="img-thumb img-missing" title={path}>{name}</span>;
  return url ? <img className="img-thumb" src={url} alt={name} title={path} onClick={onClick} /> : <span className="img-thumb img-loading" />;
}

/** 输入框上方的待发送图片：缩略图 + 删除按钮 + 错误提示 */
export function ImageStrip({ images, error, onRemove }: { images: string[]; error?: string; onRemove: (p: string) => void }) {
  const [big, setBig] = useState<string | null>(null);
  if (!images.length && !error) return null;
  return (
    <div className="img-strip" data-testid="image-strip">
      {images.map(p => (
        <div className="img-item" key={p} data-testid="image-item">
          <Thumb path={p} onClick={() => setBig(p)} />
          <button type="button" className="img-x" title="移除这张图片" data-testid="image-remove" onClick={() => onRemove(p)}>
            <Icon name="x" size={11} strokeWidth={2.4} />
          </button>
        </div>
      ))}
      {error && <span className="img-err" data-testid="image-error">{error}</span>}
      {big && <Lightbox path={big} onClose={() => setBig(null)} />}
    </div>
  );
}

/** 发出去的消息里的图片：点开看大图 */
export function MsgImages({ images }: { images?: string[] }) {
  const [big, setBig] = useState<string | null>(null);
  if (!images?.length) return null;
  return (
    <div className="msg-imgs" data-testid="msg-images">
      {images.map(p => (
        <Thumb key={p} path={p} onClick={() => setBig(p)} />
      ))}
      {big && <Lightbox path={big} onClose={() => setBig(null)} />}
    </div>
  );
}

function Lightbox({ path, onClose }: { path: string; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    void api.imageDataUrl(path).then(setUrl);
    const k = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [path, onClose]);
  return (
    <div className="img-lightbox" data-testid="image-lightbox" onClick={onClose}>
      {url && <img src={url} alt="" />}
    </div>
  );
}

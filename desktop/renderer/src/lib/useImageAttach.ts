import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api";
import { DUP_TEXT, splitDuplicates } from "./imageDup";

/** 一条消息最多带几张图（主进程那边也有同样的上限） */
export const MAX_IMAGES = 6;
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;

/** 拖入的文件是不是图片（按类型或扩展名判断） */
export const isImageFile = (f: File) => f.type.startsWith("image/") || IMG_EXT.test(f.name);

/**
 * 输入框的图片附件：粘贴（Ctrl+V 截图 / 复制的图片）、拖入图片文件都走这里。
 * 粘贴来的图片先由主进程存成数据目录下的文件，这里只保存路径；发送时随消息一起交给模型。
 */
export function useImageAttach() {
  const [images, setImages] = useState<string[]>([]);
  const [error, setError] = useState("");
  const ref = useRef(images);
  ref.current = images;

  // 错误提示几秒后自己消失
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(() => setError(""), 5000);
    return () => clearTimeout(t);
  }, [error]);

  const add = useCallback((paths: string[]) => {
    // 同一张图片（粘贴的按内容认，拖入的按文件认）只留一个，并提示一下
    const { dup } = splitDuplicates(ref.current, paths);
    if (dup) setTimeout(() => setError(dup === 1 ? DUP_TEXT : `${DUP_TEXT}（有 ${dup} 张重复的）`), 0);
    setImages(a => {
      const next = [...new Set([...a, ...paths.filter(Boolean)])];
      if (next.length > MAX_IMAGES) setTimeout(() => setError(`一条消息最多带 ${MAX_IMAGES} 张图片，多的没有加`), 0);
      return next.slice(0, MAX_IMAGES);
    });
  }, []);

  const remove = useCallback((p: string) => setImages(a => a.filter(x => x !== p)), []);
  const clear = useCallback(() => setImages([]), []);

  /** 粘贴：剪贴板里是图片（且没有文字）就接管；其余照常粘贴 */
  const onPaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files = [...e.clipboardData.files].filter(f => f.type.startsWith("image/"));
      if (!files.length || e.clipboardData.types.includes("text/plain")) return;
      e.preventDefault();
      void (async () => {
        const saved: string[] = [];
        for (const f of files) {
          if (ref.current.length + saved.length >= MAX_IMAGES) {
            setError(`一条消息最多带 ${MAX_IMAGES} 张图片，多的没有加`);
            break;
          }
          const r = await api.saveImage(new Uint8Array(await f.arrayBuffer()), f.type);
          if (r.ok) saved.push(r.path);
          else setError(r.error);
        }
        if (saved.length) add(saved);
      })();
    },
    [add],
  );

  return { images, error, add, remove, clear, onPaste };
}

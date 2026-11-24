import fs from "node:fs";
import path from "node:path";

/** 附带图片的限制：最多几张、单张多大（超出的在界面里就拦住了，这里是最后一道保险） */
export const MAX_IMAGES = 6;
export const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export const isImagePath = (p: string): boolean => path.extname(p).toLowerCase() in MIME;
export const mimeOfImage = (p: string): string | undefined => MIME[path.extname(p).toLowerCase()];

export interface LoadedImage {
  path: string;
  mime: string;
  /** base64（不带 data: 前缀） */
  data: string;
}

/** 读一张图片；不是图片 / 不存在 / 太大都返回 undefined（调用方跳过它，不让一张坏图拖垮整次对话） */
export function loadImage(p: string): LoadedImage | undefined {
  const mime = mimeOfImage(p);
  if (!mime) return undefined;
  try {
    const st = fs.statSync(p);
    if (!st.isFile() || st.size > MAX_IMAGE_BYTES) return undefined;
    return { path: p, mime, data: fs.readFileSync(p).toString("base64") };
  } catch {
    return undefined;
  }
}

export function loadImages(paths: string[] | undefined): LoadedImage[] {
  return (paths ?? []).slice(0, MAX_IMAGES).map(loadImage).filter((x): x is LoadedImage => !!x);
}

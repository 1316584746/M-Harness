import type { HarnessApi } from "../../shared/api";

declare global {
  interface Window {
    harness: HarnessApi;
  }
}

export const api = window.harness;

export function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function cut(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + "…" : s;
}

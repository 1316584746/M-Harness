import { useCallback, useState } from "react";

/** 必填标识：红色星号，放在字段名后面 */
export function Req() {
  return (
    <em className="req" title="必填" aria-label="必填">
      *
    </em>
  );
}

export interface ReqField {
  /** 对应输入框上的 data-req 值 */
  key: string;
  /** 提示里显示的字段名 */
  label: string;
  /** 是否已填写 */
  ok: boolean;
}

/**
 * 必填校验：点保存时调用 check(字段列表)；
 * 有没填的就把对应输入框标红、滚动到第一个并聚焦，返回「请填写：A、B」；都填了返回空串。
 * 输入框上写 data-req={key}，className 用 cls(key)；用户改动后调 clear(key) 去掉红框。
 */
export function useRequired() {
  const [bad, setBad] = useState<string[]>([]);
  const check = useCallback((fields: ReqField[]): string => {
    const miss = fields.filter(f => !f.ok);
    setBad(miss.map(m => m.key));
    if (!miss.length) return "";
    requestAnimationFrame(() => {
      const el = document.querySelector<HTMLElement>(`[data-req="${miss[0].key}"]`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.focus?.({ preventScroll: true });
    });
    return `请填写：${miss.map(m => m.label).join("、")}`;
  }, []);
  const clear = useCallback((key: string) => setBad(b => (b.includes(key) ? b.filter(k => k !== key) : b)), []);
  const reset = useCallback(() => setBad([]), []);
  const cls = (key: string, base = "input") => (bad.includes(key) ? `${base} invalid` : base);
  return { bad, check, clear, reset, cls };
}

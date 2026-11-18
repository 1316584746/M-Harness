import { useEffect, useRef, useState } from "react";
import type { DefectsResult } from "../../../shared/defects";
import { api } from "../api";

const FOCUS_GAP = 60_000;

/** 指派给我的缺陷：启动时取一次，主进程定时刷新后推过来；切回窗口时（隔一分钟以上）再刷新一次 */
export function useDefects(): DefectsResult | null {
  const [r, setR] = useState<DefectsResult | null>(null);
  const last = useRef(Date.now());
  useEffect(() => {
    let alive = true;
    void api.defectsGet().then(x => alive && setR(x));
    const off = api.onDefectsChanged(x => {
      last.current = Date.now();
      setR(x);
    });
    const onFocus = () => {
      if (Date.now() - last.current > FOCUS_GAP) {
        last.current = Date.now();
        void api.defectsRefresh();
      }
    };
    window.addEventListener("focus", onFocus);
    return () => {
      alive = false;
      off();
      window.removeEventListener("focus", onFocus);
    };
  }, []);
  return r;
}

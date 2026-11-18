import { useEffect, useState } from "react";
import type { UpdateStateDTO } from "../../../shared/api";
import { api } from "../api";

/** 订阅主进程推送的更新状态 */
export function useUpdate(): UpdateStateDTO | null {
  const [s, setS] = useState<UpdateStateDTO | null>(null);
  useEffect(() => {
    let alive = true;
    void api.updateState().then(v => alive && setS(prev => prev ?? v));
    const off = api.onUpdate(v => setS(v));
    return () => {
      alive = false;
      off();
    };
  }, []);
  return s;
}

const SKIP = "harness.update.skip";
const PROMPTED = "harness.update.prompted";

export const updateSkip = {
  isSkipped: (v?: string) => !!v && localStorage.getItem(SKIP) === v,
  skip: (v: string) => localStorage.setItem(SKIP, v),
  clear: () => localStorage.removeItem(SKIP),
  /** 同一个版本只自动弹一次 */
  wasPrompted: (v?: string) => !!v && localStorage.getItem(PROMPTED) === v,
  markPrompted: (v: string) => localStorage.setItem(PROMPTED, v),
};

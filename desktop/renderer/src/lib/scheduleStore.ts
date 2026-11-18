import { useCallback, useEffect, useRef, useState } from "react";
import type { TodoChildDTO, TodoItemDTO } from "../../../shared/api";

/** 在本软件里填的排期（只存在本机，不写回飞书 / 钉钉） */
export interface SchedOverride {
  start?: number;
  end?: number;
  /** 人天 */
  days?: number;
}

const KEY = "harness.schedule.v1";

function load(): Record<string, SchedOverride> {
  try {
    const o = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    return o && typeof o === "object" ? o : {};
  } catch {
    return {};
  }
}

/** 需求本身用空的 childId */
export const schedKey = (t: Pick<TodoItemDTO, "source" | "id">, childId = "") => `${t.source}:${t.id}:${childId}`;

export function useScheduleStore() {
  const [all, setAll] = useState<Record<string, SchedOverride>>(load);
  const ref = useRef(all);
  ref.current = all;
  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(all));
    } catch {
      /* ignore */
    }
  }, [all]);
  const set = useCallback((key: string, v: SchedOverride | null) => {
    setAll(m => {
      const next = { ...m };
      if (!v || (v.start === undefined && v.end === undefined && v.days === undefined)) delete next[key];
      else next[key] = v;
      return next;
    });
  }, []);
  return { all, set };
}
export type ScheduleStore = ReturnType<typeof useScheduleStore>;

/** 把本地填的排期叠加到需求上：子任务各自覆盖，需求的起止日期取子项的并集；需求自己也可以直接填 */
export function applySchedule(items: TodoItemDTO[], all: Record<string, SchedOverride>): TodoItemDTO[] {
  return items.map(t => {
    let touched = false;
    const kids: TodoChildDTO[] | undefined = t.children?.map(c => {
      const o = all[schedKey(t, c.id)];
      if (!o) return c;
      touched = true;
      const start = o.start ?? o.end ?? c.start;
      const end = o.end ?? o.start ?? c.end;
      return { ...c, start, end, days: o.days ?? c.days, local: true };
    });
    let start = t.start;
    let end = t.end;
    const dated = (kids ?? []).filter(c => c.kind === "subtask" && (c.start !== undefined || c.end !== undefined));
    if (touched && dated.length) {
      start = Math.min(...dated.map(c => c.start ?? c.end!));
      end = Math.max(...dated.map(c => c.end ?? c.start!));
    }
    const own = all[schedKey(t)];
    if (own && (own.start !== undefined || own.end !== undefined)) {
      start = own.start ?? own.end;
      end = own.end ?? own.start;
      touched = true;
    }
    return touched ? { ...t, children: kids, start, end, due: end ?? t.due } : t;
  });
}

import { createPortal } from "react-dom";
import { almanacOf } from "../lib/almanac";

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const W = 264;

/** 鼠标停在日历某一天上时弹出的小卡片：日期 / 农历 / 节日 / 休或班 / 宜 / 忌 */
export function DayCard({ date, rect, today }: { date: Date; rect: DOMRect; today: boolean }) {
  const a = almanacOf(date);
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - W / 2), window.innerWidth - W - 8);
  // 优先放在格子上方（日历在页面下半部），放不下再放下面
  const above = rect.top > 250;
  const style = above ? { left, bottom: window.innerHeight - rect.top + 8 } : { left, top: rect.bottom + 8 };
  return createPortal(
    <div className="day-card" data-testid="day-card" style={{ width: W, ...style }} role="tooltip">
      <div className="dc-head">
        <b>
          {date.getMonth() + 1}月{date.getDate()}日 星期{WEEK[date.getDay()]}
        </b>
        {today && <em className="dc-today">今天</em>}
      </div>
      <div className="dc-sub">
        农历{a.lunar} · {a.year}
      </div>
      <div className="dc-sub">{a.ganzhi}</div>
      {(a.holiday || a.festivals.length > 0 || a.minor.length > 0) && (
        <div className="dc-tags" data-testid="day-card-tags">
          {a.holiday && <span className={`dc-tag ${a.holiday.work ? "work" : "off"}`}>{a.holiday.work ? `${a.holiday.name} · 调休补班` : `${a.holiday.name} · 放假`}</span>}
          {a.festivals.map(f => (
            <span key={f} className="dc-tag fest">
              {f}
            </span>
          ))}
          {a.minor.map(f => (
            <span key={f} className="dc-tag minor">
              {f}
            </span>
          ))}
        </div>
      )}
      <div className="dc-row yi" data-testid="day-card-yi">
        <span className="dc-k">宜</span>
        <span className="dc-v">{a.yi.join("　")}</span>
      </div>
      <div className="dc-row ji" data-testid="day-card-ji">
        <span className="dc-k">忌</span>
        <span className="dc-v">{a.ji.join("　")}</span>
      </div>
    </div>,
    document.body,
  );
}

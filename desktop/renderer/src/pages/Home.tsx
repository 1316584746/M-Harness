import { useCallback, useEffect, useMemo, useState } from "react";
import type { DailyDTO, WeatherDTO } from "../../../shared/api";
import { TODO_PLUGIN_ID, type HomeTodosDTO, type TodoItem } from "../../../shared/todos";
import { api } from "../api";
import { Icon } from "../components/Icon";
import { DayCard } from "../components/DayCard";
import { almanacOf } from "../lib/almanac";
import { lunarOf } from "../lib/lunar";

const WEEK = ["日", "一", "二", "三", "四", "五", "六"];
const CITY_KEY = "harness.home.city";
const NAME_KEY = "harness.home.name";

function ymd(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function greeting(h: number): string {
  if (h < 5) return "夜深了";
  if (h < 11) return "早上好";
  if (h < 13) return "中午好";
  if (h < 18) return "下午好";
  return "晚上好";
}

const WEEKDAY_LINE = ["周日，好好休息，给自己充充电", "新的一周，从容地开始", "周二，节奏找回来了", "周三，一周已经过半", "周四，胜利在望", "周五了，再坚持最后一小段", "周六，今天属于你自己"];

/** 没有图片时用日期生成一个固定的渐变底色 */
function fallbackBg(date: string): string {
  let h = 0;
  for (const c of date) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `linear-gradient(135deg, hsl(${h} 55% 38%), hsl(${(h + 50) % 360} 60% 28%))`;
}

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(t);
  }, []);
  return now;
}

// ───────────── 顶部：问候 + 每日一图一句 ─────────────

function Hello({ now, quote }: { now: Date; quote?: DailyDTO["quote"] | null }) {
  const [name, setName] = useState(() => localStorage.getItem(NAME_KEY) ?? "");
  useEffect(() => {
    void api.integrationStatus("lark").then(s => {
      if (s.authenticated && s.user) {
        setName(s.user);
        localStorage.setItem(NAME_KEY, s.user);
      }
    });
  }, []);

  const lunar = lunarOf(now);
  return (
    <section className="home-hello">
      <h1 data-testid="home-greeting">
        {greeting(now.getHours())}
        {name ? `，${name}` : ""}
      </h1>
      <div className="home-date" data-testid="home-date">
        {now.getMonth() + 1}月{now.getDate()}日 星期{WEEK[now.getDay()]} · 农历{lunar.month}
        {lunar.day}
      </div>
      <p className="home-weekday">{WEEKDAY_LINE[now.getDay()]}</p>
      {quote && (
        <div className="home-quote" data-testid="home-quote">
          <span className="home-quote-text">“{quote.text}”</span>
          {quote.author && <span className="home-quote-author">—— {quote.author}</span>}
        </div>
      )}
    </section>
  );
}

// ───────────── 天气 ─────────────

function Weather() {
  const [w, setW] = useState<WeatherDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [city, setCity] = useState(() => localStorage.getItem(CITY_KEY) ?? "");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const load = useCallback(
    (refresh = false, c = city) => {
      setLoading(true);
      void api.homeWeather({ refresh, city: c || undefined }).then(r => {
        setW(r);
        setLoading(false);
      });
    },
    [city],
  );
  useEffect(() => load(false), [load]);

  const submit = () => {
    const v = draft.trim();
    setEditing(false);
    if (!v || v === city) return;
    localStorage.setItem(CITY_KEY, v);
    setCity(v);
  };
  const reset = () => {
    localStorage.removeItem(CITY_KEY);
    setCity("");
  };

  const place = w ? [w.city, w.region && w.region !== w.city ? w.region : "", w.country].filter(Boolean).join(" · ") : "";
  const cur = w?.current;
  const today = w?.daily?.[0];

  return (
    <section className="home-weather" data-testid="home-weather">
      {!w && loading && <div className="weather-hint">正在获取天气…</div>}
      {w && !w.ok && (
        <div className="weather-hint bad" data-testid="weather-error">
          {w.error ?? "获取天气失败"}
          <button className="link-btn" onClick={() => load(true)}>
            重试
          </button>
        </div>
      )}
      {w?.ok && cur && (
        <>
          <div className="weather-now">
            <span className="weather-icon">{cur.icon}</span>
            <span className="weather-temp" data-testid="weather-temp">
              {cur.temp}°
            </span>
          </div>
          <div className="weather-line">
            {cur.text}
            {today ? ` · ${today.min}° ~ ${today.max}°` : ""} · 体感 {cur.feels}°
          </div>
          <div className="weather-line sub">
            湿度 {cur.humidity}% · 风 {cur.wind} km/h
            {today?.pop !== undefined && today.pop >= 30 ? ` · 降水 ${today.pop}%` : ""}
          </div>
          <div className="weather-place">
            <button className="weather-city" data-testid="weather-city" title="点击更改城市" onClick={() => (setDraft(city), setEditing(e => !e))}>
              {place || "未知位置"}
            </button>
            <button className="icon-btn sm weather-refresh" title="刷新" data-testid="weather-refresh" disabled={loading} onClick={() => load(true)}>
              <Icon name="refresh" size={13} />
            </button>
          </div>
          <div className="weather-line sub">
            {w.byIp ? `按本机 IP 定位${w.ip ? `（${w.ip}）` : ""}` : "已手动指定城市"}
            {w.stale && " · 离线，显示的是旧数据"}
            {city && (
              <button className="link-btn" onClick={reset}>
                恢复 IP 定位
              </button>
            )}
          </div>
        </>
      )}
      {editing && (
        <input className="input weather-input" data-testid="weather-city-input" autoFocus value={draft} placeholder="输入城市名，回车确认（如 北京）" onChange={e => setDraft(e.target.value)} onKeyDown={e => (e.key === "Enter" ? submit() : e.key === "Escape" && setEditing(false))} onBlur={() => setEditing(false)} />
      )}
    </section>
  );
}

// ───────────── 日历 ─────────────

function Calendar({ now }: { now: Date }) {
  const [offset, setOffset] = useState(0);
  /** 鼠标停在哪一天上：弹出黄历卡片 */
  const [hover, setHover] = useState<{ d: Date; rect: DOMRect } | null>(null);
  const first = useMemo(() => new Date(now.getFullYear(), now.getMonth() + offset, 1), [now.getFullYear(), now.getMonth(), offset]);
  const today = ymd(now);

  // 周一开头，只画本月需要的周数（5 或 6 行）
  const cells = useMemo(() => {
    const lead = (first.getDay() + 6) % 7;
    const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const start = new Date(first.getFullYear(), first.getMonth(), 1 - lead);
    return Array.from({ length: Math.ceil((lead + days) / 7) * 7 }, (_, i) => new Date(start.getFullYear(), start.getMonth(), start.getDate() + i));
  }, [first]);
  const als = useMemo(() => new Map(cells.map(d => [ymd(d), almanacOf(d)] as const)), [cells]);

  return (
    <section className="home-cal" data-testid="home-calendar">
      <div className="home-cal-head">
        <h3 data-testid="calendar-title">
          {first.getFullYear()}年{first.getMonth() + 1}月
        </h3>
        <span className="spacer" />
        {offset !== 0 && (
          <button className="link-btn" data-testid="calendar-today" onClick={() => setOffset(0)}>
            回到今天
          </button>
        )}
        <button className="icon-btn sm" title="上个月" data-testid="calendar-prev" onClick={() => setOffset(o => o - 1)}>
          <Icon name="back" size={13} />
        </button>
        <button className="icon-btn sm" title="下个月" data-testid="calendar-next" onClick={() => setOffset(o => o + 1)}>
          <Icon name="right" size={13} />
        </button>
      </div>
      <div className="cal-grid">
        {["一", "二", "三", "四", "五", "六", "日"].map((w, i) => (
          <div key={w} className={`cal-wd ${i >= 5 ? "weekend" : ""}`}>
            {w}
          </div>
        ))}
        {cells.map(d => {
          const key = ymd(d);
          const out = d.getMonth() !== first.getMonth();
          const wk = d.getDay() === 0 || d.getDay() === 6;
          const al = als.get(key) ?? almanacOf(d);
          return (
            <div
              key={key}
              className={`cal-cell ${out ? "out" : ""} ${wk ? "weekend" : ""} ${key === today ? "today" : ""}`}
              data-today={key === today ? "1" : undefined}
              data-date={key}
              tabIndex={0}
              onMouseEnter={e => setHover({ d, rect: e.currentTarget.getBoundingClientRect() })}
              onMouseLeave={() => setHover(null)}
              onFocus={e => setHover({ d, rect: e.currentTarget.getBoundingClientRect() })}
              onBlur={() => setHover(null)}
            >
              <span className="cal-day">{d.getDate()}</span>
              <span className={`cal-lunar ${al.label ? "fest" : ""}`}>{al.label || lunarOf(d).short}</span>
              {al.holiday && <i className={`cal-badge ${al.holiday.work ? "work" : "off"}`}>{al.holiday.work ? "班" : "休"}</i>}
            </div>
          );
        })}
      </div>
      {hover && <DayCard date={hover.d} rect={hover.rect} today={ymd(hover.d) === today} />}
    </section>
  );
}

// ───────────── 今日待办（来自「待办 Todo」插件） ─────────────

const TODO_FOLD = 5;

function todoTag(t: TodoItem): string {
  if (t.kind === "overdue") return `逾期 ${t.days} 天`;
  if (t.kind === "doing") {
    const d = t.at ? new Date(t.at) : null;
    return d && !Number.isNaN(d.getTime()) ? `进行中 · 截止 ${d.getMonth() + 1}/${d.getDate()}` : "进行中";
  }
  const hm = t.at && !Number.isNaN(new Date(t.at).getTime()) ? new Date(t.at) : null;
  const time = hm ? `${String(hm.getHours()).padStart(2, "0")}:${String(hm.getMinutes()).padStart(2, "0")}` : "";
  if (t.kind === "today") return t.late ? `已过 ${time}` : `今天 ${time}`;
  return `${time} 开始`;
}

function TodayTodos({ active, onOpenPlugin }: { active: boolean; onOpenPlugin?: (id: string) => void }) {
  const [dto, setDto] = useState<HomeTodosDTO | null>(null);
  const [open, setOpen] = useState(false);
  const load = useCallback(() => void api.homeTodos().then(setDto).catch(() => {}), []);

  // 回到首页、窗口重新获得焦点、装 / 卸插件后、每 5 分钟：重新取一次
  useEffect(() => {
    if (!active) return;
    load();
    const t = setInterval(load, 5 * 60_000);
    window.addEventListener("focus", load);
    window.addEventListener("harness:plugins-changed", load);
    return () => {
      clearInterval(t);
      window.removeEventListener("focus", load);
      window.removeEventListener("harness:plugins-changed", load);
    };
  }, [active, load]);

  // 没有事项就整块不显示（包括插件没装 / 没信任 / 读取失败的情况）
  if (!dto || dto.state !== "ok" || dto.items.length === 0) return null;
  const items = dto.items;
  const shown = open ? items : items.slice(0, TODO_FOLD);
  const goTodo = () => onOpenPlugin?.(TODO_PLUGIN_ID);

  return (
    <aside className="home-todos" data-testid="home-todos" data-state={dto.state} data-count={items.length}>
      <div className="home-todos-head">
        <h3>今日待办</h3>
        <span className="home-todos-count" data-testid="todos-count">
          {items.length}
        </span>
        <span className="spacer" />
        <button className="link-btn" data-testid="todos-open" onClick={goTodo}>
          打开待办
        </button>
      </div>
      {shown.length > 0 && (
        <ul className="home-todos-list" data-testid="todos-list">
          {shown.map(t => (
            <li key={t.id} className={`todo-row ${t.kind} ${t.priority}`} data-testid="todo-row" data-kind={t.kind} title={t.group ? `${t.group} · ${t.title}` : t.title} onClick={goTodo}>
              <span className="todo-dot" />
              <span className="todo-title">{t.title}</span>
              {t.sub && <span className="todo-sub">{t.sub.done}/{t.sub.total}</span>}
              <span className="todo-tag">{todoTag(t)}</span>
            </li>
          ))}
        </ul>
      )}
      {items.length > TODO_FOLD && (
        <button className="link-btn home-todos-fold" data-testid="todos-fold" onClick={() => setOpen(o => !o)}>
          {open ? "收起" : `展开全部（还有 ${items.length - TODO_FOLD} 项）`}
        </button>
      )}
    </aside>
  );
}

// ───────────── 首页 ─────────────

export function Home({ active = true, onOpenPlugin }: { active?: boolean; onOpenPlugin?: (id: string) => void }) {
  const now = useNow();
  const [daily, setDaily] = useState<DailyDTO | null>(null);
  const loadDaily = useCallback(() => void api.homeDaily().then(setDaily), []);
  useEffect(loadDaily, [loadDaily]);

  // 跨天（电脑睡眠、窗口一直开着）后回到窗口：换成新一天的图和句子
  useEffect(() => {
    const h = () => daily && daily.date !== ymd(new Date()) && loadDaily();
    window.addEventListener("focus", h);
    return () => window.removeEventListener("focus", h);
  }, [daily, loadDaily]);

  const bg = daily?.image ? `linear-gradient(180deg, rgba(0,0,0,0.28) 0%, rgba(0,0,0,0.18) 45%, rgba(0,0,0,0.62) 100%), url(${daily.image})` : daily ? fallbackBg(daily.date) : "var(--surface-3)";

  return (
    <div className="home" data-testid="home">
      <div className="home-bg" data-testid="home-hero" style={{ backgroundImage: bg }} />
      <div className="home-scroll">
        <div className="home-inner">
          <div className="home-top">
            <Hello now={now} quote={daily?.quote} />
            <Weather />
          </div>
          <div className="home-mid">
            <TodayTodos active={active} onOpenPlugin={onOpenPlugin} />
          </div>
          <div className="home-bottom">
            <div className="home-foot" />
            <Calendar now={now} />
          </div>
        </div>
      </div>
    </div>
  );
}

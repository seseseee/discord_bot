// web/src/app/page.tsx
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

/** ===== Types ===== */
type Bucket = "week" | "day";
type SeriesPoint = { t: string; sai: number; counts: { messages: number; users: number } };
type SeriesRes = {
  ok: boolean;
  meta: { serverId: string; channelId: string | null; bucket: Bucket; from: string; to: string };
  series: SeriesPoint[];
  error?: string;
};
type FirstMessageRes = {
  ok: boolean;
  earliestMs: number | null;
  earliestIso: string | null;
  earliestSundayIso: string | null;
  anchorIso: string | null;
  error?: string;
};

/** ===== Config ===== */
export const dynamic = "force-dynamic"; // 常に動的
const TZ = "Asia/Tokyo";
const SERVER_ID_ENV = (process.env.NEXT_PUBLIC_SERVER_ID || process.env.NEXT_PUBLIC_SERVER || "").trim();

/** 表示窓：原点から 9 週間（= 約2か月）。右端は非含む */
const VISIBLE_WEEKS = 9;
/** 自動更新間隔（控えめ） */
const REFRESH_WEEKLY_MS = 10 * 60 * 1000; // 10分
const REFRESH_DAILY_MS = 2 * 60 * 1000; // 2分（必要なら短めに）

/** ===== Utils ===== */
const dtfFull = new Intl.DateTimeFormat("ja-JP", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const dtfDate = new Intl.DateTimeFormat("ja-JP", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour12: false });

function startOfSunday(d: Date) {
  const x = new Date(d);
  const w = x.getDay();
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - w);
  return x;
}
function startOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function addDays(d: Date, n: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}
function toIso(d: Date | string) {
  return new Date(d as any).toISOString();
}
function fmtMD(d: Date) {
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}
function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

/** レスポンシブ幅 */
function useContainerWidth(min = 360) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [w, setW] = useState(min);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver((es) => {
      for (const e of es) setW(Math.max(min, Math.floor(e.contentRect.width)));
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [min]);
  return { ref, width: w };
}

/** 直近7日（今日から一週間前まで）の日付配列 [d0,...,d6] */
function last7Days(now: Date) {
  const end = startOfDay(now); // 今日の0時
  const arr: Date[] = [];
  for (let i = 7; i >= 1; i--) arr.push(addDays(end, -i)); // 1日前〜7日前（「今日から一週間前まで」）
  return arr;
}

export default function DashboardPage() {
  const search = useSearchParams();
  const serverId = (search.get("serverId") || SERVER_ID_ENV || "").trim();

  /** Hydration対策：時刻はマウント後だけ */
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setMounted(true);
  }, []);

  /** 時計 & 自動更新 */
  const [clock, setClock] = useState<number>(() => Date.now());
  const [autoWeekly, setAutoWeekly] = useState(true);
  const [autoDaily, setAutoDaily] = useState(true);
  useEffect(() => {
    if (!autoWeekly && !autoDaily) return;
    const id = setInterval(() => setClock(Date.now()), Math.min(REFRESH_WEEKLY_MS, REFRESH_DAILY_MS));
    return () => clearInterval(id);
  }, [autoWeekly, autoDaily]);

  const now = useMemo(() => new Date(clock), [clock]);
  const currSunday = useMemo(() => startOfSunday(now), [now]);

  /** ─ 原点（初回は「最初の取得日＋1週間後」の日曜を API で取得して保存） ─ */
  const anchorKey = useMemo(() => (serverId ? `sai_anchor_from_first_${serverId}` : ""), [serverId]);
  const [anchorIso, setAnchorIso] = useState<string | null>(null);

  // 初回ロード：localStorage → なければ API で取得
  useEffect(() => {
    if (!serverId) return;
    const saved = anchorKey ? localStorage.getItem(anchorKey) : null;
    if (saved) {
      setAnchorIso(saved);
      return;
    }
    (async () => {
      try {
        const r = await fetch(`/api/metrics/first-message?serverId=${encodeURIComponent(serverId)}`, { cache: "no-store" });
        const js: FirstMessageRes = await r.json();
        if (js.ok && js.anchorIso) {
          setAnchorIso(js.anchorIso);
          if (anchorKey) localStorage.setItem(anchorKey, js.anchorIso);
        } else {
          // データ未取得の場合は「今週の次の週」を仮原点に（空白9週を作る）
          const tmp = addDays(currSunday, 7).toISOString();
          setAnchorIso(tmp);
          if (anchorKey) localStorage.setItem(anchorKey, tmp);
        }
      } catch {
        /* noop */
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  const anchor = useMemo(() => new Date(anchorIso ?? addDays(currSunday, 7) as any), [anchorIso, currSunday]);
  const rightEdge = useMemo(() => addDays(anchor, 7 * VISIBLE_WEEKS), [anchor]);

  /** 週が進んだら、窓が満杯の時だけ原点を+1週スライド */
  useEffect(() => {
    if (!anchorIso) return;
    if (currSunday.getTime() >= rightEdge.getTime()) {
      const next = addDays(anchor, 7).toISOString();
      setAnchorIso(next);
      if (anchorKey) localStorage.setItem(anchorKey, next);
    }
  }, [currSunday, rightEdge, anchor, anchorIso, anchorKey]);

  /** 表示用の週（日曜配列） */
  const sundays = useMemo(() => {
    const arr: Date[] = [];
    let cur = new Date(anchor);
    while (cur < rightEdge) {
      arr.push(new Date(cur));
      cur = addDays(cur, 7);
    }
    return arr;
  }, [anchor, rightEdge]);

  /** ─ データ取得：週次（anchor..rightEdge） ─ */
  const [weekly, setWeekly] = useState<SeriesRes | null>(null);
  const [wErr, setWErr] = useState<string | null>(null);
  const [wLoading, setWLoading] = useState(false);

  const fetchWeekly = useCallback(
    async (signal?: AbortSignal) => {
      setWErr(null);
      if (!serverId || !anchorIso) {
        setWeekly(null);
        return;
      }
      setWLoading(true);
      try {
        const qs = new URLSearchParams({ serverId, bucket: "week", from: toIso(anchor), to: toIso(rightEdge) });
        const r = await fetch(`/api/metrics/sai/series?${qs.toString()}`, { cache: "no-store", signal });
        const js: SeriesRes = await r.json();
        if (!r.ok || !js.ok) throw new Error(js?.error || `fetch failed: ${r.status}`);
        setWeekly(js);
      } catch (e: any) {
        if (String(e?.name) !== "AbortError") setWErr(String(e?.message ?? e));
        setWeekly(null);
      } finally {
        setWLoading(false);
      }
    },
    [serverId, anchorIso, anchor, rightEdge]
  );

  // 初回 & 自動更新（控えめ）
  useEffect(() => {
    const ac = new AbortController();
    fetchWeekly(ac.signal);
    return () => ac.abort();
  }, [fetchWeekly]);
  useEffect(() => {
    if (!autoWeekly) return;
    const id = setInterval(() => fetchWeekly(), REFRESH_WEEKLY_MS);
    return () => clearInterval(id);
  }, [autoWeekly, fetchWeekly]);

  /** 週→SAI マップ（空白は undefined のまま＝点なし） */
  const weeklyMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of weekly?.series || []) {
      const end = new Date(p.t);
      const begin = startOfSunday(addDays(end, -7));
      m.set(begin.toISOString(), clamp(Math.round(p.sai), 0, 100));
    }
    return m;
  }, [weekly]);

  /** ─ データ取得：直近7日の日次（今日から一週間前まで） ─ */
  const days = useMemo(() => last7Days(now), [now]);
  const dayFrom = useMemo(() => days[0] ?? addDays(now, -7), [days, now]);
  const dayTo = useMemo(() => addDays(days[days.length - 1] ?? now, 1), [days, now]); // API側は t1=区切り終端

  const [daily, setDaily] = useState<SeriesRes | null>(null);
  const [dErr, setDErr] = useState<string | null>(null);
  const [dLoading, setDLoading] = useState(false);

  const fetchDaily = useCallback(
    async (signal?: AbortSignal) => {
      setDErr(null);
      if (!serverId) {
        setDaily(null);
        return;
      }
      setDLoading(true);
      try {
        const qs = new URLSearchParams({ serverId, bucket: "day", from: toIso(dayFrom), to: toIso(dayTo) });
        const r = await fetch(`/api/metrics/sai/series?${qs.toString()}`, { cache: "no-store", signal });
        const js: SeriesRes = await r.json();
        if (!r.ok || !js.ok) throw new Error(js?.error || `fetch failed: ${r.status}`);
        setDaily(js);
      } catch (e: any) {
        if (String(e?.name) !== "AbortError") setDErr(String(e?.message ?? e));
        setDaily(null);
      } finally {
        setDLoading(false);
      }
    },
    [serverId, dayFrom, dayTo]
  );

  useEffect(() => {
    const ac = new AbortController();
    fetchDaily(ac.signal);
    return () => ac.abort();
  }, [fetchDaily]);
  useEffect(() => {
    if (!autoDaily) return;
    const id = setInterval(() => fetchDaily(), REFRESH_DAILY_MS);
    return () => clearInterval(id);
  }, [autoDaily, fetchDaily]);

  /** 日→SAI マップ（dayTo の直前1日が1点になる実装に合わせる） */
  const dailyMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of daily?.series || []) {
      const end = new Date(p.t); // バケット終端（翌日の0時相当）
      const begin = startOfDay(addDays(end, -1));
      m.set(begin.toISOString(), clamp(Math.round(p.sai), 0, 100));
    }
    return m;
  }, [daily]);

  /** ====== 共通：SVG レンダリング（currentColor でダークモード準拠） ====== */
  const { ref: wrapW, width: WW } = useContainerWidth(420);
  const { ref: wrapD, width: WD } = useContainerWidth(420);

  function ChartWeekly() {
    const W = WW,
      H = clamp(Math.round(W * 0.42), 300, 560);
    const PAD_L = 68,
      PAD_R = 24,
      PAD_T = 28,
      PAD_B = 116;
    const X0 = PAD_L,
      XMAX = W - PAD_R,
      Y0 = H - PAD_B,
      YMIN = PAD_T;
    const xAt = (i: number) => (sundays.length <= 1 ? X0 : X0 + (i * (XMAX - X0)) / (sundays.length - 1));
    const yAt = (v: number) => {
      const t = clamp(v, 0, 100);
      return Y0 - (t / 100) * (Y0 - YMIN);
    };
    const yTicks = [0, 20, 40, 60, 80, 100];

    const MIN_LABEL_GAP = clamp(Math.round(W / 14), 64, 120);
    const labelIdx = useMemo(() => {
      if (sundays.length <= 1) return [0];
      const out: number[] = [];
      let last = -Infinity;
      sundays.forEach((_, i) => {
        const x = xAt(i);
        if (x - last >= MIN_LABEL_GAP || i === 0 || i === sundays.length - 1) {
          out.push(i);
          last = x;
        }
      });
      return out;
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [W, sundays.length]);

    const pathD = useMemo(() => {
      let path = "";
      sundays.forEach((sun, i) => {
        const val = weeklyMap.get(sun.toISOString());
        if (val == null) return;
        const x = xAt(i).toFixed(1),
          y = yAt(val).toFixed(1);
        path += path ? ` L ${x} ${y}` : `M ${x} ${y}`;
      });
      return path;
    }, [sundays, weeklyMap]);

    return (
      <div ref={wrapW} className="border border-gray-200 dark:border-zinc-700 rounded p-4 bg-white dark:bg-zinc-900 text-current">
        <div className="mb-2 text-sm text-gray-700 dark:text-gray-300">
          週次SAI（原点: {dtfDate.format(anchor)} ／ 範囲: {dtfDate.format(anchor)}～{dtfDate.format(addDays(rightEdge, -1))}）
        </div>
        <svg width={W} height={H} className="block" role="img" aria-label="Weekly SAI (from first message + 1 week)">
          <line x1={X0} y1={YMIN} x2={X0} y2={Y0} stroke="currentColor" strokeWidth={2} />
          <line x1={X0} y1={Y0} x2={XMAX} y2={Y0} stroke="currentColor" strokeWidth={2} />
          {yTicks.map((t, i) => {
            const y = yAt(t);
            return (
              <g key={`wy-${i}`}>
                <line x1={X0} y1={y} x2={XMAX} y2={y} stroke="currentColor" strokeWidth={0.8} opacity={t % 40 === 0 ? 0.35 : 0.18} strokeDasharray="4 4" />
                <text fill="currentColor" x={X0 - 10} y={y} textAnchor="end" dominantBaseline="middle" fontSize={12}>
                  {t}
                </text>
              </g>
            );
          })}
          {sundays.map((sun, i) => {
            const x = xAt(i);
            const show = labelIdx.includes(i);
            return (
              <g key={`wx-${sun.toISOString()}`}>
                <line x1={x} y1={Y0} x2={x} y2={Y0 + 6} stroke="currentColor" />
                {show && (
                  <g transform={`translate(${x}, ${Y0 + 10}) rotate(-38)`}>
                    <text fill="currentColor" textAnchor="end" fontSize={12}>
                      {fmtMD(sun)}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
          {pathD && <path d={pathD} fill="none" stroke="currentColor" strokeWidth={2.4} />}
          {sundays.map((sun, i) => {
            const v = weeklyMap.get(sun.toISOString());
            if (v == null) return null;
            return <circle key={`wp-${i}`} cx={xAt(i)} cy={yAt(v)} r={3.5} fill="currentColor" />;
          })}
          <text fill="currentColor" x={X0 - 46} y={(Y0 + YMIN) / 2} textAnchor="middle" transform={`rotate(-90 ${X0 - 46}, ${(Y0 + YMIN) / 2})`} fontSize={12}>
            SAI（0–100）
          </text>
          <text fill="currentColor" x={(X0 + XMAX) / 2} y={H - 12} textAnchor="middle" fontSize={12}>
            日付（各週の日曜日）
          </text>
        </svg>
        <div className="mt-3 flex items-center gap-3 text-sm">
          <label className="inline-flex items-center gap-1 select-none">
            <input type="checkbox" checked={autoWeekly} onChange={(e) => setAutoWeekly(e.target.checked)} />
            自動更新（10分）
          </label>
          <button className="border border-gray-300 dark:border-zinc-700 rounded px-3 py-1 bg-white dark:bg-zinc-900" onClick={() => fetchWeekly()} disabled={wLoading || !serverId}>
            手動更新
          </button>
          <span className="text-xs opacity-70" suppressHydrationWarning>
            最終更新: {mounted ? dtfFull.format(new Date()) : ""}
          </span>
        </div>
      </div>
    );
  }

  function ChartDaily() {
    const W = WD,
      H = clamp(Math.round(W * 0.38), 280, 520);
    const PAD_L = 68,
      PAD_R = 24,
      PAD_T = 28,
      PAD_B = 90;
    const X0 = PAD_L,
      XMAX = W - PAD_R,
      Y0 = H - PAD_B,
      YMIN = PAD_T;
    const xAt = (i: number) => (days.length <= 1 ? X0 : X0 + (i * (XMAX - X0)) / (days.length - 1));
    const yAt = (v: number) => {
      const t = clamp(v, 0, 100);
      return Y0 - (t / 100) * (Y0 - YMIN);
    };
    const yTicks = [0, 20, 40, 60, 80, 100];

    const pathD = useMemo(() => {
      let path = "";
      days.forEach((day, i) => {
        const v = dailyMap.get(startOfDay(day).toISOString());
        if (v == null) return;
        const x = xAt(i).toFixed(1),
          y = yAt(v).toFixed(1);
        path += path ? ` L ${x} ${y}` : `M ${x} ${y}`;
      });
      return path;
    }, [days, dailyMap]);

    return (
      <div ref={wrapD} className="border border-gray-200 dark:border-zinc-700 rounded p-4 bg-white dark:bg-zinc-900 text-current">
        <div className="mb-2 text-sm text-gray-700 dark:text-gray-300">
          直近7日SAI（{dtfDate.format(days[0] ?? addDays(now, -7))} ～ {dtfDate.format(days[days.length - 1] ?? now)}）
        </div>
        <svg width={W} height={H} className="block" role="img" aria-label="Daily SAI (last 7 days)">
          <line x1={X0} y1={YMIN} x2={X0} y2={Y0} stroke="currentColor" strokeWidth={2} />
          <line x1={X0} y1={Y0} x2={XMAX} y2={Y0} stroke="currentColor" strokeWidth={2} />
          {yTicks.map((t, i) => {
            const y = yAt(t);
            return (
              <g key={`dy-${i}`}>
                <line x1={X0} y1={y} x2={XMAX} y2={y} stroke="currentColor" strokeWidth={0.8} opacity={t % 40 === 0 ? 0.35 : 0.18} strokeDasharray="4 4" />
                <text fill="currentColor" x={X0 - 10} y={y} textAnchor="end" dominantBaseline="middle" fontSize={12}>
                  {t}
                </text>
              </g>
            );
          })}
          {days.map((d, i) => (
            <g key={`dx-${d.toISOString()}`}>
              <line x1={xAt(i)} y1={Y0} x2={xAt(i)} y2={Y0 + 6} stroke="currentColor" />
              <text fill="currentColor" x={xAt(i)} y={Y0 + 18} textAnchor="middle" fontSize={12}>
                {fmtMD(d)}
              </text>
            </g>
          ))}
          {pathD && <path d={pathD} fill="none" stroke="currentColor" strokeWidth={2.2} />}
          {days.map((d, i) => {
            const v = dailyMap.get(startOfDay(d).toISOString());
            if (v == null) return null;
            return <circle key={`dp-${i}`} cx={xAt(i)} cy={yAt(v)} r={3.5} fill="currentColor" />;
          })}
          <text fill="currentColor" x={X0 - 46} y={(Y0 + YMIN) / 2} textAnchor="middle" transform={`rotate(-90 ${X0 - 46}, ${(Y0 + YMIN) / 2})`} fontSize={12}>
            SAI（0–100）
          </text>
          <text fill="currentColor" x={(X0 + XMAX) / 2} y={H - 12} textAnchor="middle" fontSize={12}>
            日付（直近7日）
          </text>
        </svg>
        <div className="mt-3 flex items-center gap-3 text-sm">
          <label className="inline-flex items-center gap-1 select-none">
            <input type="checkbox" checked={autoDaily} onChange={(e) => setAutoDaily(e.target.checked)} />
            自動更新（2分）
          </label>
          <button className="border border-gray-300 dark:border-zinc-700 rounded px-3 py-1 bg-white dark:bg-zinc-900" onClick={() => fetchDaily()} disabled={dLoading || !serverId}>
            手動更新
          </button>
          <span className="text-xs opacity-70" suppressHydrationWarning>
            最終更新: {mounted ? dtfFull.format(new Date()) : ""}
          </span>
        </div>
      </div>
    );
  }

  return (
    <main className="p-6 space-y-6 min-h-screen text-gray-900 dark:text-gray-100 bg-white dark:bg-zinc-950">
      <h1 className="text-3xl font-bold">Discord ダッシュボード</h1>

      <div className="text-sm text-gray-700 dark:text-gray-300 flex flex-wrap gap-3 items-center">
        <div>
          Server ID: <code className="text-xs">{serverId || "(unset)"}</code>
        </div>
        <div>
          原点（保存先）:{" "}
          <code className="text-xs">
            {anchorIso ? dtfDate.format(new Date(anchorIso)) : "検出中…"}
          </code>
        </div>
      </div>

      {/* 週次（原点→9週間。空白は点なしで表示） */}
      <ChartWeekly />

      {/* 直近7日の日次 */}
      <ChartDaily />
    </main>
  );
}

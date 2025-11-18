// src/app/api/metrics/user/radar/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const ROUTE_VERSION = "v1-radar-usr";

type Metric = "sai" | "topic" | "info" | "empathy" | "question";

/**
 * 正規化ヘルパ：0..1 にクランプ → 0..100 丸め
 */
function to100(x: number) {
  const v = Math.max(0, Math.min(1, x));
  return Math.round(v * 100);
}

/**
 * ラベルを1つに正規化（Message.labels の最新を採用）
 */
function pickLabel(m: any): string | null {
  const lab = m?.labels?.[0]?.label ?? null;
  return lab;
}

/**
 * ユーザー指標の計算
 * - 期間中の自分の発言のみ（authorIsBot=false を自動除外）
 * - sai_user: 期間内の発言頻度/日 + ラベル多様性（平滑化）を合成（0..100）
 * - 話題力:   TP 割合（0..100）
 * - もの知り: S  割合（0..100）
 * - 共感力:   (AG + EM) 割合（0..100）
 * - 質問力:   Q  割合（0..100）
 */
function computeScores(rows: Array<{ createdAt: bigint; label: string | null }>, fromMs: number, toMs: number) {
  const msgs = rows.length;
  const days = Math.max(1, Math.ceil((toMs - fromMs) / (24 * 60 * 60 * 1000)));

  // ラベル分布
  const cnt = new Map<string, number>();
  for (const r of rows) {
    const lab = (r.label || "CH").toUpperCase();
    cnt.set(lab, (cnt.get(lab) ?? 0) + 1);
  }
  const get = (k: string) => cnt.get(k) ?? 0;
  const tp = get("TP"), s = get("S"), ag = get("AG"), em = get("EM"), q = get("Q");

  const msgPerDay = msgs / days;
  // 1日5発言で満点相当（上限キャップ）
  const msg_rate01 = Math.min(1, msgPerDay / 5);

  // ラベル多様性（ユーザーの発言に基づく）: H / log(K) を 0..1 に
  const total = Array.from(cnt.values()).reduce((a, b) => a + b, 0) || 1;
  const probs = Array.from(cnt.values()).map(v => v / total);
  const H = -probs.reduce((s, p) => (p > 0 ? s + p * Math.log2(p) : s), 0);
  const K = Math.max(1, cnt.size);
  const diversity01 = K > 1 ? Math.min(1, H / Math.log2(K)) : 0;

  // sai_user: 発言頻度×0.6 + 多様性×0.4（軽くスムージング）
  const sai01 = 0.6 * msg_rate01 + 0.4 * diversity01;

  // 各ラベル比率（分母は自分の発言数）
  const ratio = (x: number) => (msgs > 0 ? x / msgs : 0);
  const topic01 = ratio(tp);
  const info01 = ratio(s);
  const empathy01 = ratio(ag + em);
  const question01 = ratio(q);

  const out = {
    sai: to100(sai01),
    topic: to100(topic01),
    info: to100(info01),
    empathy: to100(empathy01),
    question: to100(question01),
    base: { msgs, days }
  };
  return out;
}

/**
 * シンプルSVGレーダー（5軸）
 * 軸順：sai(上) → topic → info → empathy → question（時計回り）
 */
function makeRadarSVG(scores: Record<Metric, number>, title: string, subtitle: string) {
  const W = 520, H = 520, CX = W/2, CY = H/2, R = 190;
  const axes: Array<{ key: Metric; label: string }> = [
    { key: "sai",      label: "サーバー貢献度" },
    { key: "topic",    label: "話題力" },
    { key: "info",     label: "もの知り" },
    { key: "empathy",  label: "共感力" },
    { key: "question", label: "質問力" },
  ];

  // 角度は上(= -90°)から時計回り
  const ang = (i: number) => (-90 + i * (360 / axes.length)) * Math.PI / 180;

  // 同心グリッド 20刻み
  const rings = [20,40,60,80,100];

  const pts = axes.map((ax, i) => {
    const a = ang(i);
    const r = R * (Math.max(0, Math.min(100, scores[ax.key])) / 100);
    const x = CX + r * Math.cos(a);
    const y = CY + r * Math.sin(a);
    return { x, y };
  });

  const poly = pts.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");

  const axisLines = axes.map((ax, i) => {
    const a = ang(i);
    const x = CX + R * Math.cos(a);
    const y = CY + R * Math.sin(a);
    return `<line x1="${CX}" y1="${CY}" x2="${x}" y2="${y}" stroke="#999" stroke-width="1"/>`;
  }).join("\n");

  const ringPolys = rings.map(rp => {
    const rr = R * (rp/100);
    const ptsR = axes.map((ax,i)=>{
      const a = ang(i);
      const x = CX + rr * Math.cos(a);
      const y = CY + rr * Math.sin(a);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
    return `<polygon points="${ptsR}" fill="none" stroke="#ddd" stroke-width="1"/>`;
  }).join("\n");

  const axisLabels = axes.map((ax,i)=>{
    const a = ang(i);
    const x = CX + (R + 28) * Math.cos(a);
    const y = CY + (R + 28) * Math.sin(a);
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="13" text-anchor="middle" dominant-baseline="middle" fill="#333">${ax.label}</text>`;
  }).join("\n");

  const valueDots = pts.map(p=> `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3" fill="#2b6cb0"/>`).join("\n");

  const valueLabels = axes.map((ax,i)=>{
    const a = ang(i);
    const r = R * (Math.max(0, Math.min(100, scores[ax.key])) / 100);
    const x = CX + (r + 18) * Math.cos(a);
    const y = CY + (r + 18) * Math.sin(a);
    const v = scores[ax.key];
    return `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="12" text-anchor="middle" dominant-baseline="middle" fill="#2b6cb0">${v}</text>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="#fff"/>
  <text x="${W/2}" y="36" text-anchor="middle" font-size="18" font-weight="700" fill="#111">${title}</text>
  <text x="${W/2}" y="58" text-anchor="middle" font-size="12" fill="#666">${subtitle}</text>

  <g>
    ${ringPolys}
    ${axisLines}
    <polygon points="${poly}" fill="rgba(66,135,245,0.20)" stroke="#2b6cb0" stroke-width="2"/>
    ${valueDots}
    ${axisLabels}
    ${valueLabels}
  </g>

  <text x="${W-10}" y="${H-10}" text-anchor="end" font-size="10" fill="#999">radar:v1 • ${ROUTE_VERSION}</text>
</svg>`;
}

/** util */
function json(body: any, status=200) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: {
      "content-type":"application/json; charset=utf-8",
      "cache-control":"no-store",
      "x-route-version": ROUTE_VERSION,
    }
  });
}

export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const serverId = (url.searchParams.get("serverId")
      || process.env.SERVER_ID
      || process.env.NEXT_PUBLIC_SERVER_ID
      || "").trim();
    const userId = (url.searchParams.get("userId") || "").trim();
    if (!serverId) throw new Error("serverId required");
    if (!userId)   throw new Error("userId required");

    const days = Math.max(1, Math.min(90, Number(url.searchParams.get("days") || "30")));
    const to = new Date();
    const from = new Date(to.getTime() - days*24*60*60*1000);

    // 対象ユーザーの自発言（Bot除外）。最新ラベル1件だけ join
    const rows = await prisma.message.findMany({
      where: {
        serverId,
        authorId: userId,
        authorIsBot: false,
        createdAt: { gte: BigInt(from.getTime()), lte: BigInt(to.getTime()) },
        excludedFromMetrics: false,
      },
      orderBy: { createdAt: "asc" },
      select: {
        createdAt: true,
        labels: { orderBy: { createdAt: "desc" }, take: 1, select: { label:true } }
      }
    });

    // 正規化して計算
    const prepared = rows.map(r => ({
      createdAt: r.createdAt as unknown as bigint,
      label: r.labels?.[0]?.label ?? null
    }));

    const scores = computeScores(prepared, from.getTime(), to.getTime());

    // 出力形式：?format=json でJSON、デフォルトはSVG
    const fmt = (url.searchParams.get("format") || "svg").toLowerCase();
    if (fmt === "json") {
      return json({ ok:true, serverId, userId, days, scores });
    }

    const title = "Server Radar (あなたの貢献プロファイル)";
    const subtitle = `期間: 過去${days}日 | 発言数: ${scores.base.msgs} | 多様性係数込み`;

    const svg = makeRadarSVG(
      {
        sai: scores.sai,
        topic: scores.topic,
        info: scores.info,
        empathy: scores.empathy,
        question: scores.question
      },
      title, subtitle
    );

    return new NextResponse(svg, {
      status: 200,
      headers: {
        "content-type": "image/svg+xml; charset=utf-8",
        "cache-control": "no-store",
        "x-route-version": ROUTE_VERSION,
      }
    });

  } catch (e:any) {
    return json({ ok:false, error: String(e?.message || e) }, 400);
  }
}

export function POST(req: NextRequest){ return GET(req); }

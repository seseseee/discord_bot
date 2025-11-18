// src/app/api/metrics/sai/series/route.ts
//
// チャンネル/サーバーごとの「サーバー活性化度(SAI)」の時系列を返すAPI。
// - 集計バケット: hour / day / week
// - 返却: [{ t: ISO時刻(バケット末端), sai: 0-100, counts: { messages, users }}]
//
// 主な処理フロー：
//   1. リクエストパラメータを解釈（serverId, channelId, from, to, bucket）
//   2. Prismaで該当メッセージを取得（ms精度とs精度の両方を考慮）
//   3. 重複排除しつつ {authorId, tsMs, label} に正規化し昇順ソート
//   4. 時間バケットに分割し、各バケットでSAIを計算
//   5. seriesとして返却
//
// SAI(Server Activation Index) は 0-100 のスコア。
// 内部では5つの下位指標を0〜1で計算し、重み付き平均をとり、それを0〜100にスケール:
//   score01 = w1*msg_rate + w2*user_diversity + w3*turn_taking + w4*burst_inverse + w5*topical_variety
//   sai = round(clamp(score01,0,1) * 100)
//
// 各指標（0〜1）はざっくりこういう意味：
//   - msg_rate         : 発言密度（1分あたり発言数を正規化）
//   - user_diversity   : 「1人だけしゃべってないか？」のバランス
//   - turn_taking      : 会話のキャッチボール割合
//   - burst_inverse    : “間髪入れず1人が連投”ではなく“間があって交互に続くか”
//   - topical_variety  : 話題の多様性（ラベルのエントロピー）
//
// ※ dev環境などで createdAt が秒単位(BigInt秒)なレコードとms単位(BigIntミリ秒)なレコードが
//   両方存在する可能性があるので、DBから2回クエリしてIDでマージする。
//   normalizeMs() で ms に揃える。
// -----------------------------------------------------------------------------

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 変更管理用バージョンヘッダ
const ROUTE_VERSION = "v2.4-sai-cleaned";

// バケット種別
type Bucket = "hour" | "day" | "week";

// 返却用の1ポイント
interface SaiPoint {
  t: string; // バケットの終端時刻 (ISO8601)
  sai: number; // 0-100
  counts: {
    messages: number;
    users: number;
  };
}

// メッセージの最小形
interface RowNorm {
  authorId: string;
  tsMs: number;
  label: string | null;
}

// .env から分析用チャンネル (提案カードを投げる専用ch) を取得
// channelId未指定時はこのchをメトリクスから除外することで、
// "人の会話"だけをベースにSAIを計算する意図。
const ANALYSIS_CH =
  process.env.ANALYSIS_CHANNEL_ID ||
  process.env.DISCORD_ANALYSIS_CHANNEL_ID ||
  "";

/* ──────────────────────────────────────────
 * HTTPレスポンスユーティリティ
 * ──────────────────────────────────────────*/
function json(body: any, status = 200) {
  return new NextResponse(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
      "X-Route-Version": ROUTE_VERSION,
    },
  });
}

/* ──────────────────────────────────────────
 * リクエストパラメータの取り出し
 * ──────────────────────────────────────────*/

/**
 * serverId の解決:
 * - ?serverId=... があれば優先
 * - なければ .env(SERVER_ID / NEXT_PUBLIC_SERVER_ID / COMMAND_GUILD_ID)
 * - それも無い場合はエラー
 */
function getServerId(req: NextRequest) {
  const url = new URL(req.url);
  const q = url.searchParams.get("serverId")?.trim();
  const env =
    process.env.SERVER_ID ||
    process.env.NEXT_PUBLIC_SERVER_ID ||
    process.env.COMMAND_GUILD_ID ||
    "";
  const id = (q || env || "").trim();
  if (!id) throw new Error("serverId が必要です（?serverId=... か .env）");
  return id;
}

/**
 * channelId の解決:
 * - ?channelId=... or ?channel=...
 * - "all"/"null"/"" は undefined 扱い（全チャンネル集計）
 */
function getChannel(req: NextRequest) {
  const url = new URL(req.url);
  const ch = url.searchParams.get("channelId") || url.searchParams.get("channel");
  if (!ch) return undefined;
  const v = ch.trim().toLowerCase();
  return v === "" || v === "all" || v === "null" ? undefined : ch.trim();
}

/**
 * from/to:
 * - ISO文字列 or ミリ秒/日付パース可能な文字列
 * - 未指定なら過去30日間
 * - from > to はエラー
 */
function parseDates(req: NextRequest) {
  const url = new URL(req.url);
  const toStr = url.searchParams.get("to");
  const fromStr = url.searchParams.get("from");

  const to = toStr ? new Date(toStr) : new Date();
  const from = fromStr ? new Date(fromStr) : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);

  if (Number.isNaN(+from) || Number.isNaN(+to)) {
    throw new Error("from/to が不正です");
  }
  if (from > to) throw new Error("from は to より過去である必要があります");

  return { from, to };
}

/**
 * バケット解釈とステップ幅（ms）取得
 */
function getBucketInfo(req: NextRequest) {
  const url = new URL(req.url);
  const bucketRaw = (url.searchParams.get("bucket") || "day").toLowerCase();
  const bucket: Bucket = bucketRaw === "hour" ? "hour"
                    : bucketRaw === "week" ? "week"
                    : "day";

  const minutes =
    bucket === "hour"
      ? 60
      : bucket === "week"
      ? 7 * 24 * 60
      : 24 * 60;

  const stepMs = minutes * 60 * 1000;
  return { bucket, stepMs, stepMinutes: minutes };
}

/* ──────────────────────────────────────────
 * ユーティリティ
 * ──────────────────────────────────────────*/

/**
 * createdAt(BigInt) を JSのms精度numberに正規化
 * - Discord Snowflake由来などで 10桁 (秒) の可能性もあるのでケア
 */
function normalizeMs(bi: bigint): number {
  const n = Number(bi);
  // "秒" っぽい（10桁 ≒ < 1e12）ならミリ秒に直す
  return n < 1_000_000_000_000 ? n * 1000 : n;
}

/**
 * SAI計算ロジック
 *
 * rows: そのバケットに属するメッセージ列（時系列順）
 * fromMs/toMs: バケットの開始/終了 (ms)
 */
function calcSAI(
  rows: RowNorm[],
  fromMs: number,
  toMs: number
) {
  // 下位指標を全部0〜1に正規化し、重みづけ合成する。

  const N = rows.length;
  const users = new Set(rows.map((r) => r.authorId)).size;

  // (1) 発言密度: 1分あたりのメッセージ数を最大2msg/minでクリップ
  const minutes = Math.max(1, (toMs - fromMs) / 60000);
  const msg_per_min = N / minutes;
  const msg_rate = Math.min(1, msg_per_min / 2.0); // 2msg/min以上はもう1扱い

  // (2) user_diversity: バランス（1人だけの独壇場を下げたい）
  //    ここでは「ユニークユーザー/総発言数」で近似。全員が1回ずつ喋れば1に近い。
  const user_diversity = N > 0 ? Math.min(1, users / N) : 0;

  // (3) turn_taking: 直前発言者と違う人が続く割合
  let turnChanges = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].authorId !== rows[i - 1].authorId) turnChanges++;
  }
  const turn_taking =
    rows.length > 1 ? Math.min(1, turnChanges / (rows.length - 1)) : 0;

  // (4) burst_inverse:
  //    連投(=すごい短い間隔で同じ人が連続投稿)が続くほど 0 に寄せたい。
  //    gaps(秒)が揃って短すぎると低スコア。バラけている/ゆっくり回ってると高スコア。
  const gapsSec: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    gapsSec.push((rows[i].tsMs - rows[i - 1].tsMs) / 1000);
  }
  let burst_inverse = 0;
  if (gapsSec.length >= 2) {
    const sorted = [...gapsSec].sort((a, b) => a - b);
    const med = sorted[Math.floor(sorted.length / 2)];
    const mean = gapsSec.reduce((a, b) => a + b, 0) / gapsSec.length;
    // med/mean が1に近いほど「一定ペースで回ってる」=健全とみなす
    // meanが極端に0付近なら0扱い
    burst_inverse = Math.min(1, mean > 0 ? med / mean : 0);
  }

  // (5) topical_variety: ラベルの多様性（カテゴリのエントロピーを正規化）
  const cnt = new Map<string, number>();
  for (const r of rows) {
    const lab = r.label || "CH"; // 未ラベルは雑談CH相当
    cnt.set(lab, (cnt.get(lab) ?? 0) + 1);
  }
  const total = Array.from(cnt.values()).reduce((a, b) => a + b, 0);
  const probs = Array.from(cnt.values()).map((v) => v / Math.max(1, total));
  // シャノンエントロピー(log2)
  const H = -probs.reduce((s, p) => (p > 0 ? s + p * Math.log2(p) : s), 0);
  const maxH = Math.log2(Math.max(1, cnt.size)); // 理論上の最大多様性
  const topical_variety = maxH > 0 ? Math.min(1, H / maxH) : 0;

  // 重み。変えたいときはここをいじれば全体スケールに反映される。
  const WEIGHTS = {
    msg_rate:         0.28,
    user_diversity:   0.22,
    turn_taking:      0.18,
    burst_inverse:    0.16,
    topical_variety:  0.16,
  } as const;

  // 0〜1 合成スコア
  const score01 =
    msg_rate        * WEIGHTS.msg_rate +
    user_diversity  * WEIGHTS.user_diversity +
    turn_taking     * WEIGHTS.turn_taking +
    burst_inverse   * WEIGHTS.burst_inverse +
    topical_variety * WEIGHTS.topical_variety;

  // 0〜100 にスケールし四捨五入
  const sai = Math.round(Math.min(1, Math.max(0, score01)) * 100);

  return {
    sai,
    counts: {
      messages: N,
      users,
    },
  };
}

/* ──────────────────────────────────────────
 * DBクエリ & 正規化
 * ──────────────────────────────────────────*/

/**
 * Prismaから対象メッセージを取得して正規化する。
 * - ms精度レコードと秒精度レコードを両方拾ってマージ
 * - 分析CHの除外ロジックを反映
 */
async function fetchRowsNormalized(opts: {
  serverId: string;
  channelId?: string;
  fromMs: number;
  toMs: number;
}) {
  const { serverId, channelId, fromMs, toMs } = opts;

  // "どのメッセージを集計対象にするか" の共通条件
  // - 指定サーバ
  // - Bot発言や excludedFromMetrics=true は除外
  // - channelId が指定されてなければ、分析CHは除外（人間の会話だけの活性度を測りたい）
  const whereBase: any = {
    serverId,
    excludedFromMetrics: false,
    authorIsBot: false,
  };
  if (channelId) {
    // 明示的にチャンネルを指定された場合は、そのチャンネルをそのまま見る。
    // つまり分析CHも指定されたなら含まれる。
    whereBase.channelId = channelId;
  } else if (ANALYSIS_CH) {
    // チャンネル未指定のときだけ、分析チャンネルを除外する。
    whereBase.NOT = { channelId: ANALYSIS_CH };
  }

  // createdAt が BigInt で入っていることを想定。
  // ただし、millisecond精度(13桁)で入ったものと
  // second精度(10桁)で入ったものが混在し得るため、2領域で照会する。
  // 1) ms帯 [fromMs, toMs] をそのまま
  const msRange = { gte: BigInt(fromMs), lte: BigInt(toMs) };
  const msRows = await prisma.message.findMany({
    where: { ...whereBase, createdAt: msRange },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      authorId: true,
      createdAt: true,
      labels: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { label: true },
      },
    },
  });

  // 2) 秒帯 [fromMs/1000, toMs/1000] でもう1回
  const secRange = {
    gte: BigInt(Math.floor(fromMs / 1000)),
    lte: BigInt(Math.floor(toMs / 1000)),
  };
  const secRows = await prisma.message.findMany({
    where: { ...whereBase, createdAt: secRange },
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      authorId: true,
      createdAt: true,
      labels: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { label: true },
      },
    },
  });

  // マージ：同じidは1回だけ、createdAtはmsに揃える
  const merged = new Map<string, RowNorm>();
  for (const m of msRows.concat(secRows)) {
    if (merged.has(m.id)) continue;
    merged.set(m.id, {
      authorId: m.authorId,
      tsMs: normalizeMs(m.createdAt as unknown as bigint),
      label: m.labels?.[0]?.label ?? null,
    });
  }

  // 昇順ソート
  const rows = Array.from(merged.values()).sort((a, b) => a.tsMs - b.tsMs);
  return rows;
}

/* ──────────────────────────────────────────
 * メイン: GET
 * ──────────────────────────────────────────*/
export async function GET(req: NextRequest) {
  try {
    const url = new URL(req.url);
    const DEBUG = url.searchParams.get("debug") === "1";

    const serverId = getServerId(req);
    const channelId = getChannel(req);
    const { from, to } = parseDates(req);
    const { bucket, stepMs, stepMinutes } = getBucketInfo(req);

    const fromMs = from.getTime();
    const toMs = to.getTime();

    // 対象メッセージ正規化取得
    const rows = await fetchRowsNormalized({
      serverId,
      channelId,
      fromMs,
      toMs,
    });

    // 行が0なら空配列返し（必要に応じてdebug情報を返す）
    if (rows.length === 0) {
      if (DEBUG) {
        const total = await prisma.message.count({ where: { serverId } });
        const inclHuman = await prisma.message.count({
          where: {
            serverId,
            excludedFromMetrics: false,
            authorIsBot: false,
          },
        });

        const whereBaseCount: any = {
          serverId,
          excludedFromMetrics: false,
          authorIsBot: false,
        };
        if (channelId) {
          whereBaseCount.channelId = channelId;
        } else if (ANALYSIS_CH) {
          whereBaseCount.NOT = { channelId: ANALYSIS_CH };
        }

        const msRange = { gte: BigInt(fromMs), lte: BigInt(toMs) };
        const secRange = {
          gte: BigInt(Math.floor(fromMs / 1000)),
          lte: BigInt(Math.floor(toMs / 1000)),
        };

        const inMsRange = await prisma.message.count({
          where: { ...whereBaseCount, createdAt: msRange },
        });
        const inSecRange = await prisma.message.count({
          where: { ...whereBaseCount, createdAt: secRange },
        });

        return json({
          ok: true,
          meta: {
            serverId,
            channelId: channelId ?? null,
            bucket,
            bucketMinutes: stepMinutes,
            from: from.toISOString(),
            to: to.toISOString(),
            debug: true,
          },
          debugCounts: {
            total,
            inclHuman,
            inMsRange,
            inSecRange,
          },
          series: [] as SaiPoint[],
        });
      }

      return json({
        ok: true,
        meta: {
          serverId,
          channelId: channelId ?? null,
          bucket,
          bucketMinutes: stepMinutes,
          from: from.toISOString(),
          to: to.toISOString(),
        },
        series: [] as SaiPoint[],
      });
    }

    // バケットごとに rows を切り出して SAI を計算
    const series: SaiPoint[] = [];
    let t0 = fromMs;
    let i = 0; // rows上の走査ポインタ（昇順で一周で済ませる）

    while (t0 < toMs) {
      const t1 = Math.min(t0 + stepMs, toMs);

      const bucketRows: RowNorm[] = [];
      // rows[i].tsMs < t1 の間は候補
      // tsMs >= t0 のものだけpush
      while (i < rows.length && rows[i].tsMs < t1) {
        if (rows[i].tsMs >= t0) {
          bucketRows.push(rows[i]);
        }
        i++;
      }

      const r = calcSAI(bucketRows, t0, t1);
      series.push({
        t: new Date(t1).toISOString(),
        sai: r.sai,
        counts: r.counts,
      });

      t0 = t1;
    }

    return json({
      ok: true,
      meta: {
        serverId,
        channelId: channelId ?? null,
        bucket,
        bucketMinutes: stepMinutes,
        from: from.toISOString(),
        to: to.toISOString(),
      },
      series,
    });
  } catch (err: any) {
    return json(
      { ok: false, error: String(err?.message ?? err) },
      400
    );
  }
}

// POST も同じ処理を許可（利便性のため）
export function POST(req: NextRequest) {
  return GET(req);
}

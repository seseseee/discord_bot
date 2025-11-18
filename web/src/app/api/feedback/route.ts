// src/app/api/feedback/route.ts
import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import type { Label } from "@/lib/rules";
import { LABELS } from "@/lib/rules";
import { normalizeFeedbackLabel, normalizeFeedbackLabelMany } from "@/lib/normalizeLabel";
import type { Prisma } from "@prisma/client";

export const runtime = "nodejs";

/* ─────────────────────────────────────────────────────────────
 * Settings / Guards
 * ────────────────────────────────────────────────────────────*/
const FEEDBACK_API_KEY =
  process.env.FEEDBACK_API_KEY ||
  process.env.ANALYZE_API_KEY ||
  "";

const TRUST_SET = new Set(
  (process.env.TRUST_USER_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
);

const MAX_LABELS_PER_FEEDBACK = Number(process.env.MAX_LABELS_PER_FEEDBACK ?? "4");
const MAX_NOTES_LEN = Number(process.env.MAX_FEEDBACK_NOTES_LEN ?? "500");
const PHRASE_MAX = Number(process.env.FEEDBACK_PHRASE_MAX ?? "140");

/* ─────────────────────────────────────────────────────────────
 * Utils
 * ────────────────────────────────────────────────────────────*/

/** 与えられた複数ラベルで構成比を均等配分（作成時の即時反映用） */
function evenComposition(labels: Label[]): { label: Label; pct: number }[] {
  const set = Array.from(new Set(labels));
  if (set.length === 0) return LABELS.map((l) => ({ label: l, pct: 0 }));
  const per = Math.round((100 / set.length) * 100) / 100;
  const map = new Map<Label, number>();
  for (const l of set) map.set(l, per);
  return LABELS.map((l) => ({ label: l, pct: map.get(l) ?? 0 }));
}

/** 正規表現エスケープ */
function escapeRegExp(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** “ほぼ同じ言い回し”を拾うゆるい完全一致のパターンを生成（保存は原文ベース） */
function buildTriggerPattern(phraseRaw: string): string {
  const t = (phraseRaw || "").trim();
  if (!t) return "";
  const esc = escapeRegExp(t);
  // 末尾の !？w/ｗ と空白を許容
  return `^${esc}(?:[!！?？ｗw]*\\s*)$`;
}

/** NFKC 正規化（照合用キー） */
function normalizeForMatch(s: string) {
  return (s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/** ラベル正規化（emoji / 英字 / パイプ区切り / 配列 → Label[]） */
function toLabels(raw: unknown): Label[] {
  const unique = new Set<Label>();
  const pushMany = (str: string) => {
    const many = normalizeFeedbackLabelMany(str);
    for (const l of many) {
      if ((LABELS as string[]).includes(l)) unique.add(l as Label);
    }
  };

  if (Array.isArray(raw)) {
    pushMany(raw.map(String).join("|"));
  } else {
    const s = String(raw ?? "").trim();
    if (s) {
      const many = normalizeFeedbackLabelMany(s);
      if (many.length > 0) {
        pushMany(s);
      } else {
        const one = normalizeFeedbackLabel(s);
        if (one && (LABELS as string[]).includes(one)) unique.add(one as Label);
      }
    }
  }
  return Array.from(unique);
}

/** ごみ箱リアクション検出（🗑️ / 🗑） */
function isTrashReaction(raw: unknown): boolean {
  const s = String(raw ?? "");
  return s.includes("🗑️") || s.includes("🗑");
}

function json(data: any, status = 200) {
  return new NextResponse(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

/** CORS preflight */
export async function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Cache-Control": "no-store",
    },
  });
}

/** 軽いリトライ（SQLite のロック/タイムアウトを吸収） */
async function withRetry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let lastErr: any;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const msg = String(e?.message || e);
      const transient =
        msg.includes("Transaction already closed") ||
        msg.includes("timeout") ||
        msg.includes("P2034") ||
        msg.includes("database is locked") ||
        msg.includes("SQLITE_BUSY");
      if (!transient || i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 200 * Math.pow(2, i))); // 200ms, 400ms, 800ms
      lastErr = e;
    }
  }
  throw lastErr;
}

/* ─────────────────────────────────────────────────────────────
 * Trigger helpers（学習の upsert / 減算）
 *  ※ phrase は「照合用キー（正規化）」を保存して一貫化
 * ────────────────────────────────────────────────────────────*/

async function upsertTriggerSafeTx(
  tx: Prisma.TransactionClient,
  data: {
    serverId: string;
    channelId?: string | null;
    /** 保存キー（normalizeForMatch 済み） */
    phrase: string;
    /** 表示/照合用の原文パターン */
    pattern: string;
    label: Label;
  }
) {
  try {
    return await tx.trigger.upsert({
      where: {
        serverId_phrase_label: {
          serverId: data.serverId,
          phrase: data.phrase, // 正規化キーを保存
          label: data.label,
        } as any,
      },
      update: {
        hits: { increment: 1 },
        weight: { increment: 0.2 },
      },
      create: {
        serverId: data.serverId,
        channelId: data.channelId ?? null,
        phrase: data.phrase, // 正規化キーを保存
        pattern: data.pattern, // 原文から生成
        label: data.label,
        hits: 1,
        weight: 1,
        createdAt: new Date(),
      },
    } as any);
  } catch {
    // フォールバック（複合 unique が未設定でも動作）
    const found = await tx.trigger.findFirst({
      where: { serverId: data.serverId, phrase: data.phrase, label: data.label },
      select: { id: true, hits: true, weight: true },
    });
    if (found) {
      const nextWeight = Math.min((found.weight ?? 1) + 0.2, 5);
      return tx.trigger.update({
        where: { id: found.id },
        data: { hits: (found.hits ?? 0) + 1, weight: nextWeight },
      });
    }
    return tx.trigger.create({
      data: {
        serverId: data.serverId,
        channelId: data.channelId ?? null,
        phrase: data.phrase,
        pattern: data.pattern,
        label: data.label,
        hits: 1,
        weight: 1,
        createdAt: new Date(),
      },
    });
  }
}

async function decrementTriggerTx(
  tx: Prisma.TransactionClient,
  opts: {
    serverId: string;
    channelId?: string | null;
    /** 保存キー（normalizeForMatch 済み） */
    phraseKey?: string;
    /** 互換用に原文キーも探索 */
    phraseRaw?: string;
    label: Label;
    by?: number;
  }
) {
  const { serverId, channelId, phraseKey, phraseRaw, label } = opts;
  const by = Math.max(1, Number(opts.by ?? 1));

  const tryFind = async (where: Prisma.TriggerWhereInput) =>
    tx.trigger.findFirst({ where, select: { id: true, hits: true, weight: true } });

  let t =
    (phraseKey && (await tryFind({ serverId, phrase: phraseKey, label, channelId: channelId ?? undefined }))) ||
    (phraseKey && (await tryFind({ serverId, phrase: phraseKey, label }))) ||
    (phraseRaw && (await tryFind({ serverId, phrase: phraseRaw, label, channelId: channelId ?? undefined }))) ||
    (phraseRaw && (await tryFind({ serverId, phrase: phraseRaw, label })));

  if (!t) return;

  const nextHits = Math.max(0, (t.hits ?? 0) - by);
  const nextWeight = Math.max(0, (t.weight ?? 0) - 0.2 * by);

  if (nextHits <= 0) {
    await tx.trigger.delete({ where: { id: t.id } });
  } else {
    await tx.trigger.update({
      where: { id: t.id },
      data: { hits: nextHits, weight: nextWeight },
    });
  }
}

/* ─────────────────────────────────────────────────────────────
 * Route
 * ────────────────────────────────────────────────────────────*/
export async function POST(req: NextRequest) {
  try {
    // APIキー（任意）：Authorization: Bearer <key>
    const auth = req.headers.get("authorization") || "";
    if (FEEDBACK_API_KEY && auth !== `Bearer ${FEEDBACK_API_KEY}`) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    const body = await req.json().catch(() => ({} as any));

    const messageId: string = String(body.messageId ?? "").trim();
    if (!messageId) return json({ ok: false, error: "missing messageId" }, 400);

    let notes: string | undefined = body.notes != null ? String(body.notes) : undefined;
    if (notes && notes.length > MAX_NOTES_LEN) notes = notes.slice(0, MAX_NOTES_LEN);

    const userId: string | undefined = body.userId != null ? String(body.userId) : undefined;

    // 信頼ユーザー制限（設定がある場合のみ有効）
    if (TRUST_SET.size > 0) {
      if (!userId) return json({ ok: false, error: "missing userId (trusted mode)" }, 403);
      if (!TRUST_SET.has(userId)) return json({ ok: false, error: "not trusted user" }, 403);
    }

    // メッセージ情報（serverId / channelId / 本文）
    const msg = await prisma.message.findUnique({
      where: { id: messageId },
      select: { id: true, serverId: true, channelId: true, contentText: true },
    });
    if (!msg) return json({ ok: false, error: "unknown messageId" }, 404);

    const serverId = String(msg.serverId);
    const channelId = msg.channelId ? String(msg.channelId) : null;

    // phrase（トリガ学習キー）: 明示指定 > メッセージ本文
    const messageText = String(body.messageText ?? msg.contentText ?? "");
    const phraseRaw = messageText.trim().slice(0, PHRASE_MAX);
    const phraseKey = normalizeForMatch(phraseRaw);
    const phraseForIndex = phraseKey || phraseRaw;

    const rawLabelInput: unknown = body.label ?? body.labels ?? body.emoji ?? "";

    // 🗑️ 取消（このユーザーのフィードバックを取り消し）
    if (isTrashReaction(rawLabelInput) || body.op === "delete") {
      if (!userId) return json({ ok: false, error: "missing userId for delete" }, 400);

      const labelsForDelete = toLabels(body.target ?? body.label ?? body.labels);
      const whereAny: any = { messageId, userId };
      if (labelsForDelete.length) whereAny.label = { in: labelsForDelete };

      // 先に対象を取得（ラベル別に減算するため）
      const target = await prisma.feedback.findMany({
        where: whereAny,
        select: { id: true, label: true },
      });
      if (target.length === 0) return json({ ok: true, deleted: 0, details: [] });

      await withRetry(async () => {
        await prisma.$transaction(
          async (tx) => {
            await tx.feedback.deleteMany({ where: { id: { in: target.map((t) => t.id) } } });

            if (phraseForIndex) {
              const byLabel = new Map<Label, number>();
              for (const row of target) {
                const lab = row.label as Label;
                if ((LABELS as string[]).includes(lab)) {
                  byLabel.set(lab, (byLabel.get(lab) ?? 0) + 1);
                }
              }
              for (const [lab, ct] of byLabel.entries()) {
                await decrementTriggerTx(tx, {
                  serverId,
                  channelId,
                  phraseKey: phraseKey || undefined,
                  phraseRaw: phraseRaw || undefined,
                  label: lab,
                  by: ct,
                });
              }
            }
          },
          { timeout: 10_000, maxWait: 10_000 }
        );
      }, 3);

      return json({
        ok: true,
        deleted: target.length,
        details: target.reduce<Record<string, number>>((acc, r) => {
          const k = r.label;
          acc[k] = (acc[k] ?? 0) + 1;
          return acc;
        }, {}),
      });
    }

    // 付与
    let labels = toLabels(rawLabelInput);
    if (labels.length > MAX_LABELS_PER_FEEDBACK) labels = labels.slice(0, MAX_LABELS_PER_FEEDBACK);
    if (labels.length === 0) return json({ ok: false, error: "invalid label" }, 400);

    // confidence は 0〜1 にクランプ
    const confidence: number | undefined =
      body.confidence != null && !Number.isNaN(Number(body.confidence))
        ? Math.max(0, Math.min(1, Number(body.confidence)))
        : undefined;

    const saved: Array<{ id: string; label: Label }> = [];
    const triggersUpserted: Array<{ label: Label }> = [];

    await withRetry(async () => {
      await prisma.$transaction(
        async (tx) => {
          // Feedback: (messageId, userId, label) を unique にしている想定
          for (const lab of labels) {
            try {
              const fb = await tx.feedback.upsert({
                where: ({
                  messageId_userId_label: {
                    messageId,
                    userId: userId ?? "",
                    label: lab,
                  },
                } as unknown) as Prisma.FeedbackWhereUniqueInput, // ← ★ unknown を挟んでキャスト
                create: {
                  messageId,
                  serverId,
                  channelId,
                  userId,
                  label: lab,
                  confidence,
                  notes,
                  createdAt: new Date(),
                },
                update: {
                  confidence: confidence ?? undefined,
                  notes: notes ?? undefined,
                },
              } as any);
              saved.push({ id: fb.id, label: lab });
            } catch {
              // 複合 unique が無い場合のフォールバック
              const existing = userId
                ? await tx.feedback.findFirst({ where: { messageId, userId, label: lab } })
                : null;

              if (existing) {
                const updated = await tx.feedback.update({
                  where: { id: existing.id },
                  data: {
                    confidence: confidence ?? existing.confidence ?? undefined,
                    notes: notes ?? existing.notes ?? undefined,
                  },
                });
                saved.push({ id: updated.id, label: lab });
              } else {
                const created = await tx.feedback.create({
                  data: {
                    messageId,
                    serverId,
                    channelId,
                    userId,
                    label: lab,
                    confidence,
                    notes,
                    createdAt: new Date(),
                  },
                });
                saved.push({ id: created.id, label: lab });
              }
            }
          }

          // Trigger: upsert + increment（原子的にカウントを上げる）
          if (phraseForIndex) {
            const pattern = buildTriggerPattern(phraseRaw);
            for (const lab of labels) {
              await upsertTriggerSafeTx(tx, {
                serverId,
                channelId,
                phrase: phraseForIndex, // 正規化キーを保存
                pattern, // 表示・ゆる一致は原文ベース
                label: lab,
              });
              triggersUpserted.push({ label: lab });
            }
          }
        },
        { timeout: 10_000, maxWait: 10_000 }
      );
    }, 3);

    // 即時反映用の簡易ペイロード
    const composition = evenComposition(labels);
    const rationale = userId
      ? `feedback:${labels.join("|")} by ${userId}`
      : `feedback:${labels.join("|")}`;

    return json({
      ok: true,
      saved,
      triggersUpserted,
      apply: {
        label: labels[0],
        labels,
        confidence: 0.95,
        composition,
        rationale,
      },
    });
  } catch (err: any) {
    return json({ ok: false, error: String(err?.message ?? err) }, 500);
  }
}

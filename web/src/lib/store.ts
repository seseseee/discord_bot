// src/lib/store.ts
import { prisma } from "@/lib/prisma";
import type { MessageRecord } from "@/lib/utils";

function bigIntToNumber(bi: bigint | number | null | undefined): number {
  if (typeof bi === "number") return bi;
  if (typeof bi === "bigint") return Number(bi);
  return Date.now();
}

export const Store = {
  /**
   * チャンネル内メッセージを時系列昇順で取得
   * @param serverId
   * @param channelId
   * @param sinceMs  取得開始（ms）
   * @param limit    上限件数
   */
  async listByChannel(
    serverId: string,
    channelId: string,
    sinceMs: number,
    limit = 180
  ): Promise<MessageRecord[]> {
    const rows = await prisma.message.findMany({
      where: {
        serverId,
        channelId,
        createdAt: { gte: BigInt(sinceMs) },
      },
      orderBy: { createdAt: "asc" },
      take: Math.max(1, Math.min(limit, 1000)),
      select: {
        id: true,
        serverId: true,
        channelId: true,
        authorId: true,
        authorIsBot: true,
        contentText: true,
        createdAt: true,
      },
    });

    return rows.map((r) => {
      const createdAt = bigIntToNumber(r.createdAt as unknown as bigint);
      return {
        serverId: r.serverId,
        channelId: r.channelId,
        messageId: r.id,
        authorId: r.authorId,
        authorIsBot: !!r.authorIsBot,
        contentText: r.contentText || "",
        createdAt,
        createdAtIso: new Date(createdAt).toISOString(),
      } satisfies MessageRecord;
    });
  },
};

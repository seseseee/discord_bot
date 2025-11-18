// scripts/autoExport.ts
import 'dotenv/config';
import { promises as fs } from 'fs';
import path from 'path';
import { prisma } from '../src/lib/prisma';

const EVERY_MS = Number(process.env.EXPORT_EVERY_MS ?? 60_000);
const DAYS = Number(process.env.EXPORT_DAYS ?? 1);
const EXPORT_DIR = process.env.EXPORT_DIR ?? 'exports';
const SERVER = process.env.SERVER_ID ?? process.env.NEXT_PUBLIC_SERVER_ID ?? '';

function nowStamp() {
  // 例: 20251002T031500
  return new Date().toISOString().replace(/[:.-]|\.\d{3}Z$/g, '').replace('T', 'T');
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function exportOnce() {
  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);
  const sinceMs = BigInt(since.getTime());               // ← Date → BigInt(ms)

  const where: any = { createdAt: { gte: sinceMs } };
  if (SERVER) where.serverId = SERVER;

  // 最新ラベル1件だけ欲しいので labels: { orderBy + take:1 }
  const msgs = await prisma.message.findMany({
    where,
    include: {
      labels: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { label: true, confidence: true, rationale: true },
      },
    },
    orderBy: { createdAt: 'asc' },
  });

  const rows = msgs.map((m) => {
    const lab = m.labels[0];
    const createdIso = new Date(Number(m.createdAt)).toISOString(); // BigInt → number → ISO
    const text = (m.contentText ?? '').replace(/\r?\n/g, ' ');
    return {
      serverId: m.serverId,
      channelId: m.channelId,
      messageId: m.id,
      authorId: m.authorId,
      authorIsBot: m.authorIsBot,
      createdAt: createdIso,
      label: lab?.label ?? '',
      confidence: lab?.confidence ?? '',
      rationale: lab?.rationale ?? '',
      contentText: text,
    };
  });

  await fs.mkdir(EXPORT_DIR, { recursive: true });
  const file = path.join(EXPORT_DIR, `chatviz_${nowStamp()}_${DAYS}d.csv`);

  const header = [
    'serverId',
    'channelId',
    'messageId',
    'authorId',
    'authorIsBot',
    'createdAt',
    'label',
    'confidence',
    'rationale',
    'contentText',
  ].join(',') + '\r\n';

  const toCsv = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;

  const body =
    rows
      .map((r) =>
        [
          r.serverId,
          r.channelId,
          r.messageId,
          r.authorId,
          r.authorIsBot,
          r.createdAt,
          r.label,
          r.confidence,
          r.rationale,
          r.contentText,
        ]
          .map(toCsv)
          .join(',')
      )
      .join('\r\n') + '\r\n';

  await fs.writeFile(file, header + body, 'utf8');
  console.log('[EXPORT] exported CSV', file, rows.length);
}

async function main() {
  console.log('[EXPORT] autoExport worker started', {
    EVERY_MS,
    DAYS,
    EXPORT_DIR,
    SERVER,
  });
  while (true) {
    try {
      await exportOnce();
    } catch (e) {
      console.error('[EXPORT] error', e);
    }
    await sleep(EVERY_MS);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

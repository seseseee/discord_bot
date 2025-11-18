// scripts/markExcludeAnalysis.ts
import "dotenv/config";
import { prisma } from "../src/lib/prisma";

const ANALYSIS_CH =
  process.env.ANALYSIS_CHANNEL_ID ||
  process.env.DISCORD_ANALYSIS_CHANNEL_ID ||
  "";
const SERVER_ID =
  process.env.SERVER_ID ||
  process.env.NEXT_PUBLIC_SERVER_ID ||
  "";

async function main() {
  if (!ANALYSIS_CH) {
    console.error("[exclude] ANALYSIS_CHANNEL_ID が未設定です (.env)");
    process.exit(1);
  }
  if (!SERVER_ID) {
    console.error("[exclude] SERVER_ID (or NEXT_PUBLIC_SERVER_ID) が未設定です (.env)");
    process.exit(1);
  }

  const countBefore = await prisma.message.count({
    where: { serverId: SERVER_ID, channelId: ANALYSIS_CH, excludedFromMetrics: false },
  });

  const res = await prisma.message.updateMany({
    where: { serverId: SERVER_ID, channelId: ANALYSIS_CH, excludedFromMetrics: false },
    data:  { excludedFromMetrics: true },
  });

  console.log(`[exclude] target(before)=${countBefore}, updated=${res.count}`);
}

main().finally(() => prisma.$disconnect());

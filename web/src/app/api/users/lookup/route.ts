// src/app/api/users/lookup/route.ts
import { NextRequest, NextResponse } from "next/server";

// Prisma は存在すれば使う（存在しない環境でも動作させる）
let prisma: any = null;
try { prisma = (await import("@/lib/prisma")).prisma; } catch { /* optional */ }

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Profile = { id: string; name: string; avatarUrl: string | null };

// ---- Env ----
const BOT  = (process.env.DISCORD_TOKEN || "").trim();
const GUILD =
  (process.env.SERVER_ID || process.env.NEXT_PUBLIC_SERVER_ID || "").trim();

const API = "https://discord.com/api/v10";
const CDN = "https://cdn.discordapp.com";

// ---- Memory cache (プロセス存続中) ----
const TTL_MS = 6 * 60 * 60 * 1000;
const mem = new Map<string, { at: number; p: Profile }>();
const now = () => Date.now();
const getMem = (id: string) => {
  const row = mem.get(id);
  if (!row) return;
  if (now() - row.at > TTL_MS) { mem.delete(id); return; }
  return row.p;
};
const setMem = (p: Profile) => mem.set(p.id, { at: now(), p });

// ---- helpers ----
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
function fallbackProfile(id: string): Profile {
  return { id, name: `user:${id}`, avatarUrl: `${CDN}/embed/avatars/0.png` };
}
function displayName(member: any, user: any) {
  return (
    member?.nick ??
    user?.global_name ??
    user?.username ??
    `user:${user?.id ?? "unknown"}`
  );
}
function avatarFromMember(member: any, user: any, gid: string) {
  const uid = user?.id;
  const ghash = member?.avatar as string | null;
  if (uid && ghash) return `${CDN}/guilds/${gid}/users/${uid}/avatars/${ghash}.png?size=128`;
  if (uid && user?.avatar) return `${CDN}/avatars/${uid}/${user.avatar}.png?size=128`;
  return `${CDN}/embed/avatars/0.png`;
}
async function fetchJSON(url: string) {
  const r = await fetch(url, { headers: { Authorization: `Bot ${BOT}` } });
  if (r.status === 429) {
    // rate limit 簡易バックオフ
    const ra = Number(r.headers.get("retry-after") || "0");
    const wait = (ra > 0 ? ra : 1) * 1000;
    await new Promise(res => setTimeout(res, wait));
    const r2 = await fetch(url, { headers: { Authorization: `Bot ${BOT}` } });
    if (!r2.ok) throw new Error(`${r2.status} ${r2.statusText}`);
    return r2.json();
  }
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return r.json();
}

// ---- DB キャッシュ（あれば使う・無ければスキップ） ----
async function getDbMany(ids: string[]): Promise<Record<string, Profile>> {
  if (!prisma) return {};
  try {
    // 想定テーブル: user_profile(id TEXT PK, name TEXT, avatarUrl TEXT, updatedAt DATETIME)
    const rows = await prisma.user_profile.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, avatarUrl: true, updatedAt: true },
    });
    const out: Record<string, Profile> = {};
    for (const r of rows) out[r.id] = { id: r.id, name: r.name, avatarUrl: r.avatarUrl };
    return out;
  } catch { return {}; }
}
async function upsertDb(p: Profile) {
  if (!prisma) return;
  try {
    await prisma.user_profile.upsert({
      where: { id: p.id },
      create: { id: p.id, name: p.name, avatarUrl: p.avatarUrl, updatedAt: new Date() },
      update: { name: p.name, avatarUrl: p.avatarUrl, updatedAt: new Date() },
    });
  } catch { /* ignore */ }
}

// ---- 並列制御 ----
async function pMapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const ret: R[] = [];
  let i = 0;
  const w = new Array(Math.min(limit, Math.max(1, items.length))).fill(0).map(async () => {
    while (i < items.length) {
      const idx = i++;
      ret[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(w);
  return ret;
}

// ---- main handler ----
export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const idsParam = (url.searchParams.get("ids") || "").trim();
  const ids = Array.from(new Set(idsParam.split(",").map(s => s.trim()).filter(Boolean)));
  if (!ids.length) return json({ ok: false, error: "ids が必要です（カンマ区切り）" }, 400);

  // 1) mem cache
  const hit: Record<string, Profile> = {};
  const miss: string[] = [];
  for (const id of ids) {
    const p = getMem(id);
    if (p) hit[id] = p; else miss.push(id);
  }

  // 2) DB
  const db = await getDbMany(miss);
  for (const id of Object.keys(db)) {
    hit[id] = db[id];
    const i = miss.indexOf(id);
    if (i >= 0) miss.splice(i, 1);
  }

  // 3) Discord（Botトークンがあれば）
  if (miss.length && BOT) {
    const fetched = await pMapLimit(miss, 3, async (id) => {
      try {
        // guild member 優先
        if (GUILD) {
          try {
            const m = await fetchJSON(`${API}/guilds/${GUILD}/members/${id}`);
            if (m?.user) {
              const prof: Profile = {
                id,
                name: displayName(m, m.user),
                avatarUrl: avatarFromMember(m, m.user, GUILD),
              };
              return prof;
            }
          } catch { /* fallback to /users */ }
        }
        const u = await fetchJSON(`${API}/users/${id}`);
        const prof: Profile = {
          id,
          name: u?.global_name ?? u?.username ?? `user:${id}`,
          avatarUrl: u?.avatar ? `${CDN}/avatars/${id}/${u.avatar}.png?size=128` : `${CDN}/embed/avatars/0.png`,
        };
        return prof;
      } catch {
        return fallbackProfile(id);
      }
    });
    for (const p of fetched) {
      hit[p.id] = p;
      setMem(p);
      upsertDb(p).catch(() => {});
    }
  }

  // 4) それでも無いIDはフォールバックで埋める（UIが壊れないよう常に200）
  for (const id of ids) if (!hit[id]) {
    const fb = fallbackProfile(id);
    hit[id] = fb;
    setMem(fb);
  }

  return json({ ok: true, items: hit });
}

export function POST(req: NextRequest) { return GET(req); }

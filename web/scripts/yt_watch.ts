#!/usr/bin/env ts-node
import "dotenv/config";
import fs from "fs";
import path from "path";
import { spawn } from "node:child_process";

/* ====== 設定 ====== */
const YT_KEY = process.env.YOUTUBE_API_KEY || "";
const CHANNEL_INPUT = (process.env.YT_CHANNELS || "").split(",").map(s => s.trim()).filter(Boolean);
const INTERVAL_MIN = Number(process.env.YT_POLL_MINUTES || "60");
const MAX_VIDS_PER_CHANNEL = Number(process.env.YT_MAX_VIDEOS_PER_CHANNEL || "5");
const CONF_THRESHOLD = Number(process.env.YT_CONF_THRESHOLD || "0.72");
const OUTDIR = process.env.YT_OUTDIR || "data/yt";

/* ====== CLI引数 ====== */
function arg(name: string, d = "") {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? String(process.argv[i + 1] || d) : d;
}
const ONCE = process.argv.includes("--once");
const intervalArg = Number(arg("interval", "")) || INTERVAL_MIN;
const POLL_MS = Math.max(1, intervalArg) * 60 * 1000;

/* ====== YouTube API ====== */
const API_SEARCH = "https://www.googleapis.com/youtube/v3/search";
const API_CHANNELS = "https://www.googleapis.com/youtube/v3/channels";

/* ====== 状態保存 ====== */
type State = { channels: Record<string, { lastPublishedAt?: string; processed?: string[] }> };
const STATE_PATH = path.resolve(process.cwd(), `${OUTDIR}/auto_state.json`);
function readState(): State {
  try { return JSON.parse(fs.readFileSync(STATE_PATH, "utf8")); }
  catch { return { channels: {} }; }
}
function writeState(s: State) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2), "utf8");
}

/* ====== ユーティリティ ====== */
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }
async function fetchJson(url: URL) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return r.json();
}
function extractHandleOrId(s: string): { handle?: string; channelId?: string } {
  const t = s.trim();
  if (/^UC[0-9A-Za-z_-]{20,}$/.test(t)) return { channelId: t };
  if (t.startsWith("@")) return { handle: t };
  try {
    const u = new URL(t);
    if (u.hostname.includes("youtube.com") || u.hostname.includes("youtu.be")) {
      const m1 = u.pathname.match(/\/channel\/(UC[0-9A-Za-z_-]+)/);
      if (m1) return { channelId: m1[1] };
      const m2 = u.pathname.match(/\/@([^\/?#]+)/);
      if (m2) return { handle: "@" + m2[1] };
    }
  } catch {}
  if (!t.startsWith("@")) return { handle: "@" + t };
  return { handle: t };
}
async function resolveChannelId(input: string): Promise<string> {
  if (!YT_KEY) throw new Error("YOUTUBE_API_KEY is required");
  const { handle, channelId } = extractHandleOrId(input);
  if (channelId) return channelId;

  if (handle) {
    const url = new URL(API_CHANNELS);
    url.searchParams.set("part", "id");
    url.searchParams.set("forHandle", handle);
    url.searchParams.set("key", YT_KEY);
    const j: any = await fetchJson(url);
    const id = j?.items?.[0]?.id;
    if (id) return id;
  }
  const url = new URL(API_SEARCH);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("q", input);
  url.searchParams.set("type", "channel");
  url.searchParams.set("maxResults", "1");
  url.searchParams.set("key", YT_KEY);
  const j: any = await fetchJson(url);
  const id = j?.items?.[0]?.snippet?.channelId || j?.items?.[0]?.id?.channelId;
  if (!id) throw new Error(`channelId resolve failed for "${input}"`);
  return id;
}
async function listRecentVideos(channelId: string, sinceIso?: string) {
  const url = new URL(API_SEARCH);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("channelId", channelId);
  url.searchParams.set("type", "video");
  url.searchParams.set("order", "date");
  url.searchParams.set("maxResults", "50");
  url.searchParams.set("key", YT_KEY);
  if (sinceIso) url.searchParams.set("publishedAfter", new Date(sinceIso).toISOString());

  const j: any = await fetchJson(url);
  return (j.items || [])
    .map((it: any) => ({
      id: it?.id?.videoId || it?.snippet?.resourceId?.videoId,
      publishedAt: it?.snippet?.publishedAt,
    }))
    .filter((v: any) => v.id && v.publishedAt)
    .slice(0, MAX_VIDS_PER_CHANNEL);
}

/* ====== ここが重要：yt_auto の起動方法を修正 ======
   - Windows で spawn EINVAL を避けるため shell:true でコマンド文字列実行
   - 成功(コード0)のときのみ true を返す  */
function runYtAuto(videoId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const cmd = `npx tsx -r dotenv/config scripts/yt_auto.ts --video "${videoId}" --threshold ${CONF_THRESHOLD} --outdir "${OUTDIR}"`;
    // シェル経由で実行（PowerShell / cmd でもOK）
    const child = spawn(cmd, { shell: true, stdio: "inherit" });
    child.on("error", (e) => {
      console.error(`[yt_watch] spawn failed: ${e?.message || e}`);
      resolve(false);
    });
    child.on("exit", (code) => resolve(code === 0));
  });
}

/* ====== メインループ ====== */
async function tick() {
  if (!CHANNEL_INPUT.length) {
    console.log("[yt_watch] YT_CHANNELS 未設定（@handle / URL / UC... をカンマ区切りで）");
    return;
  }
  const st = readState();

  for (const raw of CHANNEL_INPUT) {
    try {
      const chanId = await resolveChannelId(raw);
      const node = (st.channels[chanId] = st.channels[chanId] || { lastPublishedAt: undefined, processed: [] });

      console.log(`[yt_watch] channel=${raw} -> ${chanId}`);
      const vids = await listRecentVideos(chanId, node.lastPublishedAt);
      vids.sort((a, b) => +new Date(a.publishedAt) - +new Date(b.publishedAt));
      console.log(`[yt_watch] new videos: ${vids.length}`);

      for (const v of vids) {
        if (node.processed?.includes(v.id)) continue;

        console.log(`[yt_watch] process videoId=${v.id} publishedAt=${v.publishedAt}`);
        const ok = await runYtAuto(v.id);

        if (ok) {
          // ★ 成功時のみ state を更新
          node.lastPublishedAt = v.publishedAt;
          node.processed = Array.from(new Set([...(node.processed || []), v.id])).slice(-200);
          writeState(st);
        } else {
          console.error(`[yt_watch] yt_auto failed for ${v.id} → stateは更新しません（次回再試行）`);
        }
        await sleep(400); // 軽い間隔
      }
    } catch (e: any) {
      console.error(`[yt_watch] error for "${raw}":`, e?.message || e);
    }
    await sleep(300);
  }
}

async function main() {
  fs.mkdirSync(OUTDIR, { recursive: true });
  await tick();
  if (ONCE) return;
  console.log(`[yt_watch] polling every ${Math.round(POLL_MS/60000)} min... (threshold=${CONF_THRESHOLD})`);
  setInterval(tick, POLL_MS);
}
main().catch(e => { console.error("[yt_watch] fatal:", e); process.exit(1); });

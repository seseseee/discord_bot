// scripts/autoAnalyze.ts (v1.1)
import "dotenv/config";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const SERVER = process.env.SERVER_ID ?? process.env.NEXT_PUBLIC_SERVER_ID ?? "";
const BATCH = Math.max(1, Number(process.env.ANALYZE_BATCH ?? "50"));
const INTERVAL_MS = Math.max(3000, Number(process.env.ANALYZE_INTERVAL_MS ?? "15000"));
const FORCE = (process.env.ANALYZE_FORCE ?? "false") === "true";
const MODE = (process.env.ANALYZE_MODE ?? "daemon") as "daemon" | "once";
const FETCH_TIMEOUT_MS = Number(process.env.FETCH_TIMEOUT_MS ?? "15000");

console.log("[ANALYZE] worker start", { BASE, SERVER: SERVER || "-", BATCH, INTERVAL_MS, FORCE, MODE });

function timeoutFetch(input: RequestInfo | URL, init?: RequestInit, ms = FETCH_TIMEOUT_MS) {
  const ac = new AbortController();
  const id = setTimeout(() => ac.abort(), ms);
  return fetch(input, { ...init, signal: ac.signal }).finally(() => clearTimeout(id));
}

async function waitForServer(url: string, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await timeoutFetch(url, undefined, 5000);
      if (r.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  console.warn("[ANALYZE] server ping timeout, continue anyway");
}

function jitter(baseMs: number) {
  const j = Math.floor(baseMs * 0.2 * Math.random()); // ±20% ジッター
  return baseMs - Math.floor(baseMs * 0.1) + j;
}

async function runOnce(): Promise<boolean> {
  if (!SERVER) {
    console.error("[ANALYZE] SERVER_ID が空です（.env に SERVER_ID か NEXT_PUBLIC_SERVER_ID）");
    return false;
  }
  const url = `${BASE}/api/analyze/batch?serverId=${SERVER}&limit=${BATCH}` + (FORCE ? "&force=true" : "");

  const t0 = performance.now();
  try {
    const r = await timeoutFetch(url, { method: "POST", headers: { "Content-Type": "application/json" } });
    const j = await r.json().catch(() => ({} as any));
    const dt = Math.round(performance.now() - t0);

    if (!r.ok) {
      console.log("[ANALYZE] error", r.status, j?.error ?? j);
      return false;
    }
    const processed = j?.processed ?? j?.count ?? j?.length ?? 0;
    console.log("[ANALYZE] ok", { processed, ms: dt });
    return true;
  } catch (e) {
    console.log("[ANALYZE] fetch failed", String(e));
    return false;
  }
}

async function main() {
  await waitForServer(`${BASE}/api/ping`).catch(() => {});
  if (MODE === "once") {
    const ok = await runOnce();
    process.exit(ok ? 0 : 1);
    return;
  }

  let backoff = 0;
  const tick = async () => {
    const ok = await runOnce();
    backoff = ok ? 0 : Math.min((backoff || 1000) * 2, 60_000); // 1s→2s→…→60s
    const next = jitter(backoff ? INTERVAL_MS + backoff : INTERVAL_MS);
    setTimeout(tick, next);
  };

  // graceful shutdown
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      console.log(`[ANALYZE] ${sig} received, exiting...`);
      process.exit(0);
    });
  }

  tick();
}

main();

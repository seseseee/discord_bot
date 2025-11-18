// src/lib/utils.ts
export type MessageRecord = {
  serverId: string;
  channelId: string;
  messageId: string;
  authorId: string;
  authorIsBot: boolean;
  contentText: string;
  createdAt: number;        // ms since epoch
  createdAtIso?: string;    // optional
};

export type AnalysisResult = {
  label: "AG"|"TP"|"EM"|"S"|"Q"|"CH"|"NG"|"BOT";
  labels?: string[];         // 上位候補
  confidence?: number;       // 0..1
  rationale?: string;        // 簡潔な理由
  composition?: { label: string; pct: number }[];
};

export type Feedback = {
  messageId: string;
  serverId: string;
  channelId: string;
  userId: string;
  label: string;
  notes?: string;
  confidence?: number;
  ts: number;
};

export function jsonSafe<T>(v: T): T { return JSON.parse(JSON.stringify(v)); }
export const sleep = (ms: number)=> new Promise(res=> setTimeout(res, ms));
export const clamp = (v:number, lo=0, hi=1)=> Math.max(lo, Math.min(hi, v));

export function extractJsonObject(text: string): any | null {
  try { return JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}$/m);
    if (!m) return null;
    try { return JSON.parse(m[0]); } catch { return null; }
  }
}

export function hasUrl(s: string){ return /https?:\/\/\S+/i.test(s); }
export function firstSentence(s: string, max=80){
  const z = (s||"").trim().replace(/\s+/g, " ");
  const cut = z.split(/[。！？?!\.]/)[0] || z;
  return cut.length>max? (cut.slice(0, max-1)+"…"): cut;
}
export function truncate(s: string, n=200){
  const t = (s||"").replace(/\s+/g," ").trim();
  return t.length>n? (t.slice(0,n-1)+"…"): t;
}

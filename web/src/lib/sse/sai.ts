// src/lib/sse/sai.ts
import type { SAIResult } from "@/lib/metrics/sai";

type Client = { id: number; send: (data: string) => void };
const clients = new Map<number, Client>();
let seq = 1;

/** 接続ごとの送信関数を登録し、解除関数を返す */
export function addClient(send: (data: string) => void) {
  const id = seq++;
  clients.set(id, { id, send });
  return () => { clients.delete(id); };
}

/** SAIイベントを配信 */
export function publishSAI(r: SAIResult) {
  const evt = `event: sai\ndata:${JSON.stringify(r)}\n\n`;
  for (const c of clients.values()) {
    try { c.send(evt); } catch {}
  }
}

/** 心拍（任意） */
export function publishPing() {
  const evt = `event: ping\ndata: {}\n\n`;
  for (const c of clients.values()) {
    try { c.send(evt); } catch {}
  }
}

// src/app/api/metrics/sai/stream/route.ts
import type { NextRequest } from "next/server";
import { addClient } from "@/lib/sse/sai";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      const send = (data: string) => controller.enqueue(enc.encode(data));

      // SSE初期行
      send(`retry: 2000\n\n`);

      // クライアント登録
      const unsubscribe = addClient(send);

      // 心拍（15s）
      const timer = setInterval(() => send(`event: ping\ndata: {}\n\n`), 15000);

      const cleanup = () => {
        clearInterval(timer);
        try { unsubscribe(); } catch {}
        try { controller.close(); } catch {}
      };

      // 接続切断
      // @ts-ignore
      req.signal?.addEventListener("abort", cleanup);
      (controller as any)._cleanup = cleanup;
    },
    cancel() { /* no-op */ },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

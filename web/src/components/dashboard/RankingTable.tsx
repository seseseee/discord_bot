"use client";

import { useEffect, useMemo, useState } from "react";

type Item = { userId: string; score: number };
type UserInfo = { id: string; name: string; avatarUrl?: string };

export default function RankingTable({
  title, items, max = 10,
}: { title: string; items: Item[]; max?: number }) {
  const top = useMemo(() => (items ?? []).slice(0, max), [items, max]);
  const [users, setUsers] = useState<Record<string, UserInfo>>({});

  useEffect(() => {
    const ids = Array.from(new Set(top.map(x => x.userId))).join(",");
    if (!ids) return;
    (async () => {
      try {
        const r = await fetch(`/api/users/lookup?ids=${encodeURIComponent(ids)}`);
        if (!r.ok) throw new Error(String(r.status));
        const j = await r.json();
        const map: Record<string, UserInfo> = {};
        for (const u of j?.users ?? []) map[u.id] = u;
        setUsers(map);
      } catch {
        /* 404等はスルー（fallback表示） */
      }
    })();
  }, [top]);

  const fallbackAvatar = (uid: string) =>
    `https://cdn.discordapp.com/embed/avatars/${Number(uid) % 5}.png`;

  return (
    <div className="rounded-2xl border bg-white/70 p-4 shadow-sm">
      <div className="mb-2 text-sm font-semibold opacity-70">{title}</div>
      <ul className="space-y-2">
        {top.map((r, i) => {
          const u = users[r.userId];
          return (
            <li key={r.userId} className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-6 text-right font-mono opacity-60">{i + 1}.</div>
                <img
                  src={u?.avatarUrl || fallbackAvatar(r.userId)}
                  alt=""
                  className="h-8 w-8 rounded-full border object-cover"
                />
                <div className="truncate max-w-[16rem]">
                  <div className="text-sm font-medium">{u?.name || r.userId}</div>
                  <div className="text-xs opacity-50">{r.userId}</div>
                </div>
              </div>
              <div className="text-right">
                <div className="text-lg font-semibold">{r.score}</div>
              </div>
            </li>
          );
        })}
        {top.length === 0 && <div className="py-6 text-center text-sm opacity-60">データなし</div>}
      </ul>
    </div>
  );
}

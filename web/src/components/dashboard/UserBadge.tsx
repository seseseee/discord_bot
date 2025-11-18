"use client";
import { useEffect, useMemo, useState } from "react";

export type UserProfile = { id: string; name: string; avatarUrl?: string | null };

function initials(name: string) {
  const t = (name || "").trim();
  if (!t) return "?";
  const parts = t.split(/\s+/);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "U";
}
function colorFromId(id: string) {
  let h = 0; for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return `hsl(${h} 60% 45%)`;
}

export function UserBadge({ userId, size = 36 }: { userId: string; size?: number }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);

  useEffect(() => {
    let ignore = false;
    (async () => {
      try {
        const r = await fetch(`/api/users/lookup?ids=${encodeURIComponent(userId)}`, { cache: "no-store" });
        const j = await r.json();
        const item = j?.items?.[userId];
        if (item && !ignore) setProfile(item);
      } catch { /* noop */ }
    })();
    return () => { ignore = true; };
  }, [userId]);

  const name = profile?.name ?? `user:${userId}`;
  const avatar = profile?.avatarUrl ?? null;
  const bg = useMemo(() => ({ backgroundColor: colorFromId(userId) }), [userId]);

  return (
    <div className="flex items-center gap-3">
      {avatar ? (
        <img src={avatar} alt={name} width={size} height={size}
             className="rounded-full ring-1 ring-neutral-700 object-cover" />
      ) : (
        <div style={{ width: size, height: size, ...bg }}
             className="rounded-full grid place-items-center text-white text-sm font-semibold select-none">
          {initials(name)}
        </div>
      )}
      <span className="truncate max-w-[200px]">{name}</span>
    </div>
  );
}

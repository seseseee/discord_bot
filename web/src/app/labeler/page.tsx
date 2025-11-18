"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";

/** ラベル定義 */
type Label = "AG" | "TP" | "EM" | "S" | "Q" | "CH" | "NG";
const LABELS: Label[] = ["AG", "TP", "EM", "S", "Q", "CH", "NG"];

/** 入力JSONのゆるい型（yt_analyze の .pred.json など） */
type AnyRow = {
  id?: string;
  videoId?: string;
  url?: string;
  title?: string;
  text?: string;
  model?: { label?: Label; labels?: Label[]; confidence?: number; rationale?: string };
  gold?: string | string[];       // "AG|EM" でも ["AG","EM"] でもOK
  gold_labels?: string[];          // これも許可
  // ↑他に何が来てもOK（保持して再出力）
  [k: string]: any;
};

type UiRow = {
  id: string;               // messageId（DB反映に使う）
  text: string;
  source: AnyRow;           // 元データ（出力時に再構築）
  predLabel?: Label | null;
  predLabels?: Label[];
  confidence?: number;
  rationale?: string;
  gold: Label[];            // UIで編集する最終ラベル
  reviewed: boolean;        // 何か操作したら true
};

const BTN_STYLE =
  "px-2 py-1 text-sm rounded border hover:opacity-90 focus:outline-none focus:ring-2";
const ACTIVE = "bg-black text-white border-black";
const INACTIVE = "bg-white text-black border-gray-300";

/** gold の取り出し（"AG|EM" or ["AG","EM"] → Label[]） */
function parseGold(x: any): Label[] {
  if (!x) return [];
  const arr = Array.isArray(x) ? x : typeof x === "string" ? x.split(/\s*\|\s*|[、,／/]\s*/).filter(Boolean) : [];
  const out = Array.from(
    new Set(
      arr
        .map((s) => String(s).toUpperCase().trim())
        .filter((s) => LABELS.includes(s as Label))
    )
  ) as Label[];
  return out;
}

/** 入力行を UiRow へ正規化 */
function normalizeInputRow(row: AnyRow, index: number): UiRow | null {
  // id が無いデータもラベリングはできるが、DB反映はできない → id 代替を振る
  const id = String(row.id ?? `local_${index}`);
  const textRaw = [row.title ?? "", row.text ?? ""].join("\n").trim();
  const text = textRaw || row.url || "";

  const predLabel = (row.model?.label as Label | undefined) ?? undefined;
  const predLabels = (row.model?.labels as Label[] | undefined) ?? (predLabel ? [predLabel] : []);
  const confidence = typeof row.model?.confidence === "number" ? row.model!.confidence : undefined;
  const rationale = row.model?.rationale;

  const goldFromFields = parseGold(row.gold) || [];
  const goldFromArray = parseGold(row.gold_labels) || [];
  const gold = Array.from(new Set<Label>([...goldFromFields, ...goldFromArray]));

  return {
    id,
    text,
    source: row,
    predLabel: predLabel ?? null,
    predLabels,
    confidence,
    rationale,
    gold,
    reviewed: gold.length > 0,
  };
}

/** ダウンロード（ブラウザのみ） */
function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/** /api/feedback へ適用（複数ラベル同時OK） */
async function applyToDb(messageId: string, labels: Label[], userId = "labeler_ui") {
  if (!messageId || labels.length === 0) return { ok: true };
  const body = { messageId, label: labels.join("|"), userId };
  const r = await fetch("/api/feedback", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return r.json().catch(() => ({ ok: false, error: "invalid json" }));
}

export default function LabelerPage() {
  const [rows, setRows] = useState<UiRow[]>([]);
  const [idx, setIdx] = useState(0);
  const [onlyLowConf, setOnlyLowConf] = useState(true);
  const [threshold, setThreshold] = useState(0.72);
  const [applyBusy, setApplyBusy] = useState(false);

  /** ロード */
  const onFiles = useCallback(async (files: FileList | null) => {
    if (!files || !files[0]) return;
    const text = await files[0].text();
    let json: any;
    try { json = JSON.parse(text); } catch { alert("JSONのパースに失敗しました"); return; }
    if (!Array.isArray(json)) { alert("JSON配列（[]）を読み込んでください"); return; }

    const normalized = json
      .map((r: AnyRow, i: number) => normalizeInputRow(r, i))
      .filter((x: UiRow | null): x is UiRow => !!x);

    setRows(normalized);
    setIdx(0);
  }, []);

  /** ドラッグ&ドロップ */
  const onDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files) onFiles(e.dataTransfer.files);
  }, [onFiles]);

  /** gold のトグル */
  const toggleLabel = (rowIndex: number, lab: Label) => {
    setRows((prev) => {
      const next = [...prev];
      const r = { ...next[rowIndex] };
      const s = new Set(r.gold);
      if (s.has(lab)) s.delete(lab); else s.add(lab);
      r.gold = Array.from(s) as Label[];
      r.reviewed = true;
      next[rowIndex] = r;
      return next;
    });
  };

  /** 次/前へ */
  const go = (delta: number) => {
    setIdx((i) => {
      const max = view.length - 1;
      const ni = Math.min(max, Math.max(0, i + delta));
      return ni;
    });
  };

  /** 表示対象（低スコアのみのトグル適用） */
  const view = useMemo(() => {
    if (!onlyLowConf) return rows;
    return rows.filter((r) => (r.confidence ?? 0) < threshold);
  }, [rows, onlyLowConf, threshold]);

  /** 現在の行 */
  const cur = view[idx];

  /** JSONダウンロード（元構造を保ちつつ gold を書き戻す） */
  const downloadAll = () => {
    const out = rows.map((r) => {
      const src = { ...r.source };
      const goldStr = r.gold.join("|");
      return { ...src, gold: goldStr, gold_labels: r.gold };
    });
    downloadJson("labeled_all.json", out);
  };
  const downloadNeedsReview = () => {
    const out = rows
      .filter((r) => (r.confidence ?? 0) < threshold)
      .map((r) => ({ ...r.source, gold: r.gold.join("|"), gold_labels: r.gold }));
    downloadJson("needs_review.json", out);
  };

  /** DB へ適用（現在行 or 表示中すべて） */
  const applyOne = async () => {
    if (!cur) return;
    if (!cur.id.startsWith("yt_") && !cur.id.match(/^[A-Za-z]/) && cur.id.startsWith("local_")) {
      alert("この行はDBに存在しないため適用できません（idがlocal_*）");
      return;
    }
    if (cur.gold.length === 0) { alert("ラベルが空です"); return; }
    setApplyBusy(true);
    const res = await applyToDb(cur.id, cur.gold, "labeler_ui");
    setApplyBusy(false);
    if (!res?.ok) alert("適用に失敗: " + (res?.error ?? "unknown"));
  };

  const applyAllVisible = async () => {
    if (!view.length) return;
    setApplyBusy(true);
    let ok = 0, ng = 0;
    for (const r of view) {
      if (!r.gold.length) continue;
      if (r.id.startsWith("local_")) continue;
      try {
        const res = await applyToDb(r.id, r.gold, "labeler_ui");
        if (res?.ok) ok++; else ng++;
      } catch { ng++; }
      // 軽いウェイト（サーバ保護）
      await new Promise((f) => setTimeout(f, 80));
    }
    setApplyBusy(false);
    alert(`DB適用 完了: OK=${ok} NG=${ng}`);
  };

  /** キーボード */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!cur) return;
      const key = e.key.toLowerCase();
      const map: Record<string, Label> = {
        "1": "AG", "2": "TP", "3": "EM", "4": "S", "5": "Q", "6": "CH", "7": "NG",
        "a": "AG", "t": "TP", "e": "EM", "s": "S", "q": "Q", "c": "CH", "n": "NG",
      };
      if (map[key]) { e.preventDefault(); toggleLabel(idx, map[key]); return; }
      if (key === "j" || e.key === "ArrowRight") { e.preventDefault(); go(+1); }
      if (key === "k" || e.key === "ArrowLeft")  { e.preventDefault(); go(-1); }
      if (key === " ") { e.preventDefault(); setOnlyLowConf((v) => !v); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cur, idx, rows]);

  return (
    <div className="min-h-screen flex flex-col md:flex-row gap-4 p-4"
         onDragOver={(e)=>e.preventDefault()} onDrop={onDrop}>
      {/* 左ペイン：一覧 */}
      <div className="md:w-1/3 w-full">
        <div className="flex items-center justify-between gap-2 mb-2">
          <label className="text-sm">
            <input type="checkbox" className="mr-2"
              checked={onlyLowConf} onChange={(e)=>setOnlyLowConf(e.target.checked)} />
            要確認のみ（conf &lt;）
          </label>
          <input type="number" step="0.01" min="0" max="1"
                 className="w-20 border rounded px-2 py-1 text-sm"
                 value={threshold} onChange={(e)=>setThreshold(Number(e.target.value)||0)} />
        </div>

        <div className="border rounded overflow-auto max-h-[70vh]">
          {view.map((r, i) => {
            const active = i === idx;
            const conf = r.confidence ?? null;
            const bad = conf !== null && conf < threshold;
            return (
              <div key={r.id}
                onClick={()=>setIdx(i)}
                className={`p-2 cursor-pointer border-b ${active ? "bg-amber-50" : ""}`}>
                <div className="text-xs text-gray-500 flex gap-2">
                  <span>#{i+1}</span>
                  {conf != null && (
                    <span className={bad ? "text-red-600 font-semibold" : ""}>
                      conf {conf.toFixed(2)}
                    </span>
                  )}
                </div>
                <div className="text-sm line-clamp-2">{r.text || "(no text)"}</div>
                <div className="mt-1 text-xs">
                  <span className="text-gray-400">pred:</span>{" "}
                  <b>{r.predLabel ?? "-"}</b>
                  {r.gold.length>0 && (
                    <> <span className="text-gray-400 ml-2">gold:</span> <b>{r.gold.join("|")}</b></>
                  )}
                </div>
              </div>
            );
          })}
          {!view.length && (
            <div className="p-4 text-sm text-gray-500">要確認の行はありません。</div>
          )}
        </div>

        <div className="mt-3 flex items-center gap-2">
          <input type="file" accept="application/json"
                 onChange={(e)=>onFiles(e.target.files)} />
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button className={`${BTN_STYLE} ${INACTIVE}`} onClick={downloadAll}>JSONダウンロード（全件）</button>
          <button className={`${BTN_STYLE} ${INACTIVE}`} onClick={downloadNeedsReview}>JSONダウンロード（要確認）</button>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          <button className={`${BTN_STYLE} ${applyBusy? "opacity-60 cursor-not-allowed" : ACTIVE}`}
                  disabled={applyBusy} onClick={applyOne}>DBへ適用（この行）</button>
          <button className={`${BTN_STYLE} ${applyBusy? "opacity-60 cursor-not-allowed" : ACTIVE}`}
                  disabled={applyBusy} onClick={applyAllVisible}>DBへ適用（表示中すべて）</button>
        </div>

        <p className="mt-2 text-xs text-gray-500">
          * DB適用は <code>/api/feedback</code> を呼び、学習トリガ（hits/weight）も即反映されます。
        </p>
      </div>

      {/* 右ペイン：詳細 */}
      <div className="md:w-2/3 w-full">
        {!cur ? (
          <div className="h-full border rounded p-6 text-gray-500">
            ここに JSON をドロップ / 右のファイル選択から読み込んでください。
          </div>
        ) : (
          <div className="h-full border rounded p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <div className="text-sm text-gray-500">id: <code>{cur.id}</code></div>
              <div className="flex items-center gap-2">
                <button className={`${BTN_STYLE} ${INACTIVE}`} onClick={()=>go(-1)}>← 前 (K)</button>
                <button className={`${BTN_STYLE} ${INACTIVE}`} onClick={()=>go(+1)}>次 → (J)</button>
              </div>
            </div>

            <div className="text-base whitespace-pre-wrap leading-relaxed">
              {cur.text || "(no text)"}
            </div>

            <div className="text-xs text-gray-500">
              予測: <b>{cur.predLabel ?? "-"}</b>
              {cur.confidence != null && <> / conf {cur.confidence.toFixed(2)}</>}
              {cur.rationale && <div className="mt-1">理由: {cur.rationale}</div>}
            </div>

            <div className="flex flex-wrap gap-2 pt-2">
              {LABELS.map((lab) => {
                const on = cur.gold.includes(lab);
                return (
                  <button key={lab}
                    className={`${BTN_STYLE} ${on ? ACTIVE : INACTIVE}`}
                    onClick={()=>toggleLabel(idx, lab)}>
                    {lab}
                  </button>
                );
              })}
            </div>

            <div className="text-xs text-gray-500">
              キーボード: 1=AG, 2=TP, 3=EM, 4=S, 5=Q, 6=CH, 7=NG / J=次, K=前, Space=要確認のみ切替
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

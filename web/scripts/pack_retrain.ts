// scripts/pack_retrain.ts
//
// for_retrain.*.json → 学習用 JSONL を作るスクリプト。
// - 人手で再評価(relabel)を入れた行だけを train.jsonl に出力
// - （オプション）高信頼の自動予測だけを pseudo.jsonl に出力
//
// 使い方：
//   npx tsx -r dotenv/config scripts/pack_retrain.ts data/yt/XXXX.for_retrain.needs_review.json
//   npx tsx -r dotenv/config scripts/pack_retrain.ts data/yt/XXXX.for_retrain.all.json --pseudo --min-conf 0.9
//   npx tsx -r dotenv/config scripts/pack_retrain.ts data/yt/XXXX.for_retrain.all.json --out data/yt/out/train.jsonl
//
// 出力先：
//   既定は <入力ファイル名>.train.jsonl と <入力ファイル名>.pseudo.jsonl を同じディレクトリに作成
//   --out を指定した場合：
//     - 末尾が .jsonl なら、そのパスに train を書き、pseudo は <basename>.pseudo.jsonl に並置
//     - ディレクトリなら、その中に <basename>.train.jsonl / <basename>.pseudo.jsonl を作成
//
// 必要な入力スキーマ（例：yt_auto.ts が出す for_retrain.*.json の1要素）
// {
//   "id": "0wfDnvMpcNc:123",
//   "videoId": "0wfDnvMpcNc",
//   "index": 123,
//   "text": "この企画めっちゃ面白い！",
//   "label": "em",            // 予測ラベル（tp|q|em|ag|s|ng）
//   "confidence": 0.68,       // 予測の信頼度（0..1）
//   "relabel": null|"tp"|"q"|"em"|"ag"|"s"|"ng",  // 人手で入れる最終ラベル
//   "relabel_reason": ""      // 人手で入れる理由
// }

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

type Label = "tp" | "q" | "em" | "ag" | "s" | "ng";
const LABELS: readonly Label[] = ["tp", "q", "em", "ag", "s", "ng"] as const;

type InRow = {
  id?: string;
  videoId?: string;
  index?: number;
  text?: string;
  label?: string;          // model pred
  confidence?: number;
  relabel?: string | null; // human gold
  relabel_reason?: string;
};

type TrainJsonl = {
  input: string;
  label: Label;
  meta?: Record<string, unknown>;
  reason?: string;
};

type PseudoJsonl = {
  input: string;
  label: Label;
  meta?: Record<string, unknown>;
  pseudo: true;
};

function isLabel(x: any): x is Label {
  return typeof x === "string" && (LABELS as readonly string[]).includes(x);
}

function normalizeText(s: string): string {
  return (s || "")
    .replace(/\r\n?/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function sha1(s: string): string {
  return crypto.createHash("sha1").update(s).digest("hex");
}

function parseArgs(argv: string[]) {
  const args: Record<string, string | boolean> = {};
  const files: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.replace(/^--/, "");
      const n = argv[i + 1];
      if (n && !n.startsWith("--")) {
        args[key] = n;
        i++;
      } else {
        args[key] = true;
      }
    } else {
      files.push(a);
    }
  }
  return { args, files };
}

function ensureDir(p: string) {
  const dir = path.dirname(p);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function resolveOutputs(inputPath: string, outArg?: string) {
  const dir = path.dirname(inputPath);
  const base = path.basename(inputPath).replace(/\.json$/i, "");

  if (!outArg) {
    return {
      trainPath: path.join(dir, `${base}.train.jsonl`),
      pseudoPath: path.join(dir, `${base}.pseudo.jsonl`),
    };
  }

  const out = path.resolve(outArg);
  if (out.toLowerCase().endsWith(".jsonl")) {
    const outDir = path.dirname(out);
    const outBase = path.basename(out, ".jsonl");
    return {
      trainPath: out,
      pseudoPath: path.join(outDir, `${outBase}.pseudo.jsonl`),
    };
  } else {
    // ディレクトリ指定
    return {
      trainPath: path.join(out, `${base}.train.jsonl`),
      pseudoPath: path.join(out, `${base}.pseudo.jsonl`),
    };
  }
}

async function main() {
  const { args, files } = parseArgs(process.argv.slice(2));

  if (files.length !== 1) {
    console.error("Usage: tsx scripts/pack_retrain.ts <for_retrain.json> [--pseudo] [--min-conf 0.9] [--out <path>]");
    process.exit(1);
  }

  const inPath = path.resolve(files[0]);
  if (!fs.existsSync(inPath)) {
    console.error(`Input not found: ${inPath}`);
    process.exit(1);
  }

  const emitPseudo = !!args["pseudo"];
  const minConf = args["min-conf"] != null ? Math.max(0, Math.min(1, Number(args["min-conf"]))) : 0.9;
  const { trainPath, pseudoPath } = resolveOutputs(inPath, typeof args["out"] === "string" ? (args["out"] as string) : undefined);

  const rawText = fs.readFileSync(inPath, "utf8");
  let data: InRow[];
  try {
    const j = JSON.parse(rawText);
    if (!Array.isArray(j)) throw new Error("JSON is not an array");
    data = j as InRow[];
  } catch (e: any) {
    console.error(`Invalid JSON: ${e?.message || e}`);
    process.exit(1);
  }

  // 正規化 & バリデーション & 重複排除
  const seen = new Set<string>();
  const trainRows: TrainJsonl[] = [];
  const pseudoRows: PseudoJsonl[] = [];
  let total = 0;
  let dup = 0;
  let invalid = 0;

  for (const r of data) {
    total++;
    const text = normalizeText(String(r.text ?? ""));
    if (!text) { invalid++; continue; }

    const hash = sha1(text.toLowerCase());
    // gold があるものを優先して dedupe。gold が無い同一テキストはスキップ
    const already = seen.has(hash);
    if (already && r.relabel == null) { dup++; continue; }
    // gold がある行は重複でも上書き（優先）
    seen.add(hash);

    const meta: Record<string, unknown> = {
      videoId: r.videoId ?? undefined,
      index: r.index ?? undefined,
      source: "yt",
      id: r.id ?? undefined,
    };

    // 1) gold（relabel）あり → train 行
    if (r.relabel != null && isLabel(r.relabel)) {
      trainRows.push({
        input: text,
        label: r.relabel,
        meta,
        reason: r.relabel_reason || undefined,
      });
      continue;
    }

    // 2) gold なし & pseudo を出す設定 → 高信頼のみ pseudo 行
    if (emitPseudo) {
      const pred = isLabel(r.label) ? (r.label as Label) : undefined;
      const conf = typeof r.confidence === "number" ? r.confidence : 0;
      if (pred && conf >= minConf) {
        pseudoRows.push({
          input: text,
          label: pred,
          meta: { ...meta, confidence: conf },
          pseudo: true,
        });
      }
    }
  }

  // 書き出し
  ensureDir(trainPath);
  const trainStr = trainRows.map((x) => JSON.stringify(x)).join("\n") + (trainRows.length ? "\n" : "");
  fs.writeFileSync(trainPath, trainStr, "utf8");

  if (emitPseudo) {
    ensureDir(pseudoPath);
    const pseudoStr = pseudoRows.map((x) => JSON.stringify(x)).join("\n") + (pseudoRows.length ? "\n" : "");
    fs.writeFileSync(pseudoPath, pseudoStr, "utf8");
  }

  // サマリ
  console.log(`[pack_retrain] input: ${inPath}`);
  console.log(`[pack_retrain] total=${total}  invalid=${invalid}  dedup=${dup}`);
  console.log(`[pack_retrain] train=${trainRows.length} -> ${trainPath}`);
  if (emitPseudo) {
    console.log(`[pack_retrain] pseudo(th>=${minConf})=${pseudoRows.length} -> ${pseudoPath}`);
  }
}

main().catch((e) => {
  console.error(`[pack_retrain] error:`, e);
  process.exit(1);
});

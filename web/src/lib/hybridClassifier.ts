// src/lib/hybridClassifier.ts
import { LABELS, type Label } from "./rules";
import type { LF } from "./lf";
import { getDefaultLFs } from "./lf";
import weightsJson from "../../data/weights.json"; // tsconfigでresolveJsonModuleが必要

type Weights = {
  lfWeights?: Record<string, number>;
  ngram?: Partial<Record<Label, Record<string, number>>>;
};

const weights: Weights = (weightsJson ?? {}) as Weights;

export function scoreWithLFs(text: string, lfs: LF[] = getDefaultLFs()): Record<Label, number> {
  const sums: Record<Label, number> = Object.fromEntries(LABELS.map(l => [l, 0])) as any;

  for (const lf of lfs) {
    const x = Math.max(0, Math.min(1, lf.apply(text)));
    const w = weights.lfWeights?.[lf.name] ?? 1.0;
    sums[lf.label] += x * w;
  }

  // n-gram（素朴な部分一致。必要なら前処理/形態素を追加）
  if (weights.ngram) {
    for (const lab of LABELS) {
      const table = weights.ngram[lab];
      if (!table) continue;
      for (const [gram, w] of Object.entries(table)) {
        if (!gram) continue;
        if (text.includes(gram)) sums[lab] += w ?? 0;
      }
    }
  }

  return sums;
}

export function softmax(scores: Record<Label, number>): Record<Label, number> {
  const vals = LABELS.map(l => scores[l]);
  const max = Math.max(...vals);
  const exps = LABELS.map(l => Math.exp(scores[l] - max));
  const Z = exps.reduce((a, b) => a + b, 0) || 1;
  const prob: Record<Label, number> = {} as any;
  LABELS.forEach((l, i) => (prob[l] = exps[i] / Z));
  return prob;
}

export function classifyHybrid(text: string): {
  primary: Label;
  probs: Record<Label, number>;
  composition: { label: Label; pct: number }[];
} {
  const s = scoreWithLFs(text);
  const p = softmax(s);
  const primary = LABELS.slice().sort((a, b) => p[b] - p[a])[0];
  const composition = LABELS.map(l => ({ label: l, pct: p[l] * 100 }));
  return { primary, probs: p, composition };
}

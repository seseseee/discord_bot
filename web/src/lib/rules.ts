// src/lib/rules.ts
// 先頭付近
import weightsJson from "../../data/weights.json"; // resolveJsonModule が true 前提
// 動的語彙（学習結果）
import dynJson from "../../data/lexicon.json" assert { type: "json" };

// 型があると安心
type DynLex = Record<Label, string[]> & { _meta?: any };
// ラベル→Set（O(1)検索）
const DYN: Record<Label, Set<string>> = {
  AG: new Set<string>(((dynJson as DynLex).AG || []).filter(s => s && s.length >= 2)),
  TP: new Set<string>(((dynJson as DynLex).TP || []).filter(s => s && s.length >= 2)),
  EM: new Set<string>(((dynJson as DynLex).EM || []).filter(s => s && s.length >= 2)),
  S:  new Set<string>(((dynJson as DynLex).S  || []).filter(s => s && s.length >= 2)),
  Q:  new Set<string>(((dynJson as DynLex).Q  || []).filter(s => s && s.length >= 2)),
  CH: new Set<string>(((dynJson as DynLex).CH || []).filter(s => s && s.length >= 2)),
  NG: new Set<string>(((dynJson as DynLex).NG || []).filter(s => s && s.length >= 2)),
};

// 文字正規化（軽め）：全角英数記号→半角、長音・連続空白の簡易整理など（必要十分の最小版）
function normalizeLight(s: string) {
  return s
    .replace(/[！-～]/g, ch => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0)) // 全角→半角
    .replace(/[ｰ－—―ー]+/g, "ー")        // 長音の正規化
    .replace(/\s+/g, " ")                // 空白圧縮
    .trim();
}

// “含まれていればヒット”を簡易実装（日本語は単語境界が難しいので部分一致）
function hasDyn(text: string, label: Label): string[] {
  const t = normalizeLight(text);
  const out: string[] = [];
  for (const w of DYN[label]) {
    if (t.includes(w)) out.push(w);
  }
  return out;
}

const W = weightsJson as {
  labelBias: Record<string, number>;
  triggers: Record<string, number>;
};

function trig(name: string): number {
  return (W?.triggers?.[name] ?? 1);
}
function bias(lab: Label): number {
  return (W?.labelBias?.[lab] ?? 1);
}

// === ラベル定義（BOTなし） ============================================
export type Label = "AG" | "TP" | "EM" | "S" | "Q" | "CH" | "NG";
export const LABELS: readonly Label[] = ["AG", "TP", "EM", "S", "Q", "CH", "NG"] as const;

// タイブレーク優先度（同点時の勝ち順）
//   Qは明確な疑問にのみ、NGは否定が見えたらAG等より優先
const PRIORITY: Label[] = ["TP", "Q", "NG", "AG", "EM", "S", "CH"];

// === ルール用 正規表現 ================================================
const RE = {
  // URL/情報
  url: /https?:\/\/\S+/i,
  infoKw: /(資料|論文|URL|リンク|画像|動画|You ?Tube|J-?STAGE|表|一覧|データ|結果|議事録)/i,

  // 日時/スケジュール
  date: /\b(?:\d{4}[/-]\d{1,2}[/-]\d{1,2}|\d{1,2}月\d{1,2}日)\b/,
  time: /\b\d{1,2}[:：]\d{2}\b/,
  scheduleVerb: /(開催|集合|開始|実施|配信|締切|〆切|スケジュール|予定|予約|出欠|募集)/,

  // アナウンス/提案
  announce: /(募集|お知らせ|告知|DM|参加者|開催|締切|〆切|場所|日時|参加|来て|募集します)/,
  propose: /(提案|決めませんか|どう思う|テーマ募集|議論しよう|新しい話題)/,

  // 体癖/種っぽい話題
  taikei: /\(\d+(?:-\d+){1,3}\)|\b\d(?:-\d){1,3}\b/,
  numShu: /(?:\d+|[一二三四五六七八九十]+)\s*種|何種/i,

  // 同意・感情
  agree: /(賛成|同意|同感|了解|わかる|それな|それはそう|たしかに|確かに|OK|いいね|その通り|助かる)/i,
  emotion: /(嬉しい|楽しい|悲しい|疲れた|やばい|最高|最低|草|笑|ｗ|w|！{2,}|!{2,})/i,

  // 「ｗ/www だけ」
  laughOnly: /^\s*(?:w|ｗ)+\s*$/i,

  // 「まじか/マジか」（※「まじめ」は除外：まじ(?!め)）
  surpriseMajika: /(まじ(?!め)|マジ)(?:かよ?|[!！?？]+)?\s*$/i,

  // 褒め（称賛）
  praise: /(やりますねぇ?|やるじゃん|さすが|すごい|凄い|ナイス|nice|gj|グッジョブ|bravo|拍手|ぱちぱち|👏|上手い|うまい|うめぇ|上出来|お見事|神ってる|神|天才|えらい|つよい|強い|強すぎ)/i,

  // 疑問
  question: /[?？]\s*$/i,
  kanaTail: /かな[。…！!]*\s*$/i,
  // ※全角パイプではなく半角「|」で列挙する！
  jaQuestionHints: /(なんで|なんだろう|だろうか|かなぁ?|かしら|どうかな|どうだろう|教えて|知りたい|分からん|わからん|ってできるっけ|できるっけ|ないんだっけか|だっけか|っけ\??)\s*$/i,
  // 関西系ツッコミ疑問
  kansaiQ: /(?:なんでやねん|なんやねん)(?:[!！?？]*\s*(?:w|ｗ)*)?\s*$/i,

  // 弱い断定/示唆
  hedge: /(っぽい|っぽそう|気がする|と思う|では|じゃないか|かも|っけ)/i,

  // 雑談
  chit: /(はえぇ|なるほど|おつかれ|ふむ|へぇ|たぶん|かも|笑)/i,
  chitHead: /^(いや|いやー|いやぁ?|まぁ|まじで|ほんとに|それは|たしかに|うーん|えーと|おお|へえ|ふーむ)/i,

  // 共感/同調（関西語尾など）
  empathy: /(それは|そりゃ)?\s*(つらい|しんどい|大変|きつい|嫌|いや|だるい?|無理|むり|ひどい|酷い|かわいそう)(やな|よな|やね|よね|やわ|やろ|なぁ?|ねぇ?)\b/i,
  kansaiDislike: /いややな(?:ぁ|あ|ー)?/i,
  endAgree: /(やな|よな|やね|よね)(?:[ぁー~]*)(?:\s*[wｗ]+)?\s*$/i,

  // 否定/却下/反対（NG）
  negEmoji: /[🙅🚫❌✖✕]/,
  negPhrase1: /(それは|そりゃ|流石に)?\s*(なし|無し|ない|無い)\s*でしょ[うー]?/i, // それはなしでしょ
  negPhrase2: /それは\s*(なし|無し|ない|無い)/i,                          // それは無し
  negWord: /(だめ|ダメ|駄目|よくない|良くない|微妙|論外|無理|むり|却下|反対|不要|いらん|いらない|NG|ボツ|没)/i,
  negDiff: /(違う|ちゃう)(やろ|やん|でしょ|だろ|だわ)?\??|違くない[?？]/i,
};

// === 重み =============================================================
const WEIGHT: Record<Label, number> = {
  TP: 3.5,
  Q: 3.2,
  NG: 3.2,  // 否定/却下は強め
  AG: 3.0,  // 称賛・共感を強め（CHより優先）
  EM: 2.2,
  S: 2.0,
  CH: 1.0,
};

// === ユーティリティ ====================================================
type Score = { score: number; hits: string[] };
function initScores(): Record<Label, Score> {
  return {
    TP: { score: 0, hits: [] },
    Q: { score: 0, hits: [] },
    NG: { score: 0, hits: [] },
    AG: { score: 0, hits: [] },
    EM: { score: 0, hits: [] },
    S: { score: 0, hits: [] },
    CH: { score: 0, hits: [] },
  };
}
function add(r: Record<Label, Score>, lab: Label, w: number, why: string) {
  // ★ トリガー重み × ラベルバイアス を掛ける
  const mult = trig(why) * bias(lab);
  r[lab].score += w * mult;
  r[lab].hits.push(why);
}
function isQuestionLike(t: string) {
  const s = (t || "").trim();
  return (
    (RE.question.test(s) && !RE.kanaTail.test(s)) ||
    RE.jaQuestionHints.test(s) ||
    RE.kansaiQ.test(s)
  );
}
function isStrongEmpathy(t: string) {
  const s = (t || "").trim();
  return RE.kansaiDislike.test(s) || RE.endAgree.test(s) || RE.empathy.test(s);
}
function isNegationLike(t: string) {
  const s = (t || "").trim();
  return (
    RE.negEmoji.test(s) ||
    RE.negPhrase1.test(s) ||
    RE.negPhrase2.test(s) ||
    RE.negWord.test(s) ||
    RE.negDiff.test(s)
  );
}
function isSurpriseMajika(t: string) {
  return RE.surpriseMajika.test((t || "").trim());
}

// === 事後ゲート =======================================================
// 事後ゲート：否定>Q、共感>Q、驚き→EM、S固定
export function postFix(text: string, label: Label): Label {
  if (isNegationLike(text)) return "NG";
  if (isQuestionLike(text)) return "Q";
  if (isStrongEmpathy(text)) return "AG";
  if (isSurpriseMajika(text)) return "EM"; // まじか/マジか
  if (
    RE.url.test(text) || RE.infoKw.test(text) ||
    ((RE.date.test(text) || RE.time.test(text)) && RE.scheduleVerb.test(text))
  ) return "S";
  return label;
}
export function isNegationLikePublic(text: string): boolean {
  return isNegationLike(text);
}

// 構成比を「主=70%・残り等分」で整形（主が必ず最大）
function buildComposition(primary: Label, scores: Record<Label, Score>) {
  const scored = LABELS
    .map(l => ({ label: l, score: Math.max(0, scores[l].score) }))
    .filter(x => x.score > 0);
  const pool = Array.from(new Set<Label>([primary, ...scored.map(x => x.label)]));

  if (pool.length === 0) {
    return LABELS.map(l => ({ label: l, pct: l === primary ? 100 : 0 }));
  }
  if (pool.length === 1) {
    return LABELS.map(l => ({ label: l, pct: l === pool[0] ? 100 : 0 }));
  }
  const TOP = 70; // 好みで調整可能
  const others = pool.filter(l => l !== primary);
  const per = (100 - TOP) / others.length;
  const map = new Map<Label, number>([[primary, TOP], ...others.map(o => [o, per] as [Label, number])]);
  return LABELS.map(l => ({ label: l, pct: +(map.get(l) ?? 0).toFixed(2) }));
}

// === 本体 =============================================================
export function classifyByRules(textRaw: string) {
  const text = (textRaw || "").trim();
  const r = initScores();
  if (!text) add(r, "CH", WEIGHT.CH, "empty");
  
// ===== 動的語彙ヒットの加点（静的REよりは弱め、でも無視されない程度） =====
for (const lab of LABELS) {
  const hits = hasDyn(text, lab);
  if (hits.length) add(r, lab, WEIGHT[lab] * 0.9, `dyn:${hits.slice(0, 3).join(",")}${hits.length>3?"...":""}`);
}

  const hasUrlOrInfo = RE.url.test(text) || RE.infoKw.test(text);
  const hasDatetime = RE.date.test(text) || RE.time.test(text);
  const questionLike = isQuestionLike(text);
  const empathyLike = isStrongEmpathy(text);
  const negLike = isNegationLike(text);
  const surpriseLike = isSurpriseMajika(text);

  // S
  if (hasUrlOrInfo) add(r, "S", WEIGHT.S * 2, "url|infoKw");
  if (hasDatetime && (RE.scheduleVerb.test(text) || hasUrlOrInfo)) add(r, "S", WEIGHT.S, "datetime");

  // TP
  if (RE.announce.test(text)) add(r, "TP", WEIGHT.TP * 1.5, "announce");
  if (RE.propose.test(text)) add(r, "TP", WEIGHT.TP * 1.25, "propose");
  if (RE.taikei.test(text)) add(r, "TP", WEIGHT.TP * 1.1, "taikei");
  if (RE.hedge.test(text) && (hasUrlOrInfo || RE.numShu.test(text))) add(r, "TP", WEIGHT.TP, "hedge+topic");

  // AG / EM / CH
  if (RE.agree.test(text)) add(r, "AG", WEIGHT.AG * 1.1, "agree");
  if (RE.praise.test(text)) add(r, "AG", WEIGHT.AG * 1.1, "praise");
  if (RE.emotion.test(text) || RE.laughOnly.test(text)) add(r, "EM", WEIGHT.EM * 1.1, "emotion");
  if (RE.chit.test(text) || RE.chitHead.test(text)) add(r, "CH", WEIGHT.CH, "chit");
  if (surpriseLike) add(r, "EM", WEIGHT.EM * 1.2, "majika");

  // NG（否定/却下/反対）
  if (negLike) add(r, "NG", WEIGHT.NG * 1.3, "negation");

  // Q（疑問）
  if (questionLike) {
    const why =
      RE.kansaiQ.test(text) ? "kansaiQ" :
        RE.jaQuestionHints.test(text) ? "jaQuestionHints" :
          "question";
    add(r, "Q", WEIGHT.Q * 1.1, why);
  }

  // 勝者決定（PRIORITYでタイブレーク）
  let winner: Label = "CH";
  let best = -Infinity;
  for (const lab of PRIORITY) {
    const s = r[lab].score;
    if (s > best || (s === best && PRIORITY.indexOf(lab) < PRIORITY.indexOf(winner))) {
      best = s; winner = lab;
    }
  }

  // 信頼度
  const total =
    (Object.values(r) as Score[]).reduce((a, b) => a + Math.max(0, b.score), 0) || 1;
  const rawConf = Math.min(1, Math.max(0, best / total));
  let confidence = 0.5 + rawConf * 0.5; // 0.5〜1.0
  if (hasUrlOrInfo) confidence = Math.max(confidence, 0.85);
  if (negLike || empathyLike) confidence = Math.max(confidence, 0.8);

  // ★ 事後補正で主ラベル最終確定（ここが重要！）
  const fixed = postFix(text, winner);
  if (fixed !== winner) {
    winner = fixed;
    confidence = Math.max(confidence, 0.8);
  }

  // ★ 構成比は「主=70%・残り等分」で整形して必ず整合
  const composition = buildComposition(winner, r);

  // 副ラベル（構成比>0%の降順、先頭は主）
  const labels = Array.from(
    new Set<Label>([
      winner,
      ...composition
        .filter(c => c.pct > 0)
        .sort((a, b) => b.pct - a.pct)
        .map(c => c.label as Label),
    ])
  );

  const why: string[] = [];
  for (const lab of PRIORITY) if (r[lab].score > 0) why.push(`${lab}:${r[lab].hits.join("|")}`);

  return {
    label: winner as Label,
    labels,
    confidence,
    rationale: why.join(" / "),
    composition,
  };
}

// 公開API（ルール直接 → API が使う形）
export function classifyMessage(text: string): {
  label: Label;
  labels: Label[];
  confidence: number;
  rationale: string;
  composition: { label: Label; pct: number }[];
} {
  const r = classifyByRules(text);
  return {
    label: r.label,
    labels: r.labels,
    confidence: r.confidence,
    rationale: r.rationale,
    composition: r.composition,
  };
}

// 正規化（LLMが "AG|TP" など返す時の吸収）
export function normalizeLabel(raw: string, originalText?: string): Label {
  if (!raw) return "CH";
  const upper = raw.toUpperCase();
  const parts = upper
    .replace(/[^\|A-Z]/g, (ch) => (/[A-Z]/.test(ch) ? ch : "|"))
    .split(/\|+/)
    .map((s) => s.trim())
    .filter(Boolean) as string[];

  const ORDER: Label[] = ["TP", "Q", "NG", "AG", "EM", "S", "CH"];
  for (const p of ORDER) if (parts.includes(p)) return p;
  for (const p of ORDER) if (upper.includes(p)) return p;

  try {
    return classifyByRules(originalText ?? "").label;
  } catch {
    return "CH";
  }
}

// 既存の public 関数に追加で公開（必要に応じてファイル先頭付近へ）
export function isQuestionLikePublic(t: string) {
  const s = (t || "").trim();
  return (
    (RE.question.test(s) && !RE.kanaTail.test(s)) ||
    RE.jaQuestionHints.test(s) ||
    RE.kansaiQ.test(s)
  );
}

// 文脈つきラベル付け（直前の発言たちを参照して補正）
export function classifyMessageWithContext(
  text: string,
  ctx?: { prev?: string[] }   // 直前N件の本文（古→新の順 or 順不同どちらでも可）
) {
  const base = classifyMessage(text);
  const prevList = (ctx?.prev ?? []).filter(Boolean);
  const prev = prevList.length ? prevList[prevList.length - 1] : "";

  let label = base.label;
  let labels = Array.from(new Set<Label>([base.label, ...base.labels]));
  let confidence = base.confidence;
  let rationale = base.rationale;
  let composition = base.composition;

  // 1) 関西ツッコミ等 → 直前が「陳述」なら Q を強化
  if (isQuestionLikePublic(text) && prev) {
    label = "Q";
    confidence = Math.max(confidence, 0.9);
    rationale += " / ctx:kansaiQ_after_statement";
  }

  // 2) 「それはそう/たしかに」など → 直前を受けた同意として AG
  if (/^(それはそう|たしかに|確かに)\b/i.test(text) && prev) {
    label = "AG";
    confidence = Math.max(confidence, 0.9);
    rationale += " / ctx:agree_prev";
  }

  // 3) 強い共感ワード + 直前がネガティブなら AG に寄せる
  if (isStrongEmpathy(text) && (isNegationLike(prev) || /(疲れた|しんどい|嫌|だる|最悪|つらい)/i.test(prev))) {
    label = "AG";
    confidence = Math.max(confidence, 0.9);
    rationale += " / ctx:empathy_to_negative_prev";
  }

  // 構成比を「主:70% + 残り均等」寄せに調整
  const TOP = 70;
  const uniqLabels = Array.from(new Set<Label>([label, ...labels]));
  const others = uniqLabels.filter(l => l !== label);
  const rest = others.length ? (30 / others.length) : 0;

  const map = new Map<Label, number>();
  map.set(label, TOP);
  for (const o of others) map.set(o, rest);

  composition = LABELS.map(l => ({ label: l, pct: Math.round((map.get(l) ?? 0) * 100) / 100 }));

  labels = Array.from(new Set<Label>([label, ...labels]));

  return { label, labels, confidence, rationale, composition };
}

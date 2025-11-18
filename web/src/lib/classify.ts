import { AnalysisResult } from "./utils";
import { CLASSIFY_SYS, CLASSIFY_USER } from "./prompts";
import { chatJson } from "./llm";

const EMO = /(嬉しい|楽しい|最高|好き|嫌|悲しい|泣|怒|ムカ|草|www|やば|助かる|ありがと|感動|つらい|疲れ|しんど|不安|怖い|寂しい)/i;
const INVITE = /(どう思う|意見|議論|提案|案|募集|比較|反証|検討|考え)/i;
const QUESTION = /[?？]|(教えて|わから|分から|不明|ですか|でしょうか|なぜ|どこ|いつ|だれ|誰|どうやって)/i;
const AGREE = /(賛成|同意|了解|いいね|それな|なるほど|:+1:|👍)/i;
const DISAGREE = /(反対|違う|いや|良くない|だめ|ダメ|無理|却下|否定)/i;
const BOTLIKE = /(joined the server|pinned a message|スレッドを作成|メッセージを固定)/i;
const URL = /https?:\/\/\S+/i;

export async function classifyText(text: string): Promise<AnalysisResult> {
  const base: AnalysisResult = { label: "CH", labels: ["CH"], confidence: 0.55, rationale: "" };

  // BOT
  if (BOTLIKE.test(text)) return { ...base, label: "BOT", labels:["BOT"], confidence: 0.99, rationale: "システム通知/定型" };

  // ヒューリスティック初期値
  const votes: Record<string, number> = { CH: 0 };
  if (EMO.test(text)) votes["EM"] = (votes["EM"]||0)+2;
  if (QUESTION.test(text)) votes["Q"]  = (votes["Q"]||0)+3;
  if (URL.test(text)) votes["S"]  = (votes["S"]||0)+2;
  if (INVITE.test(text)) votes["TP"] = (votes["TP"]||0)+2;
  if (AGREE.test(text)) votes["AG"] = (votes["AG"]||0)+2;
  if (DISAGREE.test(text)) votes["NG"] = (votes["NG"]||0)+2;

  // LLM で上書き挑戦（失敗時はヒューリスティック採用）
  const llm = await chatJson(
    [{ role: "system", content: CLASSIFY_SYS }, { role: "user", content: CLASSIFY_USER(text) }],
    null
  );
  if (llm?.label) {
    const label = String(llm.label).toUpperCase();
    const labels = Array.isArray(llm.labels)? llm.labels.map((x:string)=> String(x).toUpperCase()) : [label];
    const conf = typeof llm.confidence === "number" ? llm.confidence : 0.75;
    const comp = Array.isArray(llm.composition)? llm.composition : [{ label, pct: 100 }];
    const rationale = typeof llm.rationale === "string" ? llm.rationale : "";
    return { label: (label as any), labels, confidence: conf, composition: comp, rationale };
  }

  // Fallback
  const ranked = Object.entries(votes).sort((a,b)=> (b[1]||0)-(a[1]||0)).map(([k])=>k);
  const main = (ranked[0] || "CH") as AnalysisResult["label"];
  const comp = ranked.map((k,i)=> ({ label: k, pct: Math.round((ranked.length-i)/ranked.length*100/(ranked.length||1)) }));
  const rationale =
    main==="Q"? "疑問符/確認語の出現" :
    main==="S"? "URL/情報共有の比率が高い" :
    main==="EM"? "感情語の出現" :
    main==="TP"? "議論・提案語彙" :
    main==="AG"? "同意/賛成の語彙" :
    main==="NG"? "反対/否定の語彙" : "雑談/その他";
  return { label: main, labels: ranked, confidence: 0.62, composition: comp, rationale };
}

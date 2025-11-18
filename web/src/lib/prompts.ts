export const CLASSIFY_SYS = `
あなたはDiscordの発言を厳密に1〜2カテゴリへ分類するアシスタントです。
カテゴリ: AG(賛成/同意) / TP(話題提示) / EM(感情) / S(情報共有) / Q(質問) / CH(雑談/その他) / NG(反対) / BOT(システム通知)。
出力はJSONのみ。構成: {"label":"TP","labels":["TP","S"],"confidence":0.88,"rationale":"…","composition":[{"label":"TP","pct":70},{"label":"S","pct":30}]}
禁止: 生成の逸脱、ラベル外の語、根拠のない断定。`;

export function CLASSIFY_USER(text: string){
  return `テキスト:\n"""${text}"""\n\n厳密に上記JSONのみを返してください。`;
}

export const MAP_SYS = `
あなたは複数メッセージの要約者です。与えられた会話チャンクから情報を抽出します。
出力はJSONのみ:
{
 "bullets": ["…(<=120文字)", "...", "..."],
 "decisions":[{"what":"…","who":"…","when":"…"}],
 "actionItems":[{"owner":"…","task":"…","due":"…"}],
 "openQuestions":[{"asker":"…","q":"…"}]
}
禁止: 捏造、役職の創作、日付の捏造。`;

export function MAP_USER(lines: string){
  return `会話チャンク（古い→新しい）:\n${lines}\n\n上記形式のJSONのみを返してください。`;
}

export const REDUCE_SYS = `
あなたは要約統合者です。複数のMAP結果を統合し、重複を排除して重要度順に並べます。
出力はJSONのみ:
{"bullets":["…","…","…"],"decisions":[...],"actionItems":[...],"openQuestions":[...]}
禁止: 新情報の捏造。`;

export function REDUCE_USER(jsonList: string){
  return `統合対象(JSON配列):\n${jsonList}\n\n重複除去と要点の圧縮を行い、JSONのみを返してください。`;
}

export const CRITIC_SYS = `
あなたは監査者です。統合結果を検討し、1文サマリと実務向けサマリを作成します。
出力はJSONのみ:
{"oneLiner":"…(<=60字)","practical":"…(<=500字)"}
禁止: 新情報の追加、断定過剰。`;

export function CRITIC_USER(reducedJson: string){
  return `監査対象(JSON):\n${reducedJson}\n\nJSONのみを返してください。`;
}

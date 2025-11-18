# ChatViz Metrics (Discord) — README

Discord のチャットを研究目的で収集し、発話を**簡易分類→可視化**する最小構成（MVP）です。
カテゴリは **AG, TP, EM, S, Q, CH, NG**（同意/話題提示/感情/情報共有/質問/雑談/否定）。

## 可視化する主な指標

* **情報言及数**：URL・数値のユニーク件数
* **最低発言量**：期間内ユーザ別トークン数の最小
* **相互メンション密度**：相互メンションの割合
* **カテゴリ内訳**：AG/TP/EM/S/Q/CH/NG の比率
* （任意）**主観的公平性**：`/fairness` 等のアンケート導線がある場合のみ

---

## アーキテクチャ

* **Web/API**：Next.js 14 + Prisma（DB: SQLite）
* **Discord Bridge**：Discord のイベント → `web` の Ingest API へ送信
* **LLM アダプタ**：Ollama（`qwen2.5:7b` など） / llama.cpp-server（GGUF）
* **Port**：Web は `http://localhost:3001`

データフロー：Discord → Bridge → `/api/ingest/discord` → DB
分析：ルール +（任意で）LLM → `/api/analyze/batch`（ワーカー自動化も可）
フィードバック：絵文字リアクション → `/api/feedback`（学習トリガ更新）

---

## クイックスタート

### 0) 前提

* Node.js **18+**（推奨 20+）
* Discord Bot トークン取得済み
* LLM は **Ollama** または **llama.cpp** をローカル起動

### 1) セットアップ（web）

```bash
cd web
cp .env.example .env   # なければ .env を新規作成
npm i
npm run prisma:generate
npm run prisma:migrate
```

**.env 例（抜粋）**

```env
# DB
DATABASE_URL=file:./dev.db

# LLM（どちらか/両方に対応）
ANALYSIS_USE_OLLAMA=true
OLLAMA_BASE=http://127.0.0.1:11434
OLLAMA_MODEL=qwen2.5:7b

ANALYSIS_USE_LLAMA_CPP=true
LLAMA_BASE=http://127.0.0.1:8080
LLAMA_MODEL=C:\llama.cpp\models\swallow-8b-v0_3\Llama-3.1-Swallow-8B-Instruct-v0.3.Q5_K_M.gguf

# Web
BASE_URL=http://localhost:3001
ANALYZER_BASE=http://localhost:3001

# Discord
DISCORD_TOKEN=（あなたのBotトークン）
SERVER_ID=（対象サーバID）
NEXT_PUBLIC_SERVER_ID=（同上）
REGISTER_SLASH=true   # 必要なら

# 監視対象チャンネル（任意）
DISCORD_CHANNEL_IDS=xxxxx,yyyyy
ANALYSIS_CHANNEL_ID=xxxxx
```

### 2) LLM の起動

**Ollama**

```bash
ollama serve
ollama pull qwen2.5:7b
```

**llama.cpp server（例）**

```powershell
.\server.exe `
  -m "C:\llama.cpp\models\swallow-8b-v0_3\Llama-3.1-Swallow-8B-Instruct-v0.3.Q5_K_M.gguf" `
  --port 8080 -c 8192 -ngl 999 -t 16 --embedding
```

> 両方 true の場合、Ollama を優先し、失敗時に llama.cpp へフォールバックします。

### 3) 起動

開発時に **Web + Bridge** をまとめて起動：

```bash
npm run start:bridge:dev
# Web: http://localhost:3001
```

個別に起動する場合：

```bash
npm run dev            # Web/API
npm run start:bridge   # Discord Bridge
```

---

## 使い方

1. Bot を Discord サーバへ招待（権限：メッセージ閲覧・リアクション取得など）
2. メッセージが流れると **Ingest**：`/api/ingest/discord` に保存
3. ブラウザで **[http://localhost:3001](http://localhost:3001)** にアクセスしてサマリーを見る
4. **解析**：自動（ワーカー）または手動でバッチ実行

   * 手動: `POST /api/analyze/batch?serverId=...&limit=50&force=true`
5. **フィードバック（学習）**：絵文字リアクションでラベル付与/取消

   * 付与 → `/api/feedback` が呼ばれ、`Trigger(hits/weight)` を増加
   * 取消 → リアクション削除で `/api/feedback/delete` が呼ばれ、減算

### ラベルに対応するリアクション

* **AG（同意）**：`👍` `🆗` `✅`
* **TP（話題提示）**：`🗓️` `📅`
* **EM（感情）**：`😊` `😆` `😂` `🤣` `😢` `😡`
* **S（情報共有）**：`ℹ️` `📎` `🔗`
* **Q（質問）**：`❓` `❔`
* **CH（雑談）**：`💬` `🗨️`
* **NG（否定）**：`⛔` `❌` `🚫` `✖` `✕`

**取り消し用（拡張）**：`🗑️/🗑` を押すと、そのユーザーの該当メッセージへのフィードバックを**取り消し**（`/api/feedback` 内実装）。

> カスタム絵文字も、名前が `agree/question/topic` 等に合えばラベル化されます。

---

## 自動化

### 解析ワーカー

```bash
npm run worker:analyze   # 未解析メッセージを常駐で自動分類
```

### CSV エクスポート

```bash
npm run worker:export    # 指定間隔で exports/ に出力（S3設定があれば自動アップロード）
```

### まとめて起動（開発セット）

```bash
npm run start:all   # WEB + 解析ワーカー + エクスポート
```

---

## 再学習（辞書の自動生成）

フィードバック（リアクション）を学習して `data/lexicon.json` を更新します。

```bash
npm run retrain
# 週次運用の例（ロールバック付き）
npm run retrain:weekly
```

環境変数（任意）：

* `RETRAIN_DAYS`（既定 14）
* `RETRAIN_MIN_COUNT` / `RETRAIN_MIN_RATIO`（しきい値）
* `RETRAIN_SERVER_ID`（特定サーバのみ学習）

---

## テストセット評価

`test/testset.json` を用意：

```json
[
  { "id": "t1", "text": "この資料→ https://x.y", "expected": "S" },
  { "id": "t2", "text": "週末にやりませんか？", "expected": "TP" },
  { "id": "t3", "text": "それはそう", "expected": "AG" }
]
```

実行：

```bash
npm run testset
# 環境変数:
# TEST_BASE_URL=http://localhost:3001
# TEST_SERVER_ID=testserver
# TEST_INCLUDE_BOT=true  # BOT行も採点する場合
```

---

## 主要スクリプト一覧

```bash
# Web/API 起動
npm run dev

# Discord ブリッジ
npm run start:bridge
npm run start:bridge:dev

# 一括（WEB + 解析 + 出力）
npm run start:all

# 再学習
npm run retrain
npm run retrain:weekly

# テストセット
npm run testset

# Prisma
npm run prisma:generate
npm run prisma:migrate
npm run prisma:studio
```

---

## 主な環境変数（抜粋）

* **DB**
  `DATABASE_URL=file:./dev.db`（SQLite）
* **LLM**
  `ANALYSIS_USE_OLLAMA` / `OLLAMA_BASE` / `OLLAMA_MODEL`
  `ANALYSIS_USE_LLAMA_CPP` / `LLAMA_BASE` / `LLAMA_MODEL`
* **Web**
  `BASE_URL` / `ANALYZER_BASE`
* **Discord**
  `DISCORD_TOKEN` / `SERVER_ID` / `NEXT_PUBLIC_SERVER_ID` / `REGISTER_SLASH`
  `DISCORD_CHANNEL_IDS` / `ANALYSIS_CHANNEL_ID`（任意）
* **Export**
  `EXPORT_INTERVAL_MS` / `EXPORT_DAYS` / `EXPORT_DIR`
  `AWS_S3_BUCKET`（設定時は S3 へ自動アップロード）

---

## 備考・運用のヒント

* 高精度が必要なら、**ルール + 学習トリガ**に加えて LLM（Ollama/llama.cpp）を有効化。
* 本MVPは最小構成です。プロダクション用途では **認証・レート制限・監査ログ・エラー監視** を追加してください。
* フィードバックは**誰のリアクションでも反映**されます。制限したい場合は Bridge 側で **許可ユーザー（`TRUST_USER_IDS`）** をチェックしてください。

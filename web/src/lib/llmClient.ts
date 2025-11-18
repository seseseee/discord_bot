/* eslint-disable @typescript-eslint/no-explicit-any */
import { setTimeout as delay } from 'timers/promises';

type Role = 'system' | 'user' | 'assistant';
export type ChatMessage = { role: Role; content: string };

export type ChatOptions = {
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
  stop?: string[];
  signal?: AbortSignal;
  onToken?: (t: string) => void; // stream 時のコールバック
};

type Provider = 'ollama' | 'llama';

const env = {
  provider: (process.env.LLM_PROVIDER as Provider | undefined),
  // Ollama
  ollamaBase: process.env.OLLAMA_BASE ?? 'http://127.0.0.1:11434',
  ollamaModel: process.env.OLLAMA_MODEL ?? 'qwen2.5:7b',
  // llama.cpp server
  llamaBase: process.env.LLAMA_BASE ?? 'http://127.0.0.1:8080',
  llamaModel: process.env.LLAMA_MODEL ?? 'llama', // 任意
};

// Node18+ なら fetch はグローバル
const j = (o: any) => JSON.stringify(o);
const ok = (r: Response) => r.ok;

async function isOpenAICompatible(base: string): Promise<boolean> {
  try {
    const r = await fetch(`${base.replace(/\/+$/, '')}/v1/models`, { method: 'GET' });
    return r.ok;
  } catch {
    return false;
  }
}

async function hasHealth(base: string): Promise<boolean> {
  try {
    const r = await fetch(`${base.replace(/\/+$/, '')}/health`, { method: 'GET' });
    if (!r.ok) return false;
    const t = await r.text();
    return t.includes('ok') || t.includes('"status":"ok"');
  } catch {
    return false;
  }
}

function toPrompt(messages: ChatMessage[]): string {
  // llama.cpp ネイティブ /completion 用に簡易フォーマット化
  // （System / User / Assistant を見やすく連結）
  let out = '';
  for (const m of messages) {
    if (m.role === 'system') out += `### System:\n${m.content}\n\n`;
    if (m.role === 'user') out += `### User:\n${m.content}\n\n`;
    if (m.role === 'assistant') out += `### Assistant:\n${m.content}\n\n`;
  }
  out += `### Assistant:\n`; // 続きを生成
  return out;
}

export class LLMClient {
  private provider: Provider | undefined;
  private detected: Provider | null = null;
  private detectionOnce?: Promise<void>;

  constructor(initProvider?: Provider) {
    this.provider = initProvider ?? env.provider;
  }

  // 明示指定が無ければ起動中バックエンドを自動検出
  private async ensureDetection() {
    if (this.provider) {
      this.detected = this.provider;
      return;
    }
    if (this.detectionOnce) return this.detectionOnce;

    this.detectionOnce = (async () => {
      // 1) Ollama 優先（既存挙動の継承）
      const tryOllama = await isOpenAICompatible(env.ollamaBase);
      if (tryOllama) { this.detected = 'ollama'; return; }

      // 2) llama.cpp（OpenAI 互換 → ネイティブの順に）
      const llamaOA = await isOpenAICompatible(env.llamaBase);
      if (llamaOA) { this.detected = 'llama'; return; }

      const llamaHealth = await hasHealth(env.llamaBase);
      if (llamaHealth) { this.detected = 'llama'; return; }

      // 3) 何も見つからなければデフォルトは Ollama に倒す
      this.detected = 'ollama';
    })();

    return this.detectionOnce;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    await this.ensureDetection();
    const provider = this.provider ?? this.detected ?? 'ollama';

    if (provider === 'ollama') {
      // OpenAI 互換 /v1 を経由（Ollama はデフォルトで対応）
      return this.chatOpenAICompat(env.ollamaBase, env.ollamaModel, messages, opts);
    }

    // llama ルート
    // まずは OpenAI 互換, ダメなら /completion にフォールバック
    if (await isOpenAICompatible(env.llamaBase)) {
      return this.chatOpenAICompat(env.llamaBase, env.llamaModel, messages, opts);
    }
    return this.chatLlamaNativeCompletion(env.llamaBase, env.llamaModel, messages, opts);
  }

  // ----- OpenAI 互換 (/v1/chat/completions) -----
  private async chatOpenAICompat(base: string, model: string, messages: ChatMessage[], opts: ChatOptions): Promise<string> {
    const url = `${base.replace(/\/+$/, '')}/v1/chat/completions`;
    const body = {
      model,
      messages,
      temperature: opts.temperature ?? 0.7,
      max_tokens: opts.maxTokens ?? 1024,
      stop: opts.stop,
      stream: !!opts.stream,
    };

    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // OpenAI 互換サーバは多くの場合 API Key 不要（必要なら環境変数で加えて下さい）
        // 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: j(body),
      signal: opts.signal,
    });

    if (!ok(r)) {
      const txt = await r.text().catch(()=>'');
      throw new Error(`[OpenAI-compat] ${r.status} ${r.statusText} ${txt}`);
    }

    if (!opts.stream) {
      const data = await r.json() as any;
      return data.choices?.[0]?.message?.content ?? '';
    }

    // stream: NDJSON / SSE 風（サーバ実装により "data: " 付き/無し両対応）
    const reader = r.body!.getReader();
    const decoder = new TextDecoder('utf-8');
    let full = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split(/\r?\n/).filter(Boolean);

      for (const line of lines) {
        const payload = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const delta: string =
            json.choices?.[0]?.delta?.content ??
            json.choices?.[0]?.message?.content ??
            json.choices?.[0]?.text ??
            '';

          if (delta) {
            full += delta;
            opts.onToken?.(delta);
          }
        } catch {
          // 一部サーバは JSON でない keep-alive を流す
        }
      }
    }
    return full;
  }

  // ----- llama.cpp ネイティブ (/completion) -----
  private async chatLlamaNativeCompletion(base: string, model: string, messages: ChatMessage[], opts: ChatOptions): Promise<string> {
    const url = `${base.replace(/\/+$/, '')}/completion`;
    const prompt = toPrompt(messages);

    const body = {
      prompt,
      // llama.cpp 側のオプション名に合わせる
      temperature: opts.temperature ?? 0.7,
      n_predict: opts.maxTokens ?? 1024,
      stop: opts.stop,
      cache_prompt: true,
      stream: !!opts.stream,
      // model/path を受けるビルドもあるため念のため含める（無視されても OK）
      model,
    };

    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: j(body),
      signal: opts.signal,
    });

    if (!ok(r)) {
      const txt = await r.text().catch(()=>'');
      throw new Error(`[llama-native] ${r.status} ${r.statusText} ${txt}`);
    }

    if (!opts.stream) {
      const data = await r.json() as any;
      // まとまって返す実装と、choices/内容で返す実装がある
      return data.content ?? data.choices?.[0]?.text ?? data.choices?.[0]?.message?.content ?? '';
    }

    // streaming: data:{json}\n の連続が基本
    const reader = r.body!.getReader();
    const decoder = new TextDecoder('utf-8');
    let full = '';

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split(/\r?\n/).filter(Boolean);

      for (const line of lines) {
        const payload = line.startsWith('data:') ? line.slice(5).trim() : line.trim();
        if (payload === '[DONE]') continue;
        try {
          const json = JSON.parse(payload);
          const token: string =
            json.content ??
            json.token ??
            json.delta ??
            json.choices?.[0]?.text ??
            '';

          if (token) {
            full += token;
            opts.onToken?.(token);
          }
        } catch {
          // 非 JSON 行は無視
        }
      }
    }
    return full;
  }
}

// ========== 簡単な動作テスト ==========
if (require.main === module) {
  (async () => {
    const client = new LLMClient();
    const out = await client.chat(
      [
        { role: 'system', content: 'You are a helpful assistant. Answer in Japanese.' },
        { role: 'user', content: 'この文の後に続けて、3文だけ返信してください。' },
      ],
      { temperature: 0.7, maxTokens: 128, stream: true, onToken: t => process.stdout.write(t) },
    );
    // 小休止（バッファ flush 用）
    await delay(30);
    if (!out) process.stdout.write('\n[no content]\n');
  })().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

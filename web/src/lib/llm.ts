import { extractJsonObject } from "./utils";

const PROVIDER = (process.env.LLM_PROVIDER || "llama").toLowerCase(); // "llama" | "ollama" | "openai"
const LLAMA_BASE = process.env.LLAMA_BASE || "http://127.0.0.1:8080";
const LLAMA_MODEL = process.env.LLAMA_MODEL || "llama";
const OLLAMA_BASE = process.env.OLLAMA_BASE || "http://127.0.0.1:11434";
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || "qwen2.5:7b";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

type Msg = { role: "system"|"user"|"assistant"; content: string };

async function callLlama(messages: Msg[], max_tokens=512, temperature=0.2){
  const url = `${LLAMA_BASE.replace(/\/+$/,'')}/v1/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type":"application/json" },
    body: JSON.stringify({ model: LLAMA_MODEL, messages, temperature, max_tokens }),
  });
  const j: any = await res.json().catch(()=> ({}));
  return j?.choices?.[0]?.message?.content as string | undefined;
}
async function callOllama(messages: Msg[], max_tokens=512, temperature=0.2){
  // OpenAI互換優先
  const url = `${OLLAMA_BASE.replace(/\/+$/,'')}/v1/chat/completions`;
  try{
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type":"application/json" },
      body: JSON.stringify({ model: OLLAMA_MODEL, messages, temperature, max_tokens }),
    });
    const j: any = await res.json().catch(()=> ({}));
    const content = j?.choices?.[0]?.message?.content as string | undefined;
    if (content) return content;
  }catch{}
  // 旧API fallback
  const gen = await fetch(`${OLLAMA_BASE.replace(/\/+$/,'')}/api/generate`, {
    method: "POST",
    headers: { "content-type":"application/json" },
    body: JSON.stringify({ model: OLLAMA_MODEL, prompt: messages.map(m=> `${m.role.toUpperCase()}: ${m.content}`).join("\n") })
  });
  const text = await gen.text();
  const lines = text.trim().split(/\r?\n/);
  for (let i=lines.length-1;i>=0;i--){
    try{ const j = JSON.parse(lines[i]); if (j?.response) return j.response; }catch{}
  }
  return undefined;
}
async function callOpenAI(messages: Msg[], max_tokens=512, temperature=0.2){
  const url = "https://api.openai.com/v1/chat/completions";
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type":"application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
    body: JSON.stringify({ model: OPENAI_MODEL, messages, temperature, max_tokens }),
  });
  const j: any = await res.json().catch(()=> ({}));
  return j?.choices?.[0]?.message?.content as string | undefined;
}

export async function chatJson(messages: Msg[], fallback?: any){
  let content: string | undefined;
  try {
    if (PROVIDER === "ollama") content = await callOllama(messages);
    else if (PROVIDER === "openai") content = await callOpenAI(messages);
    else content = await callLlama(messages);
  } catch {}
  const parsed = content ? extractJsonObject(content) : null;
  return parsed || fallback || null;
}

export async function chatText(messages: Msg[], fallback?: string){
  let content: string | undefined;
  try {
    if (PROVIDER === "ollama") content = await callOllama(messages);
    else if (PROVIDER === "openai") content = await callOpenAI(messages);
    else content = await callLlama(messages);
  } catch {}
  return content || fallback || "";
}

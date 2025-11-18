// src/config/env.ts
import 'dotenv/config';

function bool(v: string | undefined, def = false) {
  if (v == null) return def;
  return ['1', 'true', 'yes', 'on', 'y'].includes(v.trim().toLowerCase());
}

export const env = {
  DATABASE_URL: process.env.DATABASE_URL ?? 'file:./dev.db',

  ANALYSIS_USE_OLLAMA: bool(process.env.ANALYSIS_USE_OLLAMA, true),
  ANALYSIS_USE_LLAMA_CPP: bool(process.env.ANALYSIS_USE_LLAMA_CPP, false),

  LLAMA_BASE: process.env.LLAMA_BASE ?? 'http://127.0.0.1:8080',
  LLAMA_MODEL: process.env.LLAMA_MODEL ?? 'llama',

  OLLAMA_BASE: process.env.OLLAMA_BASE ?? 'http://127.0.0.1:11434',
  OLLAMA_MODEL: process.env.OLLAMA_MODEL ?? 'qwen2.5:7b',

  BASE_URL: process.env.BASE_URL ?? 'http://localhost:3001',
  ANALYZER_BASE: process.env.ANALYZER_BASE ?? 'http://localhost:3001',

  // ← ここが重要：トークンは絶対に直書きしない
  SERVER_ID: process.env.SERVER_ID ?? '944157981791113287',
  DISCORD_TOKEN: process.env.DISCORD_TOKEN ?? '',

  // 互換のために残したいなら小文字キーも残していいが、これはトークンじゃないので問題なし
  server_ID: process.env.server_ID ?? '944157981791113287',

  DISCORD_DIGEST_WEBHOOK_URL: process.env.DISCORD_DIGEST_WEBHOOK_URL ?? '',
  INTRO_CHANNEL_NAME: process.env.INTRO_CHANNEL_NAME ?? '',
  INTRO_CHANNEL_CODE: process.env.INTRO_CHANNEL_CODE ?? '',
  INGEST_URL: process.env.INGEST_URL ?? '',
  SURVEY_URL: process.env.SURVEY_URL ?? '',
  PROFILE_FILE: process.env.PROFILE_FILE ?? 'profiles.json',
  FONT_PATH: process.env.FONT_PATH ?? '',
  NEXT_PUBLIC_SERVER_ID: process.env.NEXT_PUBLIC_SERVER_ID ?? '',
  DISCORD_CHANNEL_IDS: (process.env.DISCORD_CHANNEL_IDS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  DISCORD_CHANNEL_NAMES: (process.env.DISCORD_CHANNEL_NAMES ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  BRIDGE_BACKFILL: Number(process.env.BRIDGE_BACKFILL ?? '0'),
  REGISTER_SLASH: bool(process.env.REGISTER_SLASH, true),
  DISCORD_APP_ID: process.env.DISCORD_APP_ID ?? '',
  DISCORD_CLIENT_ID: process.env.DISCORD_CLIENT_ID ?? '',
  COMMAND_GUILD_ID: process.env.COMMAND_GUILD_ID ?? '',
  TRUST_USER_IDS: (process.env.TRUST_USER_IDS ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean),
  ANALYSIS_CHANNEL_ID: process.env.ANALYSIS_CHANNEL_ID ?? '',
} as const;

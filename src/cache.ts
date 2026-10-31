/**
 * 内容寻址缓存 —— 花钱组件的灵魂:幂等 = 不重复花钱。
 * key = sha256(规范化的合成参数:文本 + 型号 + 音色 + instruction + 格式/采样率/语速/音量/音调/seed/语言提示)
 * 用户级目录(~/.cache/voxtell/,VOXTELL_CACHE_DIR 可改),跨工作区共享;命中零成本,--force 才重合成。
 * 布局:tts/<key 前两位>/<key>.<format> + <key>.json(元数据:参数、计费字符、request_id、时间)。
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { durationMsOf } from './audio-info.ts';

export const CACHE_DIR = process.env.VOXTELL_CACHE_DIR ?? join(homedir(), '.cache', 'voxtell');

export type AudioFormat = 'mp3' | 'wav' | 'pcm' | 'opus';

/** 一次合成的全部输入;进 key 的字段就是这些(顺序无关,undefined 不参与) */
export interface SynthParams {
  model: string;
  voice: string;
  text: string;
  instruction?: string;
  format: AudioFormat;
  sampleRate: number;
  rate?: number;
  volume?: number;
  pitch?: number;
  seed?: number;
  languageHints?: string[];
}

export interface CacheMeta {
  key: string;
  provider: 'qwen';
  params: SynthParams;
  characters: number;
  requestId: string;
  bytes: number;
  /** 音频时长(毫秒),由 audio-info 探测;老缓存可能没有,读侧按需补 */
  durationMs?: number | null;
  createdAt: string;
}

function canonical(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = canonical(val);
    }
    return out;
  }
  return v;
}

export function cacheKey(p: SynthParams): string {
  return createHash('sha256').update(JSON.stringify(canonical(p))).digest('hex');
}

export function cachePaths(key: string, format: AudioFormat): { audio: string; meta: string } {
  const dir = join(CACHE_DIR, 'tts', key.slice(0, 2));
  return { audio: join(dir, `${key}.${format}`), meta: join(dir, `${key}.json`) };
}

export async function cacheGet(key: string, format: AudioFormat): Promise<{ audio: string; meta: CacheMeta } | null> {
  const p = cachePaths(key, format);
  try {
    const [, metaRaw] = await Promise.all([stat(p.audio), readFile(p.meta, 'utf8')]);
    let meta = JSON.parse(metaRaw) as CacheMeta;
    if (meta.durationMs === undefined) {
      // 老缓存没有时长:探测一次并回写,之后零成本
      meta = { ...meta, durationMs: durationMsOf(new Uint8Array(await readFile(p.audio)), format) };
      await writeFile(p.meta, `${JSON.stringify(meta, null, 2)}\n`);
    }
    return { audio: p.audio, meta };
  } catch {
    return null;
  }
}

export async function cachePut(key: string, format: AudioFormat, bytes: Uint8Array, meta: Omit<CacheMeta, 'key' | 'bytes' | 'createdAt' | 'durationMs'>): Promise<{ audio: string; meta: CacheMeta }> {
  const p = cachePaths(key, format);
  await mkdir(dirname(p.audio), { recursive: true });
  const full: CacheMeta = { key, bytes: bytes.byteLength, durationMs: durationMsOf(bytes, format), createdAt: new Date().toISOString(), ...meta };
  // 先写音频再写元数据:元数据在 = 音频完整(读侧两者都要在)
  await writeFile(p.audio, bytes);
  await writeFile(p.meta, `${JSON.stringify(full, null, 2)}\n`);
  return { audio: p.audio, meta: full };
}

/**
 * 计费字符估算——dry-run 用,真值以返回的 usage.characters 为准。
 * 实测(2026-08-17,qwen-audio-3.0-tts-plus,62 句中文讲稿):汉字按 2 计、其他字符按 1 计,
 * 与实际计费差 ±5%(标点归类有出入);按 [...text].length 会低估约 35%。
 */
export function estimateCharacters(text: string): number {
  let n = 0;
  for (const ch of text) n += /\p{Script=Han}/u.test(ch) ? 2 : 1;
  return n;
}

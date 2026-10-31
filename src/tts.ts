/**
 * 合成服务层:缓存优先。ensureAudio = 查缓存 → 未命中才上云 → 落缓存。
 * 上层(say / batch / preview)只认这一个入口,花钱的地方只有这里。
 */

import { cacheGet, cacheKey, cachePut, type AudioFormat, type CacheMeta, type SynthParams } from './cache.ts';
import type { Config } from './config.ts';
import { synthesize } from './qwen.ts';

export const DEFAULT_MODEL = 'qwen-audio-3.0-tts-plus';
export const DEFAULT_FORMAT: AudioFormat = 'mp3';
export const DEFAULT_SAMPLE_RATE = 24000;

export interface EnsureResult {
  key: string;
  audio: string;
  meta: CacheMeta;
  cached: boolean;
}

export async function ensureAudio(cfg: Config, p: SynthParams, opts: { force?: boolean } = {}): Promise<EnsureResult> {
  const key = cacheKey(p);
  if (!opts.force) {
    const hit = await cacheGet(key, p.format);
    if (hit) return { key, audio: hit.audio, meta: hit.meta, cached: true };
  }
  const r = await synthesize(cfg, p);
  const put = await cachePut(key, p.format, r.bytes, { provider: 'qwen', params: p, characters: r.characters, requestId: r.requestId });
  return { key, audio: put.audio, meta: put.meta, cached: false };
}

/** 从 CLI 选项拼合成参数;缺 voice 直接抛(无默认音色是政策) */
export function buildParams(o: {
  text: string;
  voice?: string;
  model?: string;
  instruction?: string;
  format?: string;
  sampleRate?: number;
  rate?: number;
  volume?: number;
  pitch?: number;
  seed?: number;
  languageHints?: string[];
}): SynthParams {
  if (!o.voice) {
    throw new NoVoiceError();
  }
  const format = (o.format ?? DEFAULT_FORMAT) as AudioFormat;
  if (!['mp3', 'wav', 'pcm', 'opus'].includes(format)) {
    throw new Error(`format '${o.format}' 不支持;可选 mp3 / wav / pcm / opus`);
  }
  const p: SynthParams = {
    model: o.model ?? DEFAULT_MODEL,
    voice: o.voice,
    text: o.text,
    format,
    sampleRate: o.sampleRate ?? DEFAULT_SAMPLE_RATE,
  };
  if (o.instruction) p.instruction = o.instruction;
  if (o.rate !== undefined) p.rate = o.rate;
  if (o.volume !== undefined) p.volume = o.volume;
  if (o.pitch !== undefined) p.pitch = o.pitch;
  if (o.seed !== undefined) p.seed = o.seed;
  if (o.languageHints?.length) p.languageHints = o.languageHints;
  return p;
}

export class NoVoiceError extends Error {
  constructor() {
    super('未指定音色(--voice)。音色是应用政策、无默认值:先 voxtell voices --grep <关键词> 挑候选,voxtell preview <voice> 试听,再带 --voice 调用');
  }
}

/**
 * Qwen-Audio-TTS 非实时合成(阿里云百炼,北京地域,业务空间级域名)。
 * POST {endpoint} {model, input:{text, voice, format, sample_rate, instruction?, seed?, rate?, volume?, pitch?, language_hints?}}
 *   → {output:{audio:{url(24h 有效)}}, usage:{characters}}
 * 然后 GET url 拿音频字节。S0 实测(2026-08-07)与 video-script 的 synthesize.py 是蓝本。
 * 错误信息面向 agent:说清是密钥、配额、参数还是网络,永不回显密钥。
 */

import type { Config } from './config.ts';
import type { SynthParams } from './cache.ts';

export type SynthErrorKind = 'auth' | 'request' | 'quota' | 'network' | 'upstream';

/** 注意:Node 类型擦除模式不支持构造器参数属性,故显式声明字段 */
export class SynthError extends Error {
  readonly kind: SynthErrorKind;
  readonly status: number | undefined;
  constructor(message: string, kind: SynthErrorKind, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
  }
}

export interface SynthResult {
  bytes: Uint8Array;
  characters: number;
  requestId: string;
}

interface QwenResponse {
  request_id?: string;
  output?: { finish_reason?: string; audio?: { url?: string; data?: string } };
  usage?: { characters?: number };
  code?: string;
  message?: string;
}

function toBody(p: SynthParams): Record<string, unknown> {
  const input: Record<string, unknown> = {
    text: p.text,
    voice: p.voice,
    format: p.format,
    sample_rate: p.sampleRate,
  };
  if (p.instruction) input.instruction = p.instruction;
  if (p.seed !== undefined) input.seed = p.seed;
  if (p.rate !== undefined) input.rate = p.rate;
  if (p.volume !== undefined) input.volume = p.volume;
  if (p.pitch !== undefined) input.pitch = p.pitch;
  if (p.languageHints?.length) input.language_hints = p.languageHints;
  return { model: p.model, input };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 单次合成,含 3 次退避重试(网络错误 / 5xx / 429);4xx 参数或鉴权错误不重试 */
export async function synthesize(cfg: Config, p: SynthParams, opts: { retries?: number; timeoutMs?: number } = {}): Promise<SynthResult> {
  if (!cfg.apiKey) throw new SynthError('缺少 DASHSCOPE_API_KEY', 'auth');
  if (!cfg.ttsEndpoint) throw new SynthError('缺少 DASHSCOPE_WORKSPACE_ID(或 VOXTELL_TTS_ENDPOINT)', 'auth');
  const retries = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 120_000;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(cfg.ttsEndpoint, {
        method: 'POST',
        headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(toBody(p)),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const text = await res.text();
      let body: QwenResponse = {};
      try {
        body = JSON.parse(text) as QwenResponse;
      } catch {
        /* 非 JSON 响应,下面按状态码处理 */
      }
      if (!res.ok) {
        const detail = `${body.code ?? ''} ${body.message ?? text.slice(0, 200)}`.trim();
        if (res.status === 401 || res.status === 403) {
          throw new SynthError(`鉴权失败(HTTP ${res.status}:${detail})。检查 DASHSCOPE_API_KEY 是否为北京地域、业务空间是否开通 ${p.model}`, 'auth', res.status);
        }
        if (res.status === 429) {
          throw new SynthError(`限流或配额不足(HTTP 429:${detail})`, 'quota', res.status);
        }
        if (res.status >= 500) {
          throw new SynthError(`上游错误(HTTP ${res.status}:${detail})`, 'upstream', res.status);
        }
        throw new SynthError(`请求被拒(HTTP ${res.status}:${detail})。核对 voice(voxtell voices)、model(voxtell models)与文本`, 'request', res.status);
      }
      const url = body.output?.audio?.url;
      if (!url) {
        throw new SynthError(`响应缺少 output.audio.url(request_id ${body.request_id ?? '?'}):${text.slice(0, 200)}`, 'upstream', res.status);
      }
      const audio = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!audio.ok) throw new SynthError(`下载音频失败(HTTP ${audio.status})`, 'upstream', audio.status);
      const bytes = new Uint8Array(await audio.arrayBuffer());
      return { bytes, characters: body.usage?.characters ?? 0, requestId: body.request_id ?? '' };
    } catch (err) {
      lastErr = err;
      const retryable = !(err instanceof SynthError) || err.kind === 'network' || err.kind === 'upstream' || err.kind === 'quota';
      if (!retryable || attempt === retries) break;
      await sleep(1500 * attempt);
    }
  }
  if (lastErr instanceof SynthError) throw lastErr;
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new SynthError(`网络错误:${msg}。检查网络 / 代理;voxtell doctor 可测端点连通性`, 'network');
}

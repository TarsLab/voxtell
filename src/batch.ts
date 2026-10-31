/**
 * batch:清单进 → 音频 + 结果清单出,全量幂等。
 *
 * jobs.json(schema voxtell-jobs v1):
 *   { "schema": "voxtell-jobs", "version": 1,
 *     "defaults": { "voice": "...", "model"?: , "instruction"?: , "format"?: "mp3", "sampleRate"?: 24000, "rate"?: , "seed"?: , "languageHints"?: ["zh"] },
 *     "jobs": [ { "id": "step-1", "text": "……", "voice"?: , "instruction"?: , "out"?: "step-1.mp3" } ] }
 * 每条 job 的参数 = defaults 被 job 自身字段覆盖;id 只需在清单内唯一。
 *
 * 结果(results.json,schema voxtell-results v1):逐条 {id, text, key, file, characters, cached, bytes, durationMs};
 * summary 有条数、字符数、命中/未命中、实际计费字符;dry-run 时 file 为 null、characters 为估算。
 * 缓存 key 按条算(文本+参数),改一句只重合成一句——drawtell 课包配音靠这一点。
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { cacheGet, cacheKey, estimateCharacters, type SynthParams } from './cache.ts';
import type { Config } from './config.ts';
import { buildParams, ensureAudio } from './tts.ts';

export interface JobDefaults {
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
}

export interface Job extends JobDefaults {
  id: string;
  text: string;
  /** 输出文件名(相对 --out-dir);缺省 <id>.<format> */
  out?: string;
}

export interface JobsFile {
  schema?: string;
  version?: number;
  defaults?: JobDefaults;
  jobs: Job[];
}

export interface JobResult {
  id: string;
  text: string;
  key: string;
  /** 落地文件(--out-dir 下的拷贝;无 out-dir 时是缓存路径);dry-run 为 null */
  file: string | null;
  characters: number;
  cached: boolean;
  bytes: number | null;
  /** 音频时长(毫秒);dry-run 未命中时为 null */
  durationMs: number | null;
  error?: string;
}

export interface BatchResults {
  schema: 'voxtell-results';
  version: 1;
  dryRun: boolean;
  outDir: string | null;
  jobs: JobResult[];
  summary: {
    jobs: number;
    characters: number;
    hits: number;
    misses: number;
    /** 实际(或将要)上云计费的字符数 = 未命中条目的字符和 */
    billedCharacters: number;
    failed: number;
    pricePer10k: number | null;
    estimatedCost: number | null;
  };
}

export class JobsError extends Error {}

export async function readJobs(file: string): Promise<JobsFile> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    throw new JobsError(`读不到清单 ${file}:${err instanceof Error ? err.message : String(err)}。清单是 JSON:{"defaults": {"voice": "..."}, "jobs": [{"id": "...", "text": "..."}]}`);
  }
  const j = raw as JobsFile;
  if (!j || typeof j !== 'object' || !Array.isArray(j.jobs)) {
    throw new JobsError(`清单 ${file} 缺 jobs 数组`);
  }
  const seen = new Set<string>();
  j.jobs.forEach((job, i) => {
    if (!job || typeof job.id !== 'string' || !job.id) throw new JobsError(`jobs[${i}] 缺 id(字符串)`);
    if (typeof job.text !== 'string' || !job.text.trim()) throw new JobsError(`jobs[${i}](${job.id})缺 text`);
    if (seen.has(job.id)) throw new JobsError(`jobs 里 id '${job.id}' 重复;id 用来命名输出文件与对照结果,须唯一`);
    seen.add(job.id);
  });
  return j;
}

function paramsOf(defaults: JobDefaults | undefined, job: Job): SynthParams {
  const d = defaults ?? {};
  return buildParams({
    text: job.text,
    voice: job.voice ?? d.voice,
    model: job.model ?? d.model,
    instruction: job.instruction ?? d.instruction,
    format: job.format ?? d.format,
    sampleRate: job.sampleRate ?? d.sampleRate,
    rate: job.rate ?? d.rate,
    volume: job.volume ?? d.volume,
    pitch: job.pitch ?? d.pitch,
    seed: job.seed ?? d.seed,
    languageHints: job.languageHints ?? d.languageHints,
  });
}

/** 有界并发:未命中的条目同时最多 n 个在飞 */
async function mapLimit<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return out;
}

export interface RunOptions {
  outDir?: string;
  dryRun?: boolean;
  force?: boolean;
  concurrency?: number;
  pricePer10k?: number | null;
}

export async function runBatch(cfg: Config, jobsFile: JobsFile, opts: RunOptions): Promise<BatchResults> {
  const outDir = opts.outDir ? resolve(opts.outDir) : null;
  const plans = jobsFile.jobs.map((job) => {
    const params = paramsOf(jobsFile.defaults, job);
    return { job, params, key: cacheKey(params) };
  });

  // 先看缓存(零成本),dry-run 到此为止
  const hits = await Promise.all(plans.map((p) => (opts.force ? Promise.resolve(null) : cacheGet(p.key, p.params.format))));

  if (opts.dryRun) {
    const jobs: JobResult[] = plans.map((p, i) => ({
      id: p.job.id,
      text: p.job.text,
      key: p.key,
      file: null,
      characters: hits[i]?.meta.characters ?? estimateCharacters(p.job.text),
      cached: !!hits[i],
      bytes: hits[i]?.meta.bytes ?? null,
      durationMs: hits[i]?.meta.durationMs ?? null,
    }));
    return summarize(jobs, true, outDir, opts.pricePer10k ?? null);
  }

  if (outDir) await mkdir(outDir, { recursive: true });
  const results = await mapLimit(plans, opts.concurrency ?? 3, async (p, i): Promise<JobResult> => {
    try {
      const r = hits[i]
        ? { key: p.key, audio: hits[i]!.audio, meta: hits[i]!.meta, cached: true }
        : await ensureAudio(cfg, p.params, { force: opts.force });
      let file = r.audio;
      if (outDir) {
        const name = p.job.out ?? `${p.job.id}.${p.params.format}`;
        file = join(outDir, basename(name));
        await copyFile(r.audio, file);
      }
      return { id: p.job.id, text: p.job.text, key: p.key, file, characters: r.meta.characters, cached: r.cached, bytes: r.meta.bytes, durationMs: r.meta.durationMs ?? null };
    } catch (err) {
      return { id: p.job.id, text: p.job.text, key: p.key, file: null, characters: 0, cached: false, bytes: null, durationMs: null, error: err instanceof Error ? err.message : String(err) };
    }
  });
  const out = summarize(results, false, outDir, opts.pricePer10k ?? null);
  if (outDir) await writeFile(join(outDir, 'results.json'), `${JSON.stringify(out, null, 2)}\n`);
  return out;
}

function summarize(jobs: JobResult[], dryRun: boolean, outDir: string | null, pricePer10k: number | null): BatchResults {
  const hitsN = jobs.filter((j) => j.cached).length;
  const failed = jobs.filter((j) => j.error).length;
  const billed = jobs.filter((j) => !j.cached && !j.error).reduce((a, j) => a + j.characters, 0);
  const chars = jobs.reduce((a, j) => a + j.characters, 0);
  return {
    schema: 'voxtell-results',
    version: 1,
    dryRun,
    outDir,
    jobs,
    summary: {
      jobs: jobs.length,
      characters: chars,
      hits: hitsN,
      misses: jobs.length - hitsN - failed,
      billedCharacters: billed,
      failed,
      pricePer10k,
      estimatedCost: pricePer10k == null ? null : Math.round((billed / 10_000) * pricePer10k * 10_000) / 10_000,
    },
  };
}

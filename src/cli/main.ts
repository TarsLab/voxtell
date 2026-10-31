/**
 * CLI 入口。约定与 drawtell 同一模式(agent-friendly):
 * 全命令支持 --json;无交互式提示;错误信息 = 修复指南;
 * exit code:0 成功 · 1 任务失败(输入或上游问题,带修复指引)· 2 用法错误 · 3 已规划未实现 · 4 内部错误。
 *
 * 花钱组件的额外纪律(已落实在 cache.ts / tts.ts / batch.ts):
 * - 幂等 = 不重复花钱:用户级内容寻址缓存(~/.cache/voxtell/),
 *   key = hash(文本+型号+音色+instruction+参数),命中零成本,--force 才重合成
 * - batch 先 --dry-run 算账:条目、字符数、缓存命中率、预估费用;本地零成本的 align/transcribe 不设此负担
 * - 密钥纪律:env(DASHSCOPE_API_KEY)优先;任何输出与错误信息不回显密钥
 * - 无默认音色:音色、语气底色、上不上云是应用政策(家长确认),机制不夹带默认值
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJobs, runBatch, JobsError } from '../batch.ts';
import { CACHE_DIR } from '../cache.ts';
import { credentialsHint, loadConfig, type Config } from '../config.ts';
import { SynthError } from '../qwen.ts';
import { buildParams, ensureAudio, NoVoiceError, DEFAULT_MODEL } from '../tts.ts';

const VERSION = '0.1.0';
const HOMEPAGE = 'https://github.com/tarslab/voxtell';
const DATA_DIR = fileURLToPath(new URL('../../data/', import.meta.url));

class UsageError extends Error {}

const PLANNED = ['align', 'transcribe'];

const HELP = `voxtell ${VERSION} — vox & tell:批量语音合成 + 字级时间轴,从终端出发。

用法:
  voxtell say <text|-> --voice <v> [--instruction <s>] [--model <m>] [--format mp3|wav] [--rate <f>] [--seed <n>] [--force] [-o out.mp3] [--json]
      单句合成(命中缓存零成本)。无默认音色:不带 --voice 报错并给出挑选路径。
      输出音频路径(缓存里的,或 -o 拷贝到指定位置)。--timeline 属 V1(align),暂 exit 3。
  voxtell batch <jobs.json> [--out-dir <d>] [--dry-run] [--force] [--concurrency <n>] [--json]
      清单进 → 音频 + results.json 出,全量幂等。--dry-run 只算账:条目、字符数、缓存命中率、预估费用。
      清单格式:{"defaults": {"voice": "...", "instruction"?: "..."}, "jobs": [{"id": "step-1", "text": "..."}]}
  voxtell voices [--grep <关键词>] [--json]     音色枚举(data/voices.json,597 个基础音色;--grep 匹配名字/特质/场景/性别/年龄)
  voxtell preview <voice> [text] [--json]     音色试听:合成一句样例到缓存,输出路径(macOS 可 afplay <path>)
  voxtell models [--json]                     能力表(data/models.json 是数据源,文档是视图)
  voxtell doctor [--json]                     key、业务空间、端点连通、缓存目录逐项体检,给修复命令
  voxtell align <audio> <text> · transcribe <audio>   规划中(V1,FunASR 本地),调用返回 exit 3
  voxtell --help | --version [--json]

配置:DASHSCOPE_API_KEY / DASHSCOPE_WORKSPACE_ID(env 优先),或 ~/.config/voxtell/config.json
      {"apiKey": "...", "workspaceId": "..."}。缓存:~/.cache/voxtell/(VOXTELL_CACHE_DIR 可改)。
exit code:0 成功 · 1 任务失败(带修复指引)· 2 用法错误 · 3 已规划未实现 · 4 内部错误

${HOMEPAGE}`;

export async function main(argv: string[]): Promise<void> {
  const json = argv.includes('--json');
  const args = argv.filter((a) => a !== '--json');
  const cmd = args[0];
  try {
    switch (cmd) {
      case undefined:
      case '--help':
      case '-h':
        console.log(json ? jsonHelp() : HELP);
        return;
      case '--version':
      case '-v':
        console.log(json ? JSON.stringify({ name: 'voxtell', version: VERSION }) : VERSION);
        return;
      case 'say':
        await runSay(args.slice(1), json);
        return;
      case 'batch':
        await runBatchCmd(args.slice(1), json);
        return;
      case 'voices':
        await runVoices(args.slice(1), json);
        return;
      case 'preview':
        await runPreview(args.slice(1), json);
        return;
      case 'models':
        await runModels(args.slice(1), json);
        return;
      case 'doctor':
        await runDoctor(json);
        return;
      default:
        if (PLANNED.includes(cmd)) {
          fail(json, 3, 'not_implemented', `'voxtell ${cmd}' 已规划、尚未实现(当前 ${VERSION},V1 落地)。命令面见 voxtell --help,进度见 ${HOMEPAGE}`);
          return;
        }
        fail(json, 2, 'unknown_command', `未知命令 '${cmd}'。运行 voxtell --help 查看用法。`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      fail(json, 2, 'usage', err.message);
    } else if (err instanceof NoVoiceError) {
      fail(json, 2, 'no_voice', err.message);
    } else if (err instanceof JobsError) {
      fail(json, 1, 'jobs', err.message);
    } else if (err instanceof SynthError) {
      fail(json, 1, `synth_${err.kind}`, err.message);
    } else {
      console.error(json ? JSON.stringify({ error: 'internal', message: String(err instanceof Error ? (err.stack ?? err.message) : err) }) : `voxtell: 内部错误:${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      process.exitCode = 4;
    }
  }
}

// ---------- 参数解析 ----------

interface Parsed {
  positionals: string[];
  flags: Map<string, string>;
}

function parseArgs(rest: string[], usage: string, valueFlags: string[], boolFlags: string[] = []): Parsed {
  const flags = new Map<string, string>();
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('-') && a !== '-') {
      if (boolFlags.includes(a)) {
        flags.set(a, '1');
        continue;
      }
      if (!valueFlags.includes(a)) throw new UsageError(`未知选项 '${a}'。用法:${usage}`);
      const next = rest[i + 1];
      if (next === undefined || (next.startsWith('-') && next !== '-')) throw new UsageError(`选项 '${a}' 需要一个值。用法:${usage}`);
      flags.set(a, next);
      i++;
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function numFlag(flags: Map<string, string>, name: string): number | undefined {
  const v = flags.get(name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new UsageError(`选项 ${name} 需要数字,拿到 '${v}'`);
  return n;
}

async function readText(arg: string | undefined, usage: string): Promise<string> {
  if (arg === undefined) throw new UsageError(`缺少文本参数。用法:${usage}`);
  if (arg === '-') {
    const chunks: Buffer[] = [];
    for await (const c of process.stdin) chunks.push(c as Buffer);
    const t = Buffer.concat(chunks).toString('utf8').trim();
    if (!t) throw new UsageError('stdin 为空');
    return t;
  }
  return arg;
}

async function requireCredentials(): Promise<Config> {
  const cfg = await loadConfig();
  const hint = credentialsHint(cfg);
  if (hint) throw new SynthError(hint, 'auth');
  return cfg;
}

// ---------- say / preview ----------

const SAY_USAGE = 'voxtell say <text|-> --voice <v> [--instruction <s>] [--model <m>] [--format mp3|wav] [--rate <f>] [--seed <n>] [--force] [-o out]';

async function runSay(rest: string[], json: boolean): Promise<void> {
  const { positionals, flags } = parseArgs(rest, SAY_USAGE, ['--voice', '--instruction', '--model', '--format', '--rate', '--volume', '--pitch', '--seed', '--sample-rate', '-o', '--lang'], ['--force', '--timeline']);
  if (flags.has('--timeline')) {
    fail(json, 3, 'not_implemented', '--timeline(合成后本地对齐)属 V1 align,尚未实现;先不带 --timeline 合成');
    return;
  }
  const text = await readText(positionals[0], SAY_USAGE);
  const params = buildParams({
    text,
    voice: flags.get('--voice'),
    model: flags.get('--model'),
    instruction: flags.get('--instruction'),
    format: flags.get('--format'),
    sampleRate: numFlag(flags, '--sample-rate'),
    rate: numFlag(flags, '--rate'),
    volume: numFlag(flags, '--volume'),
    pitch: numFlag(flags, '--pitch'),
    seed: numFlag(flags, '--seed'),
    languageHints: flags.has('--lang') ? [flags.get('--lang')!] : undefined,
  });
  const cfg = await requireCredentials();
  const r = await ensureAudio(cfg, params, { force: flags.has('--force') });
  let file = r.audio;
  const out = flags.get('-o');
  if (out) {
    file = resolve(out);
    await mkdir(dirname(file), { recursive: true });
    await copyFile(r.audio, file);
  }
  if (json) {
    console.log(JSON.stringify({ command: 'say', ok: true, file, key: r.key, cached: r.cached, characters: r.meta.characters, bytes: r.meta.bytes, durationMs: r.meta.durationMs ?? null, model: params.model, voice: params.voice }, null, 2));
  } else {
    console.log(`${r.cached ? '✓ 缓存命中' : '✓ 已合成'} ${r.meta.characters} 字符${r.meta.durationMs ? `,${(r.meta.durationMs / 1000).toFixed(1)}s` : ''} → ${file}`);
  }
}

const PREVIEW_TEXT = '你好,我是你的讲题老师。今天我们一起来画一画、算一算:7 加 5 等于多少?';

async function runPreview(rest: string[], json: boolean): Promise<void> {
  const usage = 'voxtell preview <voice> [text] [--instruction <s>] [--model <m>]';
  const { positionals, flags } = parseArgs(rest, usage, ['--instruction', '--model']);
  const voice = positionals[0];
  if (!voice) throw new UsageError(`缺少 voice。用法:${usage};候选看 voxtell voices --grep <关键词>`);
  const params = buildParams({ text: positionals[1] ?? PREVIEW_TEXT, voice, model: flags.get('--model'), instruction: flags.get('--instruction') });
  const cfg = await requireCredentials();
  const r = await ensureAudio(cfg, params);
  const entry = (await loadVoices()).voices.find((v) => v.voice === voice);
  if (json) {
    console.log(JSON.stringify({ command: 'preview', ok: true, voice, name: entry?.name ?? null, file: r.audio, cached: r.cached, characters: r.meta.characters, durationMs: r.meta.durationMs ?? null }, null, 2));
  } else {
    console.log(`${entry ? `${entry.name}(${entry.gender} ${entry.age},${entry.trait})` : voice} → ${r.audio}${process.platform === 'darwin' ? `\n  试听:afplay "${r.audio}"` : ''}`);
  }
}

// ---------- batch ----------

async function runBatchCmd(rest: string[], json: boolean): Promise<void> {
  const usage = 'voxtell batch <jobs.json> [--out-dir <d>] [--dry-run] [--force] [--concurrency <n>]';
  const { positionals, flags } = parseArgs(rest, usage, ['--out-dir', '--concurrency'], ['--dry-run', '--force']);
  const file = positionals[0];
  if (!file) throw new UsageError(`缺少清单文件。用法:${usage}`);
  const jobs = await readJobs(file);
  const dryRun = flags.has('--dry-run');
  const cfg = dryRun ? await loadConfig() : await requireCredentials();
  const model = jobs.defaults?.model ?? DEFAULT_MODEL;
  const price = (await loadModels()).models.find((m) => m.id === model)?.price ?? null;
  const results = await runBatch(cfg, jobs, {
    outDir: flags.get('--out-dir'),
    dryRun,
    force: flags.has('--force'),
    concurrency: numFlag(flags, '--concurrency'),
    pricePer10k: price,
  });
  const s = results.summary;
  if (json) {
    console.log(JSON.stringify({ command: 'batch', ok: s.failed === 0, ...results }, null, 2));
  } else {
    const head = dryRun ? '算账(未合成)' : s.failed ? `完成,${s.failed} 条失败` : '完成';
    console.log(`${s.failed ? '✗' : '✓'} ${head}:${s.jobs} 条 / ${s.characters} 字符;缓存命中 ${s.hits},需合成 ${s.misses}(计费字符 ${s.billedCharacters}${s.estimatedCost != null ? `,约 ${s.estimatedCost} 元` : ',单价未登记 models.json'})`);
    for (const j of results.jobs) {
      const tag = j.error ? '✗' : j.cached ? '=' : dryRun ? '+' : '↑';
      console.log(`  ${tag} ${j.id}  ${j.characters} 字${j.durationMs ? `  ${(j.durationMs / 1000).toFixed(1)}s` : ''}  ${j.error ? j.error : (j.file ?? '(dry-run)')}`);
    }
    if (results.outDir) console.log(`  结果清单 → ${results.outDir}/results.json`);
    if (dryRun && s.misses) console.log('  去掉 --dry-run 即合成;--force 会忽略缓存全部重合成(重复花钱)');
  }
  if (s.failed) process.exitCode = 1;
}

// ---------- voices / models ----------

interface VoiceEntry {
  name: string;
  voice: string;
  gender: string;
  age: number;
  trait: string;
  scene: string;
  lang: string;
}

async function loadVoices(): Promise<{ voices: VoiceEntry[] }> {
  return JSON.parse(await readFile(`${DATA_DIR}voices.json`, 'utf8')) as { voices: VoiceEntry[] };
}

async function loadModels(): Promise<{ models: Array<{ id: string; price: number | null } & Record<string, unknown>> }> {
  return JSON.parse(await readFile(`${DATA_DIR}models.json`, 'utf8')) as { models: Array<{ id: string; price: number | null } & Record<string, unknown>> };
}

async function runVoices(rest: string[], json: boolean): Promise<void> {
  const usage = 'voxtell voices [--grep <关键词>] [--gender 男|女] [--max-age <n>] [--min-age <n>]';
  const { flags } = parseArgs(rest, usage, ['--grep', '--gender', '--max-age', '--min-age']);
  const all = (await loadVoices()).voices;
  const kw = flags.get('--grep');
  const gender = flags.get('--gender');
  const maxAge = numFlag(flags, '--max-age');
  const minAge = numFlag(flags, '--min-age');
  const list = all.filter((v) => {
    if (kw && !`${v.name} ${v.voice} ${v.gender} ${v.age} ${v.trait} ${v.scene} ${v.lang}`.includes(kw)) return false;
    if (gender && v.gender !== gender) return false;
    if (maxAge !== undefined && v.age > maxAge) return false;
    if (minAge !== undefined && v.age < minAge) return false;
    return true;
  });
  if (json) {
    console.log(JSON.stringify({ command: 'voices', total: all.length, matched: list.length, voices: list }, null, 2));
    return;
  }
  console.log(`${list.length}/${all.length} 个音色${kw ? `(匹配 "${kw}")` : ''}:`);
  for (const v of list) console.log(`  ${v.voice}  ${v.name}  ${v.gender} ${v.age}  ${v.trait}  ${v.scene}${v.lang !== '中文' ? `  ${v.lang}` : ''}`);
  console.log('试听:voxtell preview <voice>');
}

async function runModels(_rest: string[], json: boolean): Promise<void> {
  const data = await loadModels();
  if (json) {
    console.log(JSON.stringify({ command: 'models', ...data }, null, 2));
    return;
  }
  for (const m of data.models) {
    console.log(`${m.id}${m.recommended ? '  (推荐)' : ''}\n  模式 ${(m.modes as string[]).join('/')} · 字级时间戳 ${m.wordTimestamps ? '✓' : '✗'} · instruction ${m.instruction ? '✓' : '✗'} · 格式 ${(m.formats as string[]).join('/')} · 单价 ${m.price ?? '未登记'}\n  ${m.tested}`);
  }
}

// ---------- doctor ----------

interface Check {
  name: string;
  ok: boolean;
  required: boolean;
  detail: string;
  fix?: string;
}

async function runDoctor(json: boolean): Promise<void> {
  const checks: Check[] = [];
  const [maj, min] = process.versions.node.split('.').map(Number);
  const nodeOk = maj > 22 || (maj === 22 && min >= 18);
  checks.push({ name: 'node', ok: nodeOk, required: true, detail: `node ${process.versions.node}`, fix: nodeOk ? undefined : '需要 Node ≥ 22.18(原生 type stripping)' });

  const cfg = await loadConfig();
  checks.push({
    name: 'api-key',
    ok: !!cfg.apiKey,
    required: true,
    detail: cfg.apiKey ? `已配置(来源:${cfg.sources.apiKey})` : '未配置',
    fix: cfg.apiKey ? undefined : `export DASHSCOPE_API_KEY=…(北京地域 key)或写入 ${cfg.configPath}`,
  });
  checks.push({
    name: 'workspace',
    ok: !!cfg.ttsEndpoint,
    required: true,
    detail: cfg.workspaceId ? `业务空间 ${cfg.workspaceId}(来源:${cfg.sources.workspaceId})` : cfg.ttsEndpoint ? `端点由 ${cfg.sources.ttsEndpoint} 指定` : '未配置',
    fix: cfg.ttsEndpoint ? undefined : `export DASHSCOPE_WORKSPACE_ID=llm-…(百炼控制台业务空间 id)或写入 ${cfg.configPath}`,
  });

  if (cfg.ttsEndpoint) {
    try {
      // 不带 body、不带 key 的探测:只看 TLS/DNS 通不通,不计费(预期 4xx)
      const res = await fetch(cfg.ttsEndpoint, { method: 'GET', signal: AbortSignal.timeout(8000) });
      checks.push({ name: 'endpoint', ok: true, required: true, detail: `可达(HTTP ${res.status},未鉴权探测)` });
    } catch (err) {
      checks.push({ name: 'endpoint', ok: false, required: true, detail: err instanceof Error ? err.message : String(err), fix: '检查网络 / 代理 / 业务空间 id 拼写' });
    }
  }

  try {
    await mkdir(CACHE_DIR, { recursive: true });
    const probe = `${CACHE_DIR}/.write-test`;
    await writeFile(probe, 'ok');
    checks.push({ name: 'cache', ok: true, required: true, detail: CACHE_DIR });
  } catch (err) {
    checks.push({ name: 'cache', ok: false, required: true, detail: err instanceof Error ? err.message : String(err), fix: `mkdir -p ${CACHE_DIR} 或设 VOXTELL_CACHE_DIR` });
  }

  checks.push({ name: 'funasr', ok: false, required: false, detail: 'V1(align/transcribe)才需要;当前不检查', fix: undefined });

  const ok = checks.filter((c) => c.required).every((c) => c.ok);
  if (json) {
    console.log(JSON.stringify({ command: 'doctor', ok, checks }, null, 2));
  } else {
    for (const c of checks) {
      console.log(`${c.ok ? '✓' : c.required ? '✗' : '·'} ${c.name}: ${c.detail}${c.fix && !c.ok ? `\n    → ${c.fix}` : ''}`);
    }
    console.log(ok ? '体检通过。' : '有必需项未通过,按 → 提示修复后重跑 voxtell doctor');
  }
  if (!ok) process.exitCode = 1;
}

// ---------- 通用 ----------

function jsonHelp(): string {
  return JSON.stringify(
    {
      name: 'voxtell',
      version: VERSION,
      commands: {
        say: { usage: SAY_USAGE, desc: '单句合成,缓存优先' },
        batch: { usage: 'voxtell batch <jobs.json> [--out-dir <d>] [--dry-run] [--force]', desc: '清单合成,全量幂等' },
        voices: { usage: 'voxtell voices [--grep <kw>]', desc: '音色枚举' },
        preview: { usage: 'voxtell preview <voice> [text]', desc: '音色试听(合成样例)' },
        models: { usage: 'voxtell models', desc: '能力表' },
        doctor: { usage: 'voxtell doctor', desc: '逐项体检' },
      },
      planned: PLANNED,
      exitCodes: { 0: '成功', 1: '任务失败', 2: '用法错误', 3: '已规划未实现', 4: '内部错误' },
      homepage: HOMEPAGE,
    },
    null,
    2,
  );
}

function fail(json: boolean, code: number, error: string, message: string): void {
  console.error(json ? JSON.stringify({ error, message }, null, 2) : `voxtell: ${message}`);
  process.exitCode = code;
}

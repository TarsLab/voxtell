# voxtell

**vox & tell** — batch speech synthesis with word-level timelines, from your terminal.

> **Status: V0 + batch (2026-08-17).** `say` / `batch` / `voices` / `preview` / `models` / `doctor`
> work from a repo checkout (Node ≥ 22.18, native type stripping, zero dependencies) against
> qwen-audio-3.0-tts-plus with the user-level content-addressed cache. `align` / `transcribe`
> (V1, FunASR) still exit `3`. The npm release is a name-reservation placeholder.

voxtell(边说边讲):tts 与 asr 同仓同 CLI——批量管线"合成 → 对齐"是一条流水线。
字级时间轴不依赖 TTS 型号的时间戳,走 `tts.batch → asr.align`(FunASR 本地强制对齐)。

## CLI

```
voxtell say <text|-> --voice <v> [--instruction <s>] [--model <m>] [--format mp3|wav] [--rate <f>] [--seed <n>] [--force] [-o out.mp3]
voxtell batch <jobs.json> [--out-dir <d>] [--dry-run] [--force] [--concurrency <n>]   # 清单进 → 音频 + results.json 出,全量幂等
voxtell align <audio> <text>                # (V1) FunASR 本地强制对齐 → 字级时间轴 JSON
voxtell transcribe <audio>                  # (V1) 本地转写
voxtell voices [--grep <kw>] [--gender 男|女] [--max-age <n>] · preview <voice> [text]   # 音色枚举(597)+ 试听
voxtell models [--json]                     # 能力表(data/models.json 是数据源,文档是视图)
voxtell doctor                              # key、业务空间、端点连通、缓存目录逐项体检,给修复命令
```

`say --timeline` = 合成后自动本地对齐,附带 `<out>.timeline.json`(V1)。

`batch` jobs.json:

```json
{ "defaults": { "voice": "qwen-audio-3.0-tts-plus-longhongxinxu", "instruction": "耐心温和的小学数学老师……", "format": "mp3", "languageHints": ["zh"] },
  "jobs": [ { "id": "step-1", "text": "14 位小朋友排成一队。……" }, { "id": "step-2", "text": "……" } ] }
```

Every job is cached by its own key (text + model + voice + instruction + params), so editing one line
re-synthesizes one line. `results.json` lists per job `{id, text, key, file, characters, cached, durationMs}`
plus a summary (hits / misses / billed characters). `durationMs` is measured from the audio itself (mp3 frame
header / wav header, zero dependencies, matches `afinfo` to the millisecond) — drawtell uses it to pace strokes
to narration. `--dry-run` reports the same without spending; the character
estimate is CJK×2 + others (measured ±5% against `usage.characters`).

Config: `DASHSCOPE_API_KEY` / `DASHSCOPE_WORKSPACE_ID` (env first) or `~/.config/voxtell/config.json`
`{"apiKey": "...", "workspaceId": "..."}` (mode 600). Cache: `~/.cache/voxtell/tts/<k2>/<key>.mp3` + `.json`
(`VOXTELL_CACHE_DIR` to move). Qwen-Audio-TTS non-realtime is a Beijing-region, workspace-scoped endpoint:
`https://<workspaceId>.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`.

Exit codes: `0` success · `1` job failed (message carries fix guidance) · `2` usage error ·
`3` planned-but-unimplemented · `4` internal error. Every command takes `--json`.

## Design principles

Agent-first, same rules as [drawtell](https://github.com/tarslab/drawtell): text in, text
out; `--json` everywhere; semantic exit codes; no interactive prompts; errors that say what
to do next. Plus the disciplines a paid component needs:

- **Idempotent = never pay twice.** Content-addressed cache at `~/.cache/voxtell/`,
  key = hash(text + model + voice + instruction + params); hits cost nothing, `--force` to
  re-synthesize. User-level, shared across workspaces.
- **`--dry-run` before spending.** `batch` lists entries, character counts, cache hit rate,
  and estimated cost — read the bill first. Local zero-cost `align`/`transcribe` skip this.
- **Key discipline.** `DASHSCOPE_API_KEY` from env first, config file second; no output or
  error message ever echoes the key.
- **No default voice.** Voice, tone, and whether audio goes to the cloud are application
  policy (confirmed by a parent), not mechanism — the CLI errors without `--voice` and
  lists candidates.
- **Capability table is a data file.** `models.json` lives in the repo; new models get
  small-sample tested before entries are added. Doc tables are views of it, not the truth.

## Roadmap

- ✓ **V0 name + skeleton**: `say` / `voices` / `models` / `doctor`, qwen tts-plus wired;
  idempotent cache landed in V0 — the cache is the soul of this component, not a bonus.
- ✓ (partly) **V1**: `batch` + `--dry-run` done (2026-08-17); `align` pending — the timeline pipeline
  closes when it lands. Acceptance: one real lesson text → audio + word-level timeline.
- ✓ **V2 drawtell glue**: `drawtell dub` dubs lesson bundles (glue lives on the drawtell side; voxtell
  stays bundle-agnostic). 12 real bundles dubbed on day one.
- **Later, same repo**: a thin realtime-streaming library (`voxtell/stream`) for live
  narration — not CLI-shaped, so it ships as a library export.

## Development

```bash
pnpm install
pnpm typecheck

node bin/voxtell.js --help
```

## License

MIT

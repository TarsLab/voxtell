# voxtell

**vox & tell** — batch speech synthesis with word-level timelines, from your terminal.

> **Status: skeleton.** The command surface is settled (below); every command currently
> exits `3` (planned-but-unimplemented). `--help` / `--version` work from a repo checkout
> (Node ≥ 22.18, runs the TS sources via native type stripping).

voxtell(边说边讲):tts 与 asr 同仓同 CLI——批量管线"合成 → 对齐"是一条流水线。
字级时间轴不依赖 TTS 型号的时间戳,走 `tts.batch → asr.align`(FunASR 本地强制对齐)。

## CLI

```
voxtell say <text|-> --voice <v> [--instruction <s>] [--timeline] [-o out.mp3]
voxtell batch <jobs.json> [--out-dir <d>] [--dry-run] [--force]   # 清单进 → 音频 + 结果清单出,全量幂等
voxtell align <audio> <text>                # FunASR 本地强制对齐 → 字级时间轴 JSON
voxtell transcribe <audio>                  # 本地转写
voxtell voices [--json] · preview <voice> [text]   # 音色枚举 + 试听
voxtell models [--json]                     # 能力表(models.json 是数据源,文档是视图)
voxtell doctor                              # key、FunASR 模型、网络逐项体检,给修复命令
```

`--timeline` = 合成后自动本地对齐,附带 `<out>.timeline.json`。

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

- **V0 name + skeleton**: `say` / `voices` / `models` / `doctor`, qwen tts-plus batch wired;
  idempotent cache lands in V0 — the cache is the soul of this component, not a bonus.
- **V1 `batch` + `--dry-run` + `align`**: timeline pipeline closes. Acceptance: one real
  lesson text → audio + word-level timeline.
- **V2 drawtell glue**: lesson-bundle dubbing (glue lives on the drawtell side; voxtell
  stays bundle-agnostic). Acceptance: a bundle with audio tracks, playable offline on iPad.
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

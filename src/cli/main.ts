/**
 * CLI 入口。约定与 drawtell 同一模式(agent-friendly):
 * 全命令支持 --json;无交互式提示;错误信息 = 修复指南;
 * exit code:0 成功 · 1 任务失败(输入或上游问题,带修复指引)· 2 用法错误 · 3 已规划未实现 · 4 内部错误。
 *
 * 花钱组件的额外纪律(实现各命令时的硬约束):
 * - 幂等 = 不重复花钱:用户级内容寻址缓存(~/.cache/voxtell/),
 *   key = hash(文本+型号+音色+instruction+参数),命中零成本,--force 才重合成
 * - batch 先 --dry-run 算账:条目、字符数、缓存命中率、预估费用;本地零成本的 align/transcribe 不设此负担
 * - 密钥纪律:env(DASHSCOPE_API_KEY)优先;任何输出与错误信息不回显密钥
 * - 无默认音色:音色、语气底色、上不上云是应用政策(家长确认),机制不夹带默认值
 */

const VERSION = '0.0.1';
const HOMEPAGE = 'https://github.com/tarslab/voxtell';

class UsageError extends Error {}

const PLANNED = ['say', 'batch', 'align', 'transcribe', 'voices', 'preview', 'models', 'doctor'];

const HELP = `voxtell ${VERSION} — vox & tell:批量语音合成 + 字级时间轴,从终端出发。

用法(命令面已定,全部实现中,调用返回 exit 3):
  voxtell say <text|-> --voice <v> [--instruction <s>] [--timeline] [-o out.mp3]
      单句合成。无默认音色:不带 --voice 报错并列出候选与 preview 命令。
      --timeline = 合成后自动本地对齐,附带 <out>.timeline.json(字级时间轴与 TTS 型号解耦)。
  voxtell batch <jobs.json> [--out-dir <d>] [--dry-run] [--force]
      清单进 → 音频 + 结果清单出,全量幂等(内容寻址缓存,命中零成本)。
      --dry-run 先算账:条目、字符数、缓存命中率、预估费用。
  voxtell align <audio> <text>
      FunASR 本地强制对齐 → 字级时间轴 JSON。本地零成本。
  voxtell transcribe <audio>
      本地转写。
  voxtell voices [--json]
      音色枚举(资产自 video-script 迁入)。
  voxtell preview <voice> [text]
      音色试听。
  voxtell models [--json]
      能力表。数据源 models.json 进仓库,新型号小样本实测后回填;文档表格是它的视图不是真相。
  voxtell doctor
      key、FunASR 模型、网络逐项体检,给修复命令。
  voxtell --help | --version [--json]

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
      default:
        if (PLANNED.includes(cmd)) {
          fail(json, 3, 'not_implemented', `'voxtell ${cmd}' 已规划、尚未实现(当前 ${VERSION})。命令面见 voxtell --help,进度见 ${HOMEPAGE}`);
          return;
        }
        fail(json, 2, 'unknown_command', `未知命令 '${cmd}'。运行 voxtell --help 查看用法。`);
    }
  } catch (err) {
    if (err instanceof UsageError) {
      fail(json, 2, 'usage', err.message);
    } else {
      console.error(json ? JSON.stringify({ error: 'internal', message: String(err instanceof Error ? (err.stack ?? err.message) : err) }) : `voxtell: 内部错误:${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      process.exitCode = 4;
    }
  }
}

function jsonHelp(): string {
  return JSON.stringify(
    {
      name: 'voxtell',
      version: VERSION,
      commands: {},
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

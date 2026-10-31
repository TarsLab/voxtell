/**
 * 配置与密钥解析。纪律:env 优先、用户级配置文件次之;任何输出与错误信息不回显密钥
 * (agent 会把输出带进上下文)。
 *
 * - DASHSCOPE_API_KEY            阿里云百炼 API key(北京地域)
 * - DASHSCOPE_WORKSPACE_ID       业务空间 id:Qwen-Audio-TTS 非实时接口是空间级域名
 * - VOXTELL_TTS_ENDPOINT         整个端点覆盖(测试 / 代理用)
 * - ~/.config/voxtell/config.json  {"apiKey": "...", "workspaceId": "...", "ttsEndpoint"?: "..."}
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const CONFIG_PATH = process.env.VOXTELL_CONFIG ?? join(homedir(), '.config', 'voxtell', 'config.json');

export type Source = 'env' | 'file' | null;

export interface Config {
  apiKey: string | null;
  workspaceId: string | null;
  ttsEndpoint: string;
  sources: { apiKey: Source; workspaceId: Source; ttsEndpoint: Source | 'derived' };
  configPath: string;
}

interface FileConfig {
  apiKey?: string;
  workspaceId?: string;
  ttsEndpoint?: string;
}

async function readFileConfig(): Promise<FileConfig> {
  try {
    const raw = JSON.parse(await readFile(CONFIG_PATH, 'utf8')) as FileConfig;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function ttsEndpointFor(workspaceId: string): string {
  return `https://${workspaceId}.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer`;
}

export async function loadConfig(): Promise<Config> {
  const file = await readFileConfig();
  const apiKey = process.env.DASHSCOPE_API_KEY || file.apiKey || null;
  const workspaceId = process.env.DASHSCOPE_WORKSPACE_ID || file.workspaceId || null;
  const endpointOverride = process.env.VOXTELL_TTS_ENDPOINT || file.ttsEndpoint || null;
  return {
    apiKey,
    workspaceId,
    ttsEndpoint: endpointOverride ?? (workspaceId ? ttsEndpointFor(workspaceId) : ''),
    sources: {
      apiKey: process.env.DASHSCOPE_API_KEY ? 'env' : file.apiKey ? 'file' : null,
      workspaceId: process.env.DASHSCOPE_WORKSPACE_ID ? 'env' : file.workspaceId ? 'file' : null,
      ttsEndpoint: process.env.VOXTELL_TTS_ENDPOINT ? 'env' : file.ttsEndpoint ? 'file' : 'derived',
    },
    configPath: CONFIG_PATH,
  };
}

/** 缺密钥/空间 id 时的修复指南(不含任何密钥内容) */
export function credentialsHint(cfg: Config): string | null {
  const missing: string[] = [];
  if (!cfg.apiKey) missing.push('DASHSCOPE_API_KEY');
  if (!cfg.workspaceId && !cfg.ttsEndpoint) missing.push('DASHSCOPE_WORKSPACE_ID');
  if (!missing.length) return null;
  return (
    `缺少 ${missing.join(' 与 ')}。设环境变量,或写入 ${cfg.configPath}` +
    `(JSON:{"apiKey": "...", "workspaceId": "..."},文件权限建议 600)。voxtell doctor 可逐项体检。`
  );
}

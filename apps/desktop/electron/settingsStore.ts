/**
 * 本地配置持久化。
 *
 * 解决的问题：以前 key 只能通过环境变量传，双击 exe 就是用不了。
 * 这不是「体验差」，是功能根本不可用 —— 也是给别人用的第一道门槛。
 *
 * 三条规矩：
 *   1. **密钥加密存储**：走 Electron 的 safeStorage（底层是系统密钥库）。
 *      加密不可用时降级为明文，但要在文件里明确标出来，不假装安全。
 *   2. **环境变量优先**：CI / 脚本注入的场景不该被本地文件覆盖。
 *   3. **写坏不启动失败**：配置文件损坏时退回默认值并告警，
 *      不能因为一个手改错的 JSON 让 app 起不来。
 */
import { app, safeStorage } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface AppSettings {
  /** 模型 key（内存中是明文，落盘时加密） */
  apiKey?: string;
  model?: string;
  endpoint?: string;
  api?: string;
  contextWindow?: number;
  /** 多模型：JSON 字符串，与 APP_MODELS 同格式 */
  models?: string;
  /** 思考档位，逗号分隔，与 APP_EFFORTS 同格式 */
  efforts?: string;
  /** 审批策略 */
  approval?: 'ipc' | 'allow';
  /** 工作目录；空 = 用 dataDir/workspace */
  workDir?: string;
}

/** 落盘形状：密钥单独一段，带加密标记 */
interface StoredSettings extends Omit<AppSettings, 'apiKey'> {
  /** 加密后的 key（base64） */
  apiKeyEnc?: string;
  /** 明文 key —— 只在 safeStorage 不可用时出现 */
  apiKeyPlain?: string;
  /** 标记这份文件是不是加密存的，UI 要据此提示 */
  keyEncrypted?: boolean;
}

let cachedPath: string | null = null;
function settingsPath(): string {
  if (!cachedPath) cachedPath = path.join(app.getPath('userData'), 'settings.json');
  return cachedPath;
}

/** 配置文件路径（UI 展示用，让用户知道东西存哪了） */
export function settingsFilePath(): string {
  return settingsPath();
}

/** 读配置。文件不存在 / 损坏都返回空对象，不抛。 */
export async function readSettings(): Promise<AppSettings> {
  let raw: string;
  try {
    raw = await fs.readFile(settingsPath(), 'utf8');
  } catch {
    return {};
  }

  let stored: StoredSettings;
  try {
    stored = JSON.parse(raw) as StoredSettings;
  } catch {
    // 文件被手改坏了：告警但继续，用默认值
    console.warn('[settings] settings.json 解析失败，忽略:', settingsPath());
    return {};
  }

  const out: AppSettings = { ...stored };
  delete (out as StoredSettings).apiKeyEnc;
  delete (out as StoredSettings).apiKeyPlain;
  delete (out as StoredSettings).keyEncrypted;

  if (stored.apiKeyEnc) {
    try {
      out.apiKey = safeStorage.decryptString(Buffer.from(stored.apiKeyEnc, 'base64'));
    } catch (error) {
      // 换了机器/用户后密钥库解不开，这是预期内的；当作没配
      console.warn('[settings] 密钥解密失败（可能需要重新填写）:', String(error));
    }
  } else if (stored.apiKeyPlain) {
    out.apiKey = stored.apiKeyPlain;
  }
  return out;
}

/**
 * 写配置。
 *
 * 只写非空字段：空字符串等于「没设置」，留着会让默认值无法生效。
 */
export async function writeSettings(next: AppSettings): Promise<{ encrypted: boolean }> {
  const stored: StoredSettings = {};
  for (const key of ['model', 'endpoint', 'api', 'models', 'efforts', 'approval', 'workDir'] as const) {
    const value = next[key];
    if (typeof value === 'string' && value.trim()) {
      (stored as Record<string, unknown>)[key] = value.trim();
    }
  }
  if (typeof next.contextWindow === 'number' && Number.isFinite(next.contextWindow)) {
    stored.contextWindow = next.contextWindow;
  }

  let encrypted = false;
  if (next.apiKey && next.apiKey.trim()) {
    const key = next.apiKey.trim();
    // isEncryptionAvailable 在 Linux 无密钥库 / 某些 headless 环境会返回 false
    if (safeStorage.isEncryptionAvailable()) {
      stored.apiKeyEnc = safeStorage.encryptString(key).toString('base64');
      stored.keyEncrypted = true;
      encrypted = true;
    } else {
      // 明确降级：能存，但要让人知道这是明文
      stored.apiKeyPlain = key;
      stored.keyEncrypted = false;
    }
  }

  await fs.mkdir(path.dirname(settingsPath()), { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(stored, null, 2), 'utf8');
  return { encrypted };
}

/** 这份配置里有没有 key（不返回 key 本身） */
export async function hasStoredKey(): Promise<{ hasKey: boolean; encrypted: boolean }> {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8');
    const stored = JSON.parse(raw) as StoredSettings;
    const hasKey = Boolean(stored.apiKeyEnc || stored.apiKeyPlain);
    return { hasKey, encrypted: stored.keyEncrypted === true };
  } catch {
    return { hasKey: false, encrypted: false };
  }
}

/** 加密是否可用（UI 用它决定要不要提示「将明文保存」） */
export function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

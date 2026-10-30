/**
 * 多模型配置。
 *
 * 为什么要这个：模型热切换的前提是「有第二个模型可选」。
 * 之前宿主只挂了一个写死的 id，pi 的 availableModels 是空数组，
 * 切换功能根本无从谈起 —— 不是没接，是没东西可切。
 *
 * 格式（APP_MODELS，JSON 数组）：
 *   [{"id":"deepseek-v4.1-flash-1017","label":"DeepSeek"},
 *    {"id":"gpt-4o","label":"GPT-4o","endpoint":"https://api.openai.com/v1",
 *     "api":"openai-completions","contextWindow":128000}]
 *
 * 只写 id 也行；其余字段缺省时回落到单模型那套 env（APP_ENDPOINT / APP_API 等）。
 * 这样「只有一个模型」的老用法完全不受影响。
 */

export interface ModelEntry {
  /** 上游模型 id */
  id: string;
  /** 界面上显示的名字；缺省用 id */
  label: string;
  /** 缺省回落到全局 APP_ENDPOINT */
  endpoint?: string;
  /** 缺省回落到全局 APP_API */
  api?: string;
  /** 缺省回落到全局 APP_CONTEXT_WINDOW */
  contextWindow?: number;
  /** 缺省回落到全局 APP_EFFORTS */
  efforts?: string[];
}

export interface ModelCatalog {
  entries: ModelEntry[];
  /** 是否为多模型模式（APP_MODELS 有内容） */
  multi: boolean;
}

/** 解析 APP_MODELS；解析不了就退回单模型，不因为配置写错而启动失败 */
export function parseModelCatalog(
  raw: string | undefined,
  fallback: { id: string; contextWindow: number; efforts: string[] },
): ModelCatalog {
  const single: ModelCatalog = {
    entries: [{ id: fallback.id, label: fallback.id }],
    multi: false,
  };
  const text = (raw ?? '').trim();
  if (!text) return single;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // 写错了就当没配 —— 启动失败比少个切换按钮严重得多
    return single;
  }
  if (!Array.isArray(parsed)) return single;

  const entries: ModelEntry[] = [];
  for (const item of parsed) {
    if (typeof item === 'string') {
      const id = item.trim();
      if (id) entries.push({ id, label: id });
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    const rec = item as Record<string, unknown>;
    const id = typeof rec.id === 'string' ? rec.id.trim() : '';
    if (!id) continue;
    entries.push({
      id,
      label: typeof rec.label === 'string' && rec.label.trim() ? rec.label.trim() : id,
      endpoint: typeof rec.endpoint === 'string' ? rec.endpoint : undefined,
      api: typeof rec.api === 'string' ? rec.api : undefined,
      contextWindow: typeof rec.contextWindow === 'number' ? rec.contextWindow : undefined,
      efforts: Array.isArray(rec.efforts)
        ? rec.efforts.filter((e): e is string => typeof e === 'string')
        : undefined,
    });
  }

  if (entries.length === 0) return single;
  return { entries, multi: entries.length > 1 };
}

/**
 * 把原始错误翻译成「人话 + 下一步」。
 *
 * 为什么要这层：worker 挂了的时候，用户只看到
 *   `[Auto-bridged: worker 异常终止]`
 * 或者一行 `401 Unauthorized: The API Key does not exist or signature
 * verification failed. Please check whether the API Key is correct. See:
 * https://console.cloud.tencent.com/tokenhub/apikey, url: http://127.0.0.1:57889/responses`
 *
 * 这条信息里其实什么都有，但**用户无法据此行动**：
 *   - 那个 127.0.0.1 是 pi 内部的 loopback 代理，用户看到会以为是我们坏了
 *   - 「signature verification failed」听着像代码 bug
 *   - 最关键的「去改 key」藏在最后
 *
 * 所以按错误类型给出：**发生了什么 + 为什么 + 该做什么**。
 * 分类用保守匹配：认不出来的就原样显示，不硬套。
 */
export interface DiagnosedError {
  /** 一句话说清发生了什么（给卡片标题） */
  title: string;
  /** 为什么，以及该做什么 */
  hint?: string;
  /** 建议的下一步动作；UI 据此显示按钮 */
  action?: 'open-settings' | 'restart-app' | 'check-network';
  /** 原始错误，折叠显示，排查时要用 */
  raw: string;
}

/** 本地 loopback 代理的地址 —— 出现在错误里要当成"我们的内部细节"藏掉 */
const LOOPBACK = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?\S*/gi;

/** 去掉 URL 尾巴，错误信息能短一半，也避免用户盯着端口号发懵 */
function stripNoise(raw: string): string {
  return raw.replace(LOOPBACK, '').replace(/\s{2,}/g, ' ').replace(/[,，]\s*$/, '').trim();
}

export function diagnoseError(raw: string | undefined | null): DiagnosedError {
  const text = (raw ?? '').trim();
  const cleaned = stripNoise(text);

  if (!text) {
    return { title: '出错了，但没有详细信息', raw: '' };
  }

  // ---- 认证 / key ----
  // 401 是最常见的：换过 key、额度用完、key 过期，都长这样
  if (/401|unauthorized|api key does not exist|signature verification failed/i.test(text)) {
    return {
      title: 'API Key 无效或已失效',
      hint:
        '常见原因：设置里换过 key、key 过期、或账户额度不足。' +
        '已经在跑的任务不会自动换 key —— 改完需要重启应用，新建的会话才会用新 key。',
      action: 'open-settings',
      raw: cleaned || text,
    };
  }

  if (/403|forbidden|permission denied for model/i.test(text)) {
    return {
      title: '没有权限使用这个模型',
      hint: '当前 API Key 可能没有开通这个模型，或者账户被限制。可以换个模型试试。',
      action: 'open-settings',
      raw: cleaned || text,
    };
  }

  // ---- 额度 ----
  if (/429|rate limit|too many requests|quota|insufficient_quota/i.test(text)) {
    return {
      title: '请求太频繁或额度用完',
      hint: '等一会儿再试。如果是额度用完，需要到服务商控制台充值或换 key。',
      raw: cleaned || text,
    };
  }

  // ---- 模型不存在 ----
  if (/model.*(not exist|does not exist|not found)|invalid model/i.test(text)) {
    return {
      title: '模型不存在',
      hint: '设置里配置的模型 ID 在服务商那边找不到。检查模型名是否写错，或该模型是否已下线。',
      action: 'open-settings',
      raw: cleaned || text,
    };
  }

  // ---- 网络 ----
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|fetch failed|network error/i.test(text)) {
    return {
      title: '连不上模型服务',
      hint: '检查网络和设置里的接口地址（endpoint）是否正确。公司网络或代理可能拦截了请求。',
      action: 'check-network',
      raw: cleaned || text,
    };
  }

  if (/timeout|timed out|stall|no response/i.test(text)) {
    return {
      title: '模型服务响应超时',
      hint: '可能是任务太大、网络慢，或服务商那边繁忙。可以重试一次。',
      raw: cleaned || text,
    };
  }

  // ---- 上下文超限 ----
  if (/context.*(length|window|limit)|too many tokens|max_tokens/i.test(text)) {
    return {
      title: '上下文超出模型上限',
      hint: '这个会话的对话太长了。用「压缩上下文」把早期内容概括掉再继续。',
      raw: cleaned || text,
    };
  }

  // ---- 进程挂了 ----
  if (/exited|terminated|killed|crash|abnormal/i.test(text)) {
    return {
      title: '任务进程意外退出',
      hint: '可能是内存不足或被系统终止。重试通常能恢复；反复出现的话看一下任务是不是太大。',
      raw: cleaned || text,
    };
  }

  // 认不出来的：原样给，但至少把 loopback 地址藏掉
  return { title: '出错了', hint: undefined, raw: cleaned || text };
}

/**
 * worker 异常终止时的摘要。
 *
 * 比 diagnoseError 多一件事：说清「这个 worker 现在什么状态」。
 * 用户看到错误第一反应是「我的活干完了吗」。
 */
export function diagnoseWorkerFailure(raw: string | undefined | null): DiagnosedError {
  const d = diagnoseError(raw);
  return {
    ...d,
    title: `worker 中断：${d.title}`,
  };
}

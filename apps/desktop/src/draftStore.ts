/**
 * 输入草稿持久化。
 *
 * 问题：正在打一段话，不小心切了会话或关了窗口，字就没了。
 * 做法：每个会话的草稿单独存 localStorage，切回来能接着打。
 *
 * 为什么用 localStorage 而不是主进程 / SQLite：
 * 草稿是纯前端状态，几百字节，没有跨进程或跨设备需求。
 * 走 IPC 反而要加一条通道、一个 migration。
 */

const PREFIX = 'juno.draft.';

/** 单条草稿上限。超了就不存 —— 避免有人粘一整个日志进来把 localStorage 塞爆 */
const MAX_LEN = 20000;

function key(sessionId: string): string {
  return PREFIX + sessionId;
}

export function readDraft(sessionId: string | null): string {
  if (!sessionId) return '';
  try {
    return localStorage.getItem(key(sessionId)) ?? '';
  } catch {
    // 隐私模式 / 存储被禁用时会抛，不能因为读草稿把界面搞崩
    return '';
  }
}

export function writeDraft(sessionId: string | null, text: string): void {
  if (!sessionId) return;
  try {
    if (!text) {
      // 空草稿直接删，避免 localStorage 里堆一堆空 key
      localStorage.removeItem(key(sessionId));
      return;
    }
    localStorage.setItem(key(sessionId), text.slice(0, MAX_LEN));
  } catch {
    /* 存储满了或被禁用，静默放弃 —— 草稿丢了不该比界面崩了更严重 */
  }
}

/** 清掉某会话的草稿（发送成功时调） */
export function clearDraft(sessionId: string | null): void {
  if (!sessionId) return;
  try {
    localStorage.removeItem(key(sessionId));
  } catch {
    /* 同上 */
  }
}

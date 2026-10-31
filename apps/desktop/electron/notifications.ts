/**
 * 后台完成通知。
 *
 * 存在的理由：多会话并行后，「让它跑 A，我去做 B」是主要用法。
 * 但 A 跑完时用户可能正在别的窗口里，**完全无从得知** ——
 * 那并行就只是「后台在烧钱」，用户感受不到价值。
 *
 * 三条克制原则：
 *   1. **只在窗口没焦点时通知**：用户正看着界面，界面上有变化就够了
 *   2. **只通知后台会话**：当前会话完成了看得见，再弹通知是骚扰
 *   3. **有上标题**：通知里带上会话名，用户才知道是哪个跑完了
 */
import { BrowserWindow, Notification } from 'electron';

export interface NotifyInput {
  sessionId: string;
  /** 会话标题，作为通知标题 */
  title: string;
  /** 一句话摘要（模型回复的开头），没有就用状态词 */
  preview?: string;
  /** 成功还是失败 */
  state: 'done' | 'error';
}

/** 通知去重：同一会话短时间内连发多条会很吵 */
const lastNotified = new Map<string, number>();
const NOTIFY_GAP_MS = 5_000;

/** 系统是否支持通知——不支持时静默跳过，不报错 */
export function notificationsSupported(): boolean {
  try {
    return Notification.isSupported();
  } catch {
    return false;
  }
}

/**
 * 判断这条是否该通知。
 *
 * 抽出来是为了可测：真正的「要不要打扰用户」逻辑都在这里，
 * 不该埋在 electron 的构造函数调用里。
 */
export function shouldNotify(
  win: BrowserWindow | null,
  input: {
    sessionId: string;
    isCurrentSession: boolean;
    now: number;
    /**
     * 窗口是否有焦点。默认读真实窗口状态；
     * 测试里传值进来 —— 测试窗口通常是隐藏/强制聚焦的，blur() 不生效，
     * 不注入的话「用户没看着界面」这条分支永远验不到。
     */
    focused?: boolean;
  },
): { notify: boolean; reason?: string } {
  if (!win || win.isDestroyed()) return { notify: false, reason: 'no-window' };

  // 判断顺序有意为之：先说「为什么这类消息本来就不该弹」，再说窗口状态。
  // 反过来的话，一份「当前会话」的日志会显示成「因为窗口有焦点」，
  // 排查时会误以为是焦点判断出了问题。

  // 当前会话的完成在界面主区可见，弹通知是重复信息
  if (input.isCurrentSession) return { notify: false, reason: 'current-session' };

  // 用户正看着界面：界面上会显示结果，不用再弹
  const focused = input.focused ?? win.isFocused();
  if (focused) return { notify: false, reason: 'focused' };

  const last = lastNotified.get(input.sessionId) ?? 0;
  if (input.now - last < NOTIFY_GAP_MS) return { notify: false, reason: 'throttled' };

  // 判定为「该通知」的同时就记账。
  // 之前是在真正 show() 之后才记，结果「判断」和「记账」分成两处：
  // 任何不经过 show() 的调用（比如测试、或 show 抛错）都不会被节流。
  lastNotified.set(input.sessionId, input.now);
  return { notify: true };
}

/**
 * 发通知。
 *
 * 失败一律吞掉：发不出通知不该影响任何业务流程。
 * 在 headless / 没有通知服务的环境里 Notification 会抛，这是预期内的。
 */
export function notifyTurnFinished(
  win: BrowserWindow | null,
  input: NotifyInput,
  isCurrentSession: boolean,
  onClick?: (sessionId: string) => void,
): { shown: boolean; reason?: string } {
  const now = Date.now();
  const verdict = shouldNotify(win, { sessionId: input.sessionId, isCurrentSession, now });
  if (!verdict.notify) return { shown: false, reason: verdict.reason };

  if (!notificationsSupported()) return { shown: false, reason: 'unsupported' };

  try {
    const body =
      input.state === 'error'
        ? '这一轮出错了，点开看看'
        : (input.preview?.trim() || '跑完了').slice(0, 120);

    const notification = new Notification({
      title: input.title || '会话',
      body,
      silent: false,
    });

    notification.on('click', () => {
      if (!win || win.isDestroyed()) return;
      // 点通知：把窗口带到前台，并让界面切到那个会话
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      onClick?.(input.sessionId);
    });

    notification.show();
    return { shown: true };
  } catch (error) {
    return { shown: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

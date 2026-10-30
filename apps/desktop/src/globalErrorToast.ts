/**
 * 非致命的全局错误提示。
 *
 * 和 ErrorBoundary 分工不同：
 *   - ErrorBoundary 接「整个界面炸了」，显示全屏恢复页
 *   - 这里接「某个操作失败了但界面还在」，只在角落弹一条
 *
 * 为什么不用 React 组件：它要在 React 外面也能用（window 上的错误事件
 * 可能发生在任何时刻，包括 React 正在卸载的时候）。
 * 直接操作 DOM 反而最稳。
 */

const CONTAINER_ID = 'global-error-toast';
const DISMISS_MS = 8000;

let lastMessage = '';
let lastShownAt = 0;

/** 同一条错误 3 秒内只弹一次：一个失败的循环可能瞬间刷几十条 */
const DEDUPE_MS = 3000;

export function reportHostError(kind: string, message: string): void {
  const text = `${kind}: ${message}`;
  const now = Date.now();
  if (text === lastMessage && now - lastShownAt < DEDUPE_MS) return;
  lastMessage = text;
  lastShownAt = now;

  let container = document.getElementById(CONTAINER_ID);
  if (!container) {
    container = document.createElement('div');
    container.id = CONTAINER_ID;
    container.style.cssText = [
      'position:fixed',
      'bottom:16px',
      'left:50%',
      'transform:translateX(-50%)',
      'z-index:190',
      'max-width:min(560px,calc(100vw - 32px))',
      'display:flex',
      'align-items:flex-start',
      'gap:8px',
      'padding:8px 12px',
      'border-radius:8px',
      'border:1px solid var(--border-strong)',
      'background:var(--surface-elevated)',
      'box-shadow:0 8px 24px rgb(0 0 0 / 12%)',
      'font-size:12px',
      'line-height:1.5',
      'color:var(--text-primary)',
    ].join(';');
    document.body.appendChild(container);
  }

  container.textContent = '';

  const label = document.createElement('span');
  label.textContent = text;
  label.style.cssText = 'flex:1;min-width:0;overflow-wrap:anywhere';

  const close = document.createElement('button');
  close.textContent = '×';
  close.title = '关闭';
  close.style.cssText =
    'flex:none;border:0;background:transparent;color:var(--text-tertiary);cursor:pointer;font-size:14px;line-height:1;padding:0 2px';
  close.onclick = () => container?.remove();

  container.append(label, close);
  container.style.display = 'flex';

  window.setTimeout(() => {
    // 只有还显示着同一条错误时才自动消失，避免把后来的错误一起清掉
    if (container?.textContent?.includes(text)) container.remove();
  }, DISMISS_MS);
}

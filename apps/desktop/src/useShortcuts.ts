/**
 * 全局键盘快捷键。
 *
 * 只在「不是正在输入」时触发 —— 否则 Ctrl+N 会把输入框里的字母吃掉。
 * 判定方式看 activeElement：textarea / input / contenteditable 里一律跳过。
 */
import { useEffect } from 'react';

export interface ShortcutHandlers {
  newSession: () => void;
  openSettings: () => void;
  toggleTheme: () => void;
  focusSearch: () => void;
  /** Esc：关掉最上层的东西。由调用方决定关哪一层 */
  escape: () => void;
  /** 当前是否还有打开的浮层 —— 有的话 Esc 优先给它 */
  hasOverlay: () => boolean;
}

/** 焦点是否在可输入元素里 */
function isTyping(): boolean {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT') return true;
  return (el as HTMLElement).isContentEditable;
}

export function useShortcuts(handlers: ShortcutHandlers): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Esc 无论在哪都要能用 —— 用户正打字时按 Esc 也是想关面板
      if (e.key === 'Escape') {
        if (handlers.hasOverlay()) {
          e.preventDefault();
          handlers.escape();
        }
        return;
      }

      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;

      /*
       * 输入框里只放行 Ctrl+N（新建）。
       * 其他组合在文本框里可能是编辑器自己的（比如 Ctrl+K 删到行尾），
       * 抢过来会让人莫名其妙。
       */
      const typing = isTyping();

      if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        handlers.newSession();
        return;
      }

      if (typing) return;

      if (e.key === ',') {
        e.preventDefault();
        handlers.openSettings();
        return;
      }

      if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        handlers.focusSearch();
        return;
      }

      // Ctrl+Shift+L 切主题（用 L 是因为 light/dark，且避开浏览器自带的）
      if (e.shiftKey && e.key.toLowerCase() === 'l') {
        e.preventDefault();
        handlers.toggleTheme();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handlers]);
}

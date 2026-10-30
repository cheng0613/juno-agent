import React from 'react';
import { createRoot } from 'react-dom/client';

import './styles/app.generated.css';
import { App } from './App';
import { ErrorBoundary } from './ErrorBoundary';
import { reportHostError } from './globalErrorToast';

// 挂到 window 上：main.tsx 下面的全局监听器要用
declare global {
  interface Window {
    __reportHostError?: (kind: string, message: string) => void;
  }
}
window.__reportHostError = reportHostError;

const el = document.getElementById('root');
if (!el) throw new Error('#root not found');

/**
 * 全局兜底。
 *
 * React 的 error boundary 只接渲染期同步异常，
 * 这两类它接不到：
 *   - 事件回调里未捕获的错误 → window 'error'
 *   - Promise 链上没人 catch → 'unhandledrejection'
 *
 * 不装这两层的话，这类错误只会静默消失，用户看到「点了没反应」。
 * 这里不试图恢复（已经离开 React 的调用栈），只保证：
 *   1. 控制台有完整堆栈
 *   2. 用户能看到一条提示，而不是以为程序卡死
 */
function reportGlobal(kind: string, detail: unknown): void {
  console.error(`[renderer] ${kind}`, detail);
  if (typeof window !== 'undefined' && typeof window.__reportHostError === 'function') {
    window.__reportHostError(kind, String(detail));
  }
}

window.addEventListener('error', (event) => {
  reportGlobal('未捕获错误', event.error ?? event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  reportGlobal('未处理的 Promise 拒绝', event.reason);
});

createRoot(el).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);

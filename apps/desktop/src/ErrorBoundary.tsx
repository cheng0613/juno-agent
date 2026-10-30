import { Component, type ErrorInfo, type ReactNode } from 'react';

/**
 * 渲染层错误边界。
 *
 * 在这之前，任何渲染异常都会让界面变成一片白 —— 用户只能强杀进程，
 * 也不知道发生了什么、能不能恢复。这是「给别人用」必须补的一环。
 *
 * 三条原则：
 *   1. **不静默**：错误必须显示出来，而不是吞掉
 *   2. **可恢复**：给「重试」和「重新加载」两条路
 *   3. **可复制**：错误详情能一键复制，方便反馈问题
 */
interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  info: ErrorInfo | null;
  copied: boolean;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, info: null, copied: false };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ info });
    // 主进程日志里也留一份，方便事后排查
    console.error('[renderer] uncaught error', error, info.componentStack);
  }

  private reset = () => {
    this.setState({ error: null, info: null, copied: false });
  };

  private reload = () => {
    window.location.reload();
  };

  private copy = async () => {
    const { error, info } = this.state;
    const text = [
      `错误：${error?.name ?? 'Error'}: ${error?.message ?? ''}`,
      '',
      '组件栈：',
      info?.componentStack ?? '(无)',
      '',
      '调用栈：',
      error?.stack ?? '(无)',
    ].join('\n');
    try {
      await navigator.clipboard.writeText(text);
      this.setState({ copied: true });
      setTimeout(() => this.setState({ copied: false }), 2000);
    } catch {
      // 剪贴板不可用时退回选中文本
      window.prompt('复制下面的内容：', text);
    }
  };

  render(): ReactNode {
    const { error, info } = this.state;
    if (!error) return this.props.children;

    return (
      <div
        data-testid="error-boundary"
        className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-4 bg-surface p-6"
      >
        <div className="w-full max-w-[620px] rounded-lg border border-default bg-surface-elevated p-5 shadow-lg">
          <div className="mb-2 flex items-center gap-2">
            <span className="rounded-full bg-[var(--danger-soft)] px-2 py-0.5 text-11 text-[var(--danger)]">
              出错了
            </span>
            <span className="text-15 text-text-primary">界面遇到一个未处理的问题</span>
          </div>

          <p className="m-0 mb-3 text-13 leading-relaxed text-text-secondary">
            对话数据没有丢，都保存在本地。可以先重试；重试无效就重新加载界面。
          </p>

          <pre className="m-0 mb-4 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded bg-surface-sunken p-3 font-mono text-11 leading-normal text-[var(--danger)]">
            {error.name}: {error.message}
            {info?.componentStack ? `\n${info.componentStack.split('\n').slice(0, 6).join('\n')}` : ''}
          </pre>

          <div className="flex flex-wrap justify-end gap-2">
            <button
              className="rounded border border-[var(--border-strong)] px-3 py-1.5 text-12 text-text-secondary hover:bg-surface-hover"
              onClick={() => void this.copy()}
            >
              {this.state.copied ? '已复制' : '复制详情'}
            </button>
            <button
              className="rounded border border-[var(--border-strong)] px-3 py-1.5 text-12 text-text-secondary hover:bg-surface-hover"
              onClick={this.reload}
            >
              重新加载
            </button>
            <button
              className="rounded bg-[var(--ink)] px-3 py-1.5 text-12 text-[var(--text-inverse)] hover:bg-[var(--ink-hover)]"
              onClick={this.reset}
            >
              重试
            </button>
          </div>
        </div>
      </div>
    );
  }
}

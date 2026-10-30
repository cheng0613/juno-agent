import type { TaskInfo } from './shared/ipc';

/**
 * 子任务卡片。
 *
 * 放在对话流里而不是侧边栏：子任务是「在这一轮里派出去的活」，
 * 离开上下文单独看一排任务，用户会不知道它们属于哪个请求。
 *
 * 折叠态只显示「几个任务 + 进行到哪」；展开能看每个子任务的诉求。
 * 样式走 Tailwind utility（与上游 Cindy 一致）。
 */
export function TaskCard({
  tasks,
  onStop,
}: {
  tasks: TaskInfo[];
  onStop: (taskId: string) => void;
}) {
  if (tasks.length === 0) return null;

  const running = tasks.filter((t) => !isDone(t.status)).length;
  const failed = tasks.filter((t) => t.status === 'error').length;
  const headState = running > 0 ? 'pending' : failed > 0 ? 'err' : 'ok';

  return (
    <div
      data-testid="task-card"
      className="my-4 mb-2 w-full max-w-[760px] overflow-hidden rounded-md border border-default bg-surface-elevated"
    >
      <div className="flex items-center gap-2 border-b border-default px-3 py-2">
        <span className={`dot ${headState}`} />
        <span className="text-12 text-text-primary">子任务</span>
        <span className="ml-auto text-11 tabular-nums text-text-tertiary">
          {running > 0 ? `${running} 个进行中` : '全部结束'}
          {failed > 0 ? ` · ${failed} 个失败` : ''}
        </span>
      </div>

      <div className="flex flex-col">
        {tasks.map((task) => {
          const done = isDone(task.status);
          const dotState = done ? (task.status === 'error' ? 'err' : 'ok') : 'pending';
          return (
            <details
              key={task.taskId}
              data-testid="task-item"
              className="border-b border-default last:border-b-0"
            >
              <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-12 hover:bg-surface-hover">
                <span className={`dot ${dotState}`} />
                <span className="min-w-0 flex-1 truncate text-text-secondary">{task.title}</span>
                {!done && (
                  <button
                    className="shrink-0 rounded border border-[var(--border-strong)] px-2 py-px text-11 text-text-tertiary hover:border-[var(--danger)] hover:text-[var(--danger)]"
                    title="停掉这个子任务"
                    onClick={(e) => {
                      // 阻止冒泡：点停止不该同时把卡片展开/收起
                      e.preventDefault();
                      e.stopPropagation();
                      onStop(task.taskId);
                    }}
                  >
                    停止
                  </button>
                )}
              </summary>
              {task.description && (
                <pre className="m-0 max-h-60 overflow-auto whitespace-pre-wrap px-3 pt-2 pb-3 font-mono text-11 leading-normal text-text-secondary">
                  {task.description}
                </pre>
              )}
            </details>
          );
        })}
      </div>
    </div>
  );
}

function isDone(status: string): boolean {
  return status !== 'running' && status !== 'pending';
}

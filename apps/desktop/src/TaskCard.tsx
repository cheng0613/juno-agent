import type { TaskInfo } from './shared/ipc';

/**
 * 子任务卡片。
 *
 * 放在对话流里而不是侧边栏：子任务是「在这一轮里派出去的活」，
 * 离开上下文单独看一排任务，用户会不知道它们属于哪个请求。
 *
 * 折叠态只显示「几个任务 + 进行到哪」；展开能看每个子任务的诉求。
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

  return (
    <div className="task-card">
      <div className="task-head">
        <span className={`dot ${running > 0 ? 'pending' : failed > 0 ? 'err' : 'ok'}`} />
        <span className="task-title">子任务</span>
        <span className="task-summary">
          {running > 0 ? `${running} 个进行中` : '全部结束'}
          {failed > 0 ? ` · ${failed} 个失败` : ''}
        </span>
      </div>

      <div className="task-list">
        {tasks.map((task) => (
          <details className="task-item" key={task.taskId}>
            <summary>
              <span className={`dot ${isDone(task.status) ? (task.status === 'error' ? 'err' : 'ok') : 'pending'}`} />
              <span className="task-name">{task.title}</span>
              {!isDone(task.status) && (
                <button
                  className="task-stop"
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
            {task.description && <pre className="task-desc">{task.description}</pre>}
          </details>
        ))}
      </div>
    </div>
  );
}

function isDone(status: string): boolean {
  return status !== 'running' && status !== 'pending';
}

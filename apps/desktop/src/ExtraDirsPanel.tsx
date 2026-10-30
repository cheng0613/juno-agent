import type { ExtraDirs } from './shared/ipc';

/**
 * 额外工作目录面板。
 *
 * 只读和可写分成两块：它们是两个权限层级。
 * 合并成一个列表，用户会以为「加进来就能写」，结果改不动文件还以为坏了。
 *
 * 样式走 Tailwind utility（与上游 Cindy 一致）。
 */
export function ExtraDirsPanel({
  dirs,
  disabled,
  onChange,
  onClose,
  onPick,
}: {
  dirs: ExtraDirs;
  disabled: boolean;
  onChange: (next: ExtraDirs) => void;
  onClose: () => void;
  onPick: () => Promise<string | null>;
}) {
  const add = async (kind: 'read' | 'write') => {
    const picked = await onPick();
    if (!picked) return;
    if (dirs[kind].includes(picked)) return;
    onChange({ ...dirs, [kind]: [...dirs[kind], picked] });
  };

  const remove = (kind: 'read' | 'write', dir: string) => {
    onChange({ ...dirs, [kind]: dirs[kind].filter((d) => d !== dir) });
  };

  return (
    <aside
      data-testid="dirs-panel"
      className="absolute right-0 z-30 flex w-[min(420px,55%)] flex-col gap-2 overflow-auto border-l border-default bg-surface-elevated pb-3 shadow-lg"
      style={{ top: 'var(--topbar-h, 37px)', bottom: 'var(--composer-h, 92px)' }}
    >
      <div className="flex items-center border-b border-default px-4 py-3">
        <span className="flex-1 text-13 text-text-primary">额外工作目录</span>
        <button
          className="rounded px-2 py-0.5 text-16 leading-none text-text-tertiary hover:bg-surface-hover hover:text-text-primary"
          title="收起"
          onClick={onClose}
        >
          ×
        </button>
      </div>

      <p className="m-0 px-4 py-2 text-11 leading-relaxed text-text-tertiary">
        除了当前会话的工作目录，还可以让它看别的目录。改动立即生效，并会记住。
      </p>

      <DirSection
        kind="read"
        label="只读"
        hint="能看文件，不能改"
        items={dirs.read}
        disabled={disabled}
        onAdd={() => void add('read')}
        onRemove={(d) => remove('read', d)}
      />

      <DirSection
        kind="write"
        label="可写"
        hint="能读也能改，谨慎添加"
        items={dirs.write}
        disabled={disabled}
        onAdd={() => void add('write')}
        onRemove={(d) => remove('write', d)}
      />
    </aside>
  );
}

function DirSection({
  kind,
  label,
  hint,
  items,
  disabled,
  onAdd,
  onRemove,
}: {
  kind: 'read' | 'write';
  label: string;
  hint: string;
  items: string[];
  disabled: boolean;
  onAdd: () => void;
  onRemove: (dir: string) => void;
}) {
  return (
    <section className="px-4 pt-2 pb-3">
      <div className="mb-2 flex items-baseline gap-2">
        <span
          className={`text-12 font-medium ${kind === 'write' ? 'text-[var(--warning)]' : 'text-text-primary'}`}
        >
          {label}
        </span>
        <span className="flex-1 text-11 text-text-tertiary">{hint}</span>
        <button
          className="shrink-0 rounded px-2 py-0.5 text-11 text-text-secondary hover:bg-surface-hover hover:text-text-primary disabled:opacity-50"
          disabled={disabled}
          onClick={onAdd}
        >
          添加
        </button>
      </div>
      {items.length === 0 ? (
        <p className="m-0 text-11 text-text-placeholder">还没有</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-1 p-0">
          {items.map((dir) => (
            <li
              key={dir}
              data-testid="dirs-item"
              className="flex items-center gap-2 rounded bg-surface-sunken px-2 py-[3px]"
            >
              <span className="dirs-path min-w-0 flex-1 truncate font-mono text-11 text-text-secondary" title={dir}>
                {dir}
              </span>
              <button
                className="shrink-0 border-0 bg-transparent px-0.5 text-13 leading-none text-text-tertiary hover:text-[var(--danger)] disabled:opacity-50"
                title="移除"
                disabled={disabled}
                onClick={() => onRemove(dir)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

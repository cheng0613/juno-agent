import type { ExtraDirs } from './shared/ipc';

/**
 * 额外工作目录面板。
 *
 * 只读和可写分成两块：它们是两个权限层级。
 * 合并成一个列表，用户会以为「加进来就能写」，结果改不动文件还以为坏了。
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
    <aside className="dirs-panel">
      <div className="dirs-head">
        <span className="dirs-title">额外工作目录</span>
        <button className="ghost dirs-close" title="收起" onClick={onClose}>
          ×
        </button>
      </div>

      <p className="dirs-note">
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
    <section className={`dirs-section dirs-${kind}`}>
      <div className="dirs-section-head">
        <span className="dirs-label">{label}</span>
        <span className="dirs-hint">{hint}</span>
        <button className="ghost dirs-add" disabled={disabled} onClick={onAdd}>
          添加
        </button>
      </div>
      {items.length === 0 ? (
        <p className="dirs-empty">还没有</p>
      ) : (
        <ul className="dirs-list">
          {items.map((dir) => (
            <li key={dir} className="dirs-item">
              <span className="dirs-path" title={dir}>
                {dir}
              </span>
              <button
                className="dirs-remove"
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

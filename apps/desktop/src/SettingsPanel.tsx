import { useEffect, useState } from 'react';

import type { HostBridge, SettingsInput, SettingsState, TestResult } from './shared/ipc';

/**
 * 设置面板。
 *
 * 两种用途：
 *   - 首次启动（没 key）：全屏向导，不配好就用不了
 *   - 运行中修改：侧边抽屉
 *
 * 为什么 key 单独一段、还要显示存储方式：
 * 用户有权知道自己的密钥是加密存的还是明文落盘的。
 * 不告知就默默明文写文件，是最不该省的那一步。
 */
export function SettingsPanel({
  host,
  mode,
  onClose,
  onSaved,
  /** 保存成功后是否自动重启（运行中改配置需要它生效） */
  restartOnSave,
  /** 当前是否有对话在跑；有则重启前要确认 */
  busy,
}: {
  host: HostBridge;
  mode: 'onboarding' | 'drawer';
  onClose?: () => void;
  onSaved: () => void;
  restartOnSave?: boolean;
  busy?: boolean;
}) {
  const [state, setState] = useState<SettingsState | null>(null);
  const [form, setForm] = useState<SettingsInput>({});
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<TestResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** 保存成功但需要确认才能重启 */
  const [confirmRestart, setConfirmRestart] = useState(false);

  useEffect(() => {
    void host.readSettings().then((s) => {
      setState(s);
      setForm({
        model: s.model,
        endpoint: s.endpoint,
        api: s.api,
        contextWindow: s.contextWindow,
        models: s.models,
        efforts: s.efforts,
        approval: s.approval,
        workDir: s.workDir,
        // key 不回显：只让用户重新填
        apiKey: '',
      });
    });
  }, [host]);

  const set = <K extends keyof SettingsInput>(key: K, value: SettingsInput[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
    setTest(null);
    setError(null);
  };

  const doTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      setTest(await host.testSettings(form));
    } catch (e) {
      setTest({ ok: false, message: e instanceof Error ? e.message : String(e), elapsedMs: 0 });
    } finally {
      setTesting(false);
    }
  };

  const doSave = async () => {
    setSaving(true);
    setError(null);
    try {
      // 空 key 不写入：空字符串等于「没设置」，会覆盖掉已有的
      const payload: SettingsInput = { ...form };
      if (!payload.apiKey?.trim()) delete payload.apiKey;
      await host.saveSettings(payload);
      onSaved();

      // 配置只在启动时读。
      // 空闲时直接重启；正在跑对话时先问一声 —— 重启会把那一轮打断，
      // 用户可能正等着结果，不能默默弄没。
      if (restartOnSave) {
        if (busy) setConfirmRestart(true);
        else await host.restartApp();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const isOnboarding = mode === 'onboarding';
  const canSave = Boolean(form.apiKey?.trim()) || state?.hasKey;

  return (
    <div className={isOnboarding ? 'settings-overlay' : 'settings-drawer'}>
      <div className="settings-head">
        <div>
          <h2 className="settings-title">{isOnboarding ? '先配置一下' : '设置'}</h2>
          {isOnboarding && (
            <p className="settings-sub">
              填一个模型接口就能开始用。这些只存在你自己的电脑上。
            </p>
          )}
        </div>
        {!isOnboarding && onClose && (
          <button className="ghost settings-close" title="关闭" onClick={onClose}>
            ×
          </button>
        )}
      </div>

      <div className="settings-body">
        <section className="settings-section">
          <div className="settings-section-head">
            <span className="settings-label">API Key</span>
            {state && (
              <span className={`settings-badge ${state.keySource === 'none' ? 'warn' : 'ok'}`}>
                {state.keySource === 'env'
                  ? '来自环境变量'
                  : state.keySource === 'file'
                    ? state.keyEncrypted
                      ? '已加密保存'
                      : '明文保存'
                    : '未配置'}
              </span>
            )}
          </div>
          <input
            className="settings-input"
            type="password"
            autoComplete="off"
            placeholder={state?.hasKey ? '已保存，留空则不修改' : 'sk-...'}
            value={form.apiKey ?? ''}
            onChange={(e) => set('apiKey', e.target.value)}
          />
          {state && !state.encryptionAvailable && (
            <p className="settings-hint warn">
              这台电脑的系统密钥库不可用，key 会以明文写入配置文件。
            </p>
          )}
          {state && state.keySource === 'env' && (
            <p className="settings-hint">
              当前 key 来自环境变量 <code>APP_PI_API_KEY</code>，改这里不会覆盖它。
            </p>
          )}
        </section>

        <section className="settings-section">
          <label className="settings-label">接口地址</label>
          <input
            className="settings-input"
            placeholder="https://api.example.com/v1"
            value={form.endpoint ?? ''}
            onChange={(e) => set('endpoint', e.target.value)}
          />
          <label className="settings-label">协议</label>
          <select
            className="settings-input"
            value={form.api ?? 'openai-completions'}
            onChange={(e) => set('api', e.target.value)}
          >
            <option value="openai-completions">openai-completions</option>
            <option value="anthropic-messages">anthropic-messages</option>
            <option value="openai-responses">openai-responses</option>
            <option value="google-generative-ai">google-generative-ai</option>
          </select>
        </section>

        <section className="settings-section">
          <label className="settings-label">模型</label>
          <input
            className="settings-input"
            placeholder="deepseek-v4.1-flash-1017"
            value={form.model ?? ''}
            onChange={(e) => set('model', e.target.value)}
          />
          <label className="settings-label">上下文窗口（tokens）</label>
          <input
            className="settings-input"
            type="number"
            placeholder="200000"
            value={form.contextWindow ?? ''}
            onChange={(e) => set('contextWindow', Number(e.target.value) || undefined)}
          />
        </section>

        <details className="settings-advanced">
          <summary>高级</summary>
          <label className="settings-label">多模型（JSON 数组）</label>
          <textarea
            className="settings-input settings-textarea"
            rows={3}
            placeholder='[{"id":"m1","label":"模型一"},{"id":"m2","label":"模型二"}]'
            value={form.models ?? ''}
            onChange={(e) => set('models', e.target.value)}
          />
          <label className="settings-label">思考档位（逗号分隔）</label>
          <input
            className="settings-input"
            placeholder="minimal,low,medium,high,xhigh,max"
            value={form.efforts ?? ''}
            onChange={(e) => set('efforts', e.target.value)}
          />
          <label className="settings-label">审批策略</label>
          <select
            className="settings-input"
            value={form.approval ?? 'ipc'}
            onChange={(e) => set('approval', e.target.value as 'ipc' | 'allow')}
          >
            <option value="ipc">每次询问（推荐）</option>
            <option value="allow">全部放行（危险）</option>
          </select>
          {state && (
            <p className="settings-hint">
              配置文件：<code>{state.settingsPath}</code>
            </p>
          )}
        </details>

        {test && (
          <p className={`settings-test ${test.ok ? 'ok' : 'err'}`}>
            {test.ok ? '✓ ' : '✗ '}
            {test.message}
            <span className="settings-test-time"> · {test.elapsedMs}ms</span>
          </p>
        )}
        {error && <p className="settings-test err">✗ {error}</p>}
      </div>

      {confirmRestart && (
        <div className="settings-confirm">
          <div className="settings-confirm-box">
            <p className="settings-confirm-title">配置已保存</p>
            <p className="settings-confirm-body">
              现在有一轮对话在跑。重启才能让新配置生效，但重启会中断这一轮。
            </p>
            <div className="settings-confirm-actions">
              <button className="btn ghost" onClick={() => setConfirmRestart(false)}>
                稍后重启
              </button>
              <button className="btn primary" onClick={() => void host.restartApp()}>
                立即重启
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="settings-actions">
        <button className="btn ghost" onClick={() => void doTest()} disabled={testing || saving}>
          {testing ? '测试中…' : '测试连接'}
        </button>
        <button className="btn primary" onClick={() => void doSave()} disabled={!canSave || saving}>
          {saving ? '保存中…' : isOnboarding ? '保存并开始' : '保存'}
        </button>
      </div>
    </div>
  );
}

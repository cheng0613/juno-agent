/**
 * 浏览器里直接打开时的假宿主。
 *
 * 存在的理由：没有 Electron 也要能看 UI、改样式。
 * 走 vite dev 或在普通浏览器打开 dist/index.html 时自动启用，
 * 有 window.host 时永远走真实 IPC。
 */
import type { HostBridge, HostEvent, UiMessage } from './shared/ipc';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const messages: UiMessage[] = [];

export function createMockHost(): HostBridge {
  const listeners = new Set<(e: HostEvent) => void>();
  const emit = (e: HostEvent) => listeners.forEach((l) => l(e));

  const seed = (): UiMessage[] => [
    { id: 'm1', role: 'user', text: '帮我看下 workspace 里有什么文件' },
    { id: 'm2', role: 'tool_use', toolName: 'bash', toolUseId: 't1', input: { command: 'ls -la' } },
    {
      id: 'm3',
      role: 'tool_result',
      toolUseId: 't1',
      output: 'total 8\ndrwxr-xr-x  .\ndrwxr-xr-x  ..\n-rw-r--r--  hello.txt',
    },
    {
      id: 'm4',
      role: 'assistant',
      text: '目录里只有一个 `hello.txt`，内容是之前写入的 `hi from spike`。',
    },
  ];

  return {
    async bootstrap() {
      return {
        sessions: [
          { id: 's1', title: '查看 workspace', model: 'deepseek-v4.1', status: 'active', updatedAt: Date.now() },
          { id: 's2', title: '重构数据层', model: 'deepseek-v4.1', status: 'active', updatedAt: Date.now() - 8.64e7 },
        ],
        activeSessionId: 's1',
        messages: seed(),
        // 模拟一条中断轮，浏览器里也能预览横幅样式
        interruptedTurns: [
          {
            turnId: 'turn-mock-interrupted',
            sessionId: 's1',
            sessionTitle: '重构登录流程',
            startedAt: Date.now() - 600_000,
            userText: '把 auth 模块拆成三个文件，并补上单测',
            hasOutput: true,
          },
        ],
        model: 'deepseek-v4.1-flash-1017 · mock',
      };
    },
    async createSession() {
      return {
        sessions: [
          { id: 's3', title: '新会话', model: 'deepseek-v4.1', status: 'active', updatedAt: Date.now() },
        ],
        activeSessionId: 's3',
        messages: [],
        interruptedTurns: [],
        model: 'mock',
      };
    },
    async loadSession() {
      return seed();
    },
    async send({ text }) {
      messages.push({ id: `u-${Date.now()}`, role: 'user', text });
      const turnId = `turn-${Date.now()}`;
      emit({ type: 'turn', turnId, state: 'running' });

      await sleep(400);
      emit({ type: 'tool_use', turnId, toolUseId: 't2', toolName: 'bash', input: { command: 'cat hello.txt' } });
      await sleep(500);

      // 演示审批卡：真实环境由主进程按需抛过来
      emit({
        type: 'approval',
        request: {
          requestId: 'req-1',
          kind: 'permission',
          toolName: 'bash',
          input: { command: 'rm -rf build' },
          summary: 'bash',
        },
      });
    },
    async approve({ requestId }) {
      emit({ type: 'approval_settled', requestId });
      const turnId = 'turn-mock';
      emit({ type: 'tool_result', turnId, toolUseId: 't2', output: 'hi from spike', isError: false });
      for (const chunk of ['文件内容是 ', '`hi from spike`', '，一切正常。']) {
        await sleep(180);
        emit({ type: 'text', turnId, text: chunk, isFinal: false });
      }
      emit({ type: 'turn', turnId, state: 'done' });
    },
    async cancel() {},
    async resumeTurn() {},
    async dismissTurn() {},
    // 预览模式下压缩没有真实引擎，返回 noop，UI 会提示「上下文还很小」
    async compact() {
      return { noop: true };
    },
    // 预览模式没有真引擎，用一组固定值让占用条能画出样子
    async contextUsage() {
      return { totalTokens: 24_800, maxTokens: 128_000, percentage: 19.4 };
    },
    async steer(_sessionId, text) {
      const listener = [...listeners].at(-1);
      listener?.({ type: 'steer', turnId: 'mock', text });
    },
    async setPermissionMode(_sessionId, mode) {
      const listener = [...listeners].at(-1);
      listener?.({
        type: 'modes',
        permissionMode: mode,
        planMode: false,
        effort: 'medium',
        effortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      });
    },
    async setPlanMode(_sessionId, enabled) {
      const listener = [...listeners].at(-1);
      listener?.({
        type: 'modes',
        permissionMode: 'ask',
        planMode: enabled,
        effort: 'medium',
        effortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      });
    },
    async setEffort(_sessionId, effort) {
      const listener = [...listeners].at(-1);
      listener?.({
        type: 'modes',
        permissionMode: 'ask',
        planMode: false,
        effort,
        effortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      });
    },
    async readModes() {
      return {
        permissionMode: 'ask' as const,
        planMode: false,
        effort: 'medium',
        effortLevels: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
      };
    },
    async listModels() {
      return {
        models: [
          { id: 'deepseek-v4.1-flash-1017', label: 'DeepSeek' },
          { id: 'gpt-4o', label: 'GPT-4o' },
        ],
        current: 'deepseek-v4.1-flash-1017',
      };
    },
    async exportHtml() {
      return 'C:\\Users\\you\\Documents\\Agent 导出\\会话.html';
    },
    async listTasks() {
      return [];
    },
    async stopTask() {},
    async readExtraDirs() {
      return { read: [], write: [] };
    },
    async setExtraDirs() {},
    async pickDir() {
      return 'C:\\Users\\you\\Documents\\some-project';
    },
    async sessionTree() {
      return [
        {
          id: 'n1',
          kind: 'message',
          role: 'user',
          preview: '第一句提问',
          active: true,
          children: [
            {
              id: 'n2',
              kind: 'message',
              role: 'assistant',
              preview: '第一句回答',
              active: true,
              children: [],
            },
          ],
        },
      ];
    },
    async navigateTree() {
      return {
        draftText: '第一句提问',
        activeCount: 1,
        messages: [{ id: 'm1', role: 'user' as const, text: '第一句提问' }],
      };
    },
    async switchModel(_sessionId, modelId) {
      const listener = [...listeners].at(-1);
      listener?.({ type: 'model', modelId });
      return { rebuilt: false };
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

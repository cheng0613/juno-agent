/**
 * Phase 2 数据层 · Schema 与迁移
 *
 * 设计原则（都是从上游踩坑经验里借来的）：
 *
 * 1. `messages.client_id` + 唯一索引(session_id, client_id)
 *    → 消息写入天然幂等。这是「同一份内容被重复提交不会写两行」的唯一保障，
 *      也是将来做多端同步的前提。上游 agentInputQueue / 断线重连都靠它。
 *
 * 2. `messages.rewind_at` 软删除，绝不物理删
 *    → Fork / Rewind 需要保留审计与 wire 重放能力。读取一律 `IS NULL` 过滤，
 *      索引也要为这个过滤路径建。
 *
 * 3. 运行态**不写进 sessions.status**
 *    → 上游明确踩过这个坑：运行态是内存瞬态（activeSessions），
 *      持久态 status 只有 active/archived/deleted。混用会把正在跑的任务误标归档。
 *      运行态单独放 turns 表。
 *
 * 4. `turns` 表是中断恢复的骨架
 *    → 每轮一个 row，state=running 的行 = 可能被中断的轮。
 *      进程重启后据此判断「要不要续跑」，而不是靠猜。
 *
 * 5. `agent_meta` 每行 denormalize `agent_kind`
 *    → 切换引擎后，历史消息必须按写入时的引擎解析，不能用会话当前引擎。
 *
 * 迁移用内联 SQL 数组（不用外部 .sql 文件），这样打包成单文件后依然可迁移。
 */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
      ------------------------------------------------------------------
      -- 1. sessions —— 任务本体（持久态，不含运行态）
      ------------------------------------------------------------------
      CREATE TABLE sessions (
        id                        TEXT PRIMARY KEY,
        title                     TEXT NOT NULL DEFAULT 'New Task',

        -- 工作目录与产品语义解耦：project = 参与项目分组，dialogue = 对话自带目录
        working_dir               TEXT NOT NULL,
        workspace_kind            TEXT NOT NULL DEFAULT 'project',

        -- 引擎选择
        agent_kind                TEXT NOT NULL,
        model                     TEXT NOT NULL,
        effort                    TEXT NOT NULL DEFAULT 'high',
        permission_mode           TEXT NOT NULL DEFAULT 'ask',
        -- 'off' | 'fast' | 'ultrafast'
        fast_mode                 TEXT NOT NULL DEFAULT 'off',
        plan_mode                 INTEGER NOT NULL DEFAULT 0,
        review_mode               INTEGER NOT NULL DEFAULT 0,

        -- 引擎侧 resume 句柄（pi 的 session jsonl 路径 / cc 的 sdk session id）
        sdk_session_id            TEXT,

        -- 持久态生命周期，绝不承载运行态
        status                    TEXT NOT NULL DEFAULT 'active',

        -- fork 溯源
        parent_session_id         TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        forked_at_message_id      TEXT,

        -- 展示用累计值（可由 usage_events 重算，这里是读优化）
        total_tokens              INTEGER NOT NULL DEFAULT 0,
        total_cost_amount         REAL NOT NULL DEFAULT 0,
        total_cost_currency       TEXT,
        context_tokens            INTEGER NOT NULL DEFAULT 0,
        context_window            INTEGER NOT NULL DEFAULT 0,

        -- 排序：user_send_at 保留「真人按下发送」语义，last_activity_at 用于列表排序
        user_send_at              INTEGER,
        last_activity_at          INTEGER,

        created_at                INTEGER NOT NULL,
        updated_at                INTEGER NOT NULL
      );

      CREATE INDEX idx_sessions_status_activity ON sessions(status, last_activity_at DESC);
      CREATE INDEX idx_sessions_parent ON sessions(parent_session_id);

      ------------------------------------------------------------------
      -- 2. messages —— 消息（content 存 JSON，与上游同构）
      ------------------------------------------------------------------
      CREATE TABLE messages (
        id            TEXT PRIMARY KEY,
        -- 调用方生成的幂等键
        client_id     TEXT NOT NULL,
        session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        -- 归属哪一轮；NULL = 不属于任何 turn（例如系统提示行）
        turn_id       TEXT,

        role          TEXT NOT NULL,
        -- JSON 字符串
        content       TEXT NOT NULL,
        -- 引擎私有元信息 JSON：{ uuid, parentUuid, usage, stopReason, ... }
        agent_meta    TEXT,
        -- 逐行 denormalize 的引擎标识，历史行不受引擎切换影响
        agent_kind    TEXT,

        tool_use_id   TEXT,
        -- 软删时间戳（unix ms）；读取一律 IS NULL
        rewind_at     INTEGER,
        created_at    INTEGER NOT NULL
      );

      -- 幂等写入 + 将来多端去重的唯一依据
      CREATE UNIQUE INDEX uniq_messages_session_client ON messages(session_id, client_id);
      CREATE INDEX idx_messages_session_created ON messages(session_id, created_at);
      CREATE INDEX idx_messages_rewind ON messages(rewind_at);

      ------------------------------------------------------------------
      -- 3. turns —— 每轮执行记录，中断恢复的骨架
      ------------------------------------------------------------------
      CREATE TABLE turns (
        id              TEXT PRIMARY KEY,
        session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        -- running | done | error | interrupted | cancelled
        state           TEXT NOT NULL,
        attempt         INTEGER NOT NULL DEFAULT 1,
        -- 触发本轮的 user message client_id：
        -- 续跑时「有产出 → 发续跑指令；零产出 → 重发原文」要用它找回原文
        user_client_id  TEXT,
        started_at      INTEGER NOT NULL,
        ended_at        INTEGER,
        error           TEXT,
        error_terminal  INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX idx_turns_session ON turns(session_id, started_at DESC);
      -- 只索引 running 行：启动期找「可能被中断的轮」是热路径
      CREATE INDEX idx_turns_running ON turns(state) WHERE state = 'running';

      ------------------------------------------------------------------
      -- 4. usage_events —— 逐轮用量与成本
      ------------------------------------------------------------------
      CREATE TABLE usage_events (
        id                 INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        turn_id            TEXT,
        model              TEXT NOT NULL,
        input_tokens       INTEGER NOT NULL DEFAULT 0,
        output_tokens      INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_amount        REAL NOT NULL DEFAULT 0,
        cost_currency      TEXT,
        created_at         INTEGER NOT NULL
      );

      CREATE INDEX idx_usage_session ON usage_events(session_id, created_at);
      CREATE INDEX idx_usage_created ON usage_events(created_at);

      ------------------------------------------------------------------
      -- 5. attachments —— 附件与媒体引用（不存 blob，只存路径 + 摘要）
      ------------------------------------------------------------------
      CREATE TABLE attachments (
        id            TEXT PRIMARY KEY,
        message_id    TEXT REFERENCES messages(id) ON DELETE CASCADE,
        kind          TEXT NOT NULL,   -- image | file | audio | video
        mime          TEXT,
        name          TEXT,
        bytes         INTEGER,
        -- 相对 app data 根目录的路径，避免绝对路径随机器漂移
        storage_path  TEXT,
        sha256        TEXT,
        created_at    INTEGER NOT NULL
      );

      CREATE INDEX idx_attachments_message ON attachments(message_id);
      CREATE INDEX idx_attachments_sha ON attachments(sha256);
    `,
  },
  {
    version: 2,
    name: 'turn-resolution',
    // 中断的轮被用户「继续」或「忽略」后打上 resolved_at。
    // 没有这一列的话，同一条「上次有任务被中断」的提示会每次启动都再弹一遍。
    sql: `
      ALTER TABLE turns ADD COLUMN resolved_at INTEGER;
    `,
  },
  {
    version: 3,
    name: 'permission-rules',
    // 记忆型白名单：让「每次 git 都问一遍」变成一次点击。
    // subject 由宿主侧从工具入参提取（bash 取命令首词、文件类取路径前缀）。
    sql: `
      CREATE TABLE permission_rules (
        id          TEXT PRIMARY KEY,
        tool_name   TEXT NOT NULL,
        subject     TEXT,
        behavior    TEXT NOT NULL,
        scope       TEXT NOT NULL,
        session_id  TEXT,
        created_at  INTEGER NOT NULL
      );

      CREATE INDEX idx_rules_lookup ON permission_rules(tool_name, subject);
    `,
  },
  {
    version: 4,
    name: 'extra-dirs',
    // 额外工作目录：read 只读、write 可写，两者权限层级不同，分开存。
    // 存 JSON 数组而不是建关联表：数量很少，也不需要单独查询。
    sql: `
      ALTER TABLE sessions ADD COLUMN extra_read_dirs TEXT NOT NULL DEFAULT '[]';
      ALTER TABLE sessions ADD COLUMN extra_write_dirs TEXT NOT NULL DEFAULT '[]';
    `,
  },
  {
    version: 5,
    name: 'turn-savepoint',
    // 每轮开始前的工作区快照 commit。回退时用它把文件恢复到那一刻。
    // 存在 turns 表上而不是单独建表：一顿一快照，天然 1:1。
    sql: `
      ALTER TABLE turns ADD COLUMN savepoint_commit TEXT;
    `,
  },
  {
    version: 6,
    name: 'session-organize',
    // 会话整理：置顶 + 归档。
    // 归档而不是硬删：用户删错一个会话就永久失去所有对话，太重。
    // 默认列表只显示未归档的，归档的在另一处可找回。
    sql: `
      ALTER TABLE sessions ADD COLUMN pinned_at INTEGER;
      ALTER TABLE sessions ADD COLUMN archived_at INTEGER;
    `,
  },
  {
    version: 7,
    name: 'orca-teams',
    // ORCA（多 agent 协作）：一个 Lead 会话带多个 Worker 会话。
    //
    // 设计对齐上游 Cindy：
    //   - Worker 不是子 agent，是**独立会话**（有自己的上下文和对话）
    //   - 一个 Lead 同时只能有一个 active team
    //   - sessions.orca_role 冗余存储：侧栏查列表时不能 join 三张表
    sql: `
      CREATE TABLE orca_teams (
        id                TEXT PRIMARY KEY,
        lead_session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        status            TEXT NOT NULL DEFAULT 'active',
        created_at        INTEGER NOT NULL,
        completed_at      INTEGER
      );

      -- 一个 Lead 同时只能有一个 active team
      CREATE UNIQUE INDEX uniq_orca_active_team
        ON orca_teams(lead_session_id) WHERE status = 'active';

      CREATE TABLE orca_workers (
        id           TEXT PRIMARY KEY,
        team_id      TEXT NOT NULL REFERENCES orca_teams(id) ON DELETE CASCADE,
        session_id   TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role         TEXT NOT NULL DEFAULT 'developer',
        label        TEXT,
        status       TEXT NOT NULL DEFAULT 'idle',
        focused      INTEGER NOT NULL DEFAULT 0,
        idle_since   INTEGER,
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );

      -- 一个会话最多属于一个 worker
      CREATE UNIQUE INDEX uniq_orca_worker_session ON orca_workers(session_id);
      -- 同 team 内 label 不重复（大小写不敏感）
      CREATE UNIQUE INDEX uniq_orca_worker_label
        ON orca_workers(team_id, lower(label));

      ALTER TABLE sessions ADD COLUMN orca_role TEXT;
      CREATE INDEX idx_sessions_orca_role ON sessions(orca_role);
    `,
  },
  {
    version: 8,
    name: 'orca-worker-worktree',
    // worker 的工作区隔离状态要落库：
    //   working_dir：worker 实际在哪干活（worktree 路径或共享的主目录）
    //   isolated：是否真的隔离。false 表示共享目录、有并发覆盖风险，
    //             UI 要据此提示用户，不能让它静默
    sql: `
      ALTER TABLE orca_workers ADD COLUMN working_dir TEXT;
      ALTER TABLE orca_workers ADD COLUMN isolated INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE orca_workers ADD COLUMN isolation_reason TEXT;
    `,
  },
];

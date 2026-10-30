/**
 * 工作区快照（git savepoint）。
 *
 * 存在的理由：回退对话时，磁盘上的文件改动不会自动退回。
 * 用户点「从这里重来」后，模型手里是旧对话、文件却是新版本 —— 这种不一致
 * 比不支持回退更糟，因为用户会以为什么都退回去了。
 *
 * 做法：每轮开始前用 git 拍一张工作区快照，存到隐藏 ref。
 * 回退时把工作区恢复到对应那轮的快照。
 *
 * 三个关键约束：
 *   1. **不碰用户的 HEAD / 分支 / 暂存区**：全部用临时 index + plumbing 命令
 *   2. **不跑 git hook**：hook 可能有副作用（lint、格式化），快照不该触发它们
 *   3. **不是 git 仓库就跳过**：不为了这个功能去初始化用户的目录
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const exec = promisify(execFile);

/** git 调用超时；卡住的 git 不该拖住宿主 */
const GIT_TIMEOUT_MS = 15_000;
/** 快照 ref 前缀，与用户的分支完全隔离 */
const REF_PREFIX = 'refs/juno/savepoints';

export interface SavepointResult {
  /** 快照 commit；null 表示当前目录不支持（非 git / 有冲突等） */
  commit: string | null;
  /** 不支持时的原因，用于告诉用户「文件回滚不可用」而不是静默跳过 */
  reason?: string;
}

/**
 * 拍一张快照。
 *
 * 用 `--no-optional-locks` 避免和用户正在跑的 git 命令抢 index.lock。
 * 临时 index 放在系统临时目录，用完即删 —— 放仓库里会出现在 status 里。
 */
export async function createSavepoint(cwd: string, sessionId: string): Promise<SavepointResult> {
  const repo = await findRepoRoot(cwd);
  if (!repo) return { commit: null, reason: 'not-a-git-repo' };

  // 有未解决的冲突时拍快照会把冲突标记也存进去，恢复时更难收拾。
  // 这种情况直接放弃，宁可没有文件回滚，也不要把仓库搞得更乱。
  const unmerged = await git(repo, ['ls-files', '--unmerged']).catch(() => null);
  if (unmerged && unmerged.trim().length > 0) {
    return { commit: null, reason: 'unmerged-changes' };
  }

  const tmpIndex = path.join(os.tmpdir(), `juno-idx-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: tmpIndex };

  try {
    // 从 HEAD 起步，再把它上面的工作区状态加进来。
    // 没有 HEAD（空仓库）时 read-tree 会失败，用 empty tree 兜底。
    const head = await git(repo, ['rev-parse', 'HEAD']).catch(() => null);
    if (head) {
      await git(repo, ['read-tree', 'HEAD'], env);
    } else {
      // 4b825dc642cb6eb9a060e54bf8d69288fbee4904 = git 的空树
      await git(repo, ['read-tree', '4b825dc642cb6eb9a060e54bf8d69288fbee4904'], env);
    }

    // -A：新增/修改/删除都记录。
    await git(repo, ['add', '-A'], env);
    const tree = (await git(repo, ['write-tree'], env)).trim();

    const parent = head ? ['-p', head.trim()] : [];
    const commit = (
      await git(
        repo,
        [
          '-c', 'user.name=juno',
          '-c', 'user.email=savepoint@juno.local',
          '-c', 'commit.gpgsign=false',
          'commit-tree', tree,
          ...parent,
          '-m', `savepoint ${sessionId} ${new Date().toISOString()}`,
        ],
        env,
      )
    ).trim();

    await git(repo, ['update-ref', `${REF_PREFIX}/${sessionId}/${commit}`, commit]);
    return { commit };
  } catch (error) {
    return {
      commit: null,
      reason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await fs.unlink(tmpIndex).catch(() => undefined);
    // 临时 index 还会产生 lock 文件
    await fs.unlink(`${tmpIndex}.lock`).catch(() => undefined);
  }
}

/**
 * 把工作区恢复到某个快照。
 *
 * 只动被快照记录过的文件：用 `read-tree -u --reset` 让它把工作区推到那个 tree。
 * 这里**有意不删**快照之后新建、但快照里没有的文件 ——
 * 它们可能是用户自己建的，静默删掉风险太大。
 */
export async function restoreSavepoint(
  cwd: string,
  commit: string,
): Promise<{ ok: boolean; reason?: string }> {
  const repo = await findRepoRoot(cwd);
  if (!repo) return { ok: false, reason: 'not-a-git-repo' };

  const tmpIndex = path.join(os.tmpdir(), `juno-idx-${randomUUID()}`);
  const env = { GIT_INDEX_FILE: tmpIndex };
  try {
    await git(repo, ['read-tree', commit], env);
    // --reset 强制工作区与 index 一致；不加的话 git 会拒绝覆盖「本地已修改」
    await git(repo, ['checkout-index', '-a', '-f'], env);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  } finally {
    await fs.unlink(tmpIndex).catch(() => undefined);
    await fs.unlink(`${tmpIndex}.lock`).catch(() => undefined);
  }
}

/** 列出某会话的所有快照（从旧到新） */
export async function listSavepoints(cwd: string, sessionId: string): Promise<string[]> {
  const repo = await findRepoRoot(cwd);
  if (!repo) return [];
  const out = await git(repo, [
    'for-each-ref',
    `--format=%(refname)`,
    `${REF_PREFIX}/${sessionId}/`,
  ]).catch(() => '');
  return out
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((ref) => ref.slice(ref.lastIndexOf('/') + 1));
}

async function findRepoRoot(cwd: string): Promise<string | null> {
  try {
    const out = await exec('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return out.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function git(
  cwd: string,
  args: string[],
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      ...extraEnv,
      // 快照不该触发用户的 hook，也不该去拉网络资源
      GIT_OPTIONAL_LOCKS: '0',
    },
  });
  return stdout;
}

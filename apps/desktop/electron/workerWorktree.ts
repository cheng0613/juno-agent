/**
 * ORCA worker 的工作区隔离（git worktree）。
 *
 * 为什么需要：
 *   多个 worker 同时改同一个文件会**静默覆盖** ——
 *   A 读 → B 写 → A 写，B 的改动就没了，没有人会报错。
 *   pi 进程之间互相不知道对方存在，宿主也没有文件锁。
 *
 *   这和权限档位是两回事：bypassPermissions 去掉了「问一下」这道闸，
 *   worktree 提供的是「坏了能还原」这道保险。两码事，都得有。
 *
 * 做法：每个 worker 一个独立 worktree
 *   项目/.juno/worktrees/<label>/   ← worker 在这干活
 *   项目/                            ← Lead 和用户在这
 *
 * 约束：
 *   1. **不是 git 仓库就降级**：直接用主目录，但明确告诉调用方，让 UI 能提示风险
 *   2. **worktree 建失败也降级**：宁可让 worker 干活（有覆盖风险），
 *      也不要因为 git 出问题就完全不能用
 *   3. **不自动创建分支**：每个 worktree 用 detached HEAD，避免污染用户的分支列表。
 *      要合并时由 merger 角色或用户手动处理。
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;
/** worktree 存放位置，相对仓库根 */
const WORKTREE_DIR = '.juno/worktrees';

export interface WorktreeResult {
  /** worker 实际使用的工作目录 */
  workingDir: string;
  /** 是否真的隔离了（false 表示降级到主目录，有并发覆盖风险） */
  isolated: boolean;
  /** 降级原因，用于向用户解释 */
  reason?: string;
  /** 仓库根；非 git 仓库时为 null */
  repoRoot: string | null;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

async function findRepoRoot(cwd: string): Promise<string | null> {
  try {
    const root = (await git(cwd, ['rev-parse', '--show-toplevel'])) || null;
    if (!root) return null;

    /*
     * 光看 rev-parse 不够：它会向上查找父仓库。
     * 比如 cwd = repo/.appdata/plain（不是它自己的仓库，但嵌在 repo 里），
     * rev-parse 会返回 repo —— 于是「不支持的目录」被当成可以隔离，
     * 建出来的 worktree 跑到 repo/.juno/worktrees 下面，与预期不符。
     *
     * 所以要求 cwd 就在仓库里、且不能被忽略：
     *   git check-ignore --quiet <cwd> 成功就说明它是个被忽略的子目录
     */
    const rel = path.relative(root, path.resolve(cwd));
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;

    // 被 .gitignore 忽略的子目录（如 .appdata、node_modules）不当作独立仓库根
    if (rel) {
      try {
        await git(root, ['check-ignore', '--quiet', rel]);
        return null;
      } catch {
        /* 没被忽略，正常 */
      }
    }
    return root;
  } catch {
    return null;
  }
}

/** label 变目录名：只保留安全字符，避免路径穿越和 Windows 保留名 */
function safeDirName(label: string): string {
  const cleaned = label
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '-')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || 'worker';
}

/**
 * 给 worker 准备一个隔离工作区。
 *
 * @param baseDir   Lead 的工作目录
 * @param label     worker 名字，用作目录名
 */
export async function prepareWorkerWorktree(baseDir: string, label: string): Promise<WorktreeResult> {
  const repoRoot = await findRepoRoot(baseDir);
  if (!repoRoot) {
    // 非 git 仓库：没法隔离。降级但要说清楚，UI 会据此提示用户
    return {
      workingDir: baseDir,
      isolated: false,
      reason: 'not-a-git-repo',
      repoRoot: null,
    };
  }

  const target = path.join(repoRoot, WORKTREE_DIR, safeDirName(label));

  /*
   * 把 .juno/ 加进仓库的忽略规则。
   *
   * 不做的话：worktree 目录会变成未跟踪文件，
   * **Lead 的「本轮改动」面板里会多出好几行 `.juno/worktrees/developer`** ——
   * 那是 worker 的工作区，不是用户改的东西。
   *
   * 用 info/exclude 而不是改用户的 .gitignore：
   * 后者是用户要提交的文件，偷偷改它不合适。
   */
  await ensureWorktreeIgnored(repoRoot);

  try {
    // 目录已存在（同名 worker 之前建过又没清理）：先移除再重建，
    // 保证 worker 拿到的是干净的当前代码，而不是上次的残留
    if (await exists(target)) {
      await removeWorktree(repoRoot, target);
    }

    await fs.mkdir(path.dirname(target), { recursive: true });

    // detached HEAD：不创建分支，不污染 git branch 列表。
    // 用户想看 worker 干了什么，直接进 .juno/worktrees/<label> 即可。
    await git(repoRoot, ['worktree', 'add', '--detach', target, 'HEAD']);

    return { workingDir: target, isolated: true, repoRoot };
  } catch (error) {
    // worktree 建不出来（比如 HEAD 还不存在、仓库是空的）：
    // 降级到主目录。宁可让 worker 干活，也不要因为 git 出问题就完全不能用。
    return {
      workingDir: baseDir,
      isolated: false,
      reason: error instanceof Error ? error.message : String(error),
      repoRoot,
    };
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function removeWorktree(repoRoot: string, target: string): Promise<void> {
  // git worktree remove 会拒绝有改动的工作区（这是对的，别丢数据），
  // 所以先试 force —— 这里是「重建前清理」，残留数据本来就该丢
  try {
    await git(repoRoot, ['worktree', 'remove', '--force', target]);
  } catch {
    // git 不认这个目录（比如上次崩了没登记），直接删文件
    await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
  }
  // 清理 git 的管理记录，避免 worktree list 里留下幽灵条目
  await git(repoRoot, ['worktree', 'prune']).catch(() => undefined);
}

/**
 * 删除 worker 的 worktree。
 *
 * 只在 worker 被移除时调用。**不删用户主目录的任何东西。**
 */
export async function removeWorkerWorktree(baseDir: string, label: string): Promise<void> {
  const repoRoot = await findRepoRoot(baseDir);
  if (!repoRoot) return;
  const target = path.join(repoRoot, WORKTREE_DIR, safeDirName(label));
  if (!(await exists(target))) return;
  await removeWorktree(repoRoot, target);
}

/**
 * 列出一个仓库下所有 worker worktree，给 UI 展示用。
 */
export async function listWorkerWorktrees(baseDir: string): Promise<string[]> {
  const repoRoot = await findRepoRoot(baseDir);
  if (!repoRoot) return [];
  const root = path.join(repoRoot, WORKTREE_DIR);
  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    return entries.filter((e) => e.isDirectory()).map((e) => path.join(root, e.name));
  } catch {
    return [];
  }
}

/**
 * 确保仓库忽略 `.juno/`。
 *
 * 写进 `.git/info/exclude` 而不是 `.gitignore`：
 * 后者是用户要提交到仓库的文件，我们偷偷改它会让用户的 diff 里
 * 多出莫名其妙的改动。`info/exclude` 是本地私有的，正合适。
 *
 * 幂等：已经有这条规则就不重复写。
 */
async function ensureWorktreeIgnored(repoRoot: string): Promise<void> {
  try {
    const gitDir = await git(repoRoot, ['rev-parse', '--git-common-dir']);
    const excludePath = path.join(
      path.isAbsolute(gitDir) ? gitDir : path.join(repoRoot, gitDir),
      'info',
      'exclude',
    );
    await fs.mkdir(path.dirname(excludePath), { recursive: true });

    const current = await fs.readFile(excludePath, 'utf8').catch(() => '');
    if (/^\s*\.juno\/?\s*$/m.test(current)) return;

    const prefix = current && !current.endsWith('\n') ? '\n' : '';
    await fs.appendFile(
      excludePath,
      `${prefix}# Juno/ORCA worker 工作区（不应计入改动）\n.juno/\n`,
      'utf8',
    );
  } catch {
    // 忽略失败：只是改动面板里多几行噪音，不影响隔离本身
  }
}

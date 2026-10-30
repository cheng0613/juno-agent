/**
 * 本轮改动了哪些文件。
 *
 * 为什么不用引擎的 turn_diff：pi 根本不发这个事件（只有 codex 发）。
 * 我们跑的是 pi，所以只能自己算。
 *
 * 为什么不拍全量快照：真实项目动辄上千文件、几百 MB，
 * 每轮前后各扫一遍会让对话明显卡顿。git 自己就维护着文件状态，问它最省。
 *
 * 非 git 目录：退化「本轮碰过哪些路径」，不做行级 diff ——
 * 宁可不显示，也不要为了凑一个 diff 去扫整个工作区。
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';

import path from 'node:path';

const exec = promisify(execFile);

/** 单个文件最多看这么多行 diff，超了就不是给人看的了 */
const MAX_DIFF_CHARS = 40_000;
/** git 命令超时；卡住的 git 不该拖住整个宿主 */
const GIT_TIMEOUT_MS = 8_000;

export interface FileChange {
  /** 相对工作目录的路径，git 用的就是这种形式 */
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'unknown';
  /** 新增行数 */
  insertions: number;
  /** 删除行数 */
  deletions: number;
}

export interface TurnDiff {
  /** 是否有 git 支撑；false 表示只拿到了「碰过的路径」 */
  tracked: boolean;
  changes: FileChange[];
  /** 合并后的 unified diff 文本，可能被截断 */
  diff: string;
  truncated: boolean;
}

/** 工作目录是不是 git 仓库（含子目录向上查找） */
export async function isGitRepo(cwd: string): Promise<boolean> {
  try {
    await exec('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 轮开始时记一个基准。
 *
 * 只记 git 仓库相对于工作目录的那个前缀（`--show-prefix`）。
 * 用户的工作目录可能是大仓库里的一个子目录，直接 `git diff` 会把
 * 仓库里其他人的改动也算进来 —— 那不是「这一轮」改的。
 */
export interface DiffBaseline {
  isGit: boolean;
  /** 工作目录在仓库里的相对前缀，例如 `packages/app/`；仓库根为空串 */
  prefix: string;
}

export async function createBaseline(cwd: string): Promise<DiffBaseline> {
  const git = await isGitRepo(cwd);
  if (!git) return { isGit: false, prefix: '' };
  try {
    const { stdout } = await exec('git', ['rev-parse', '--show-prefix'], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
    });
    return { isGit: true, prefix: stdout.trim() };
  } catch {
    return { isGit: true, prefix: '' };
  }
}

/**
 * 收口时算这一轮的改动。
 *
 * 只看 `--` 限定在本轮工作目录的那部分，理由同上。
 * `hintPath` 用于非 git 场景：把本轮 tool_use 碰过的路径原样报出来，
 * 让用户至少知道「动过什么」，而不是一片空白。
 */
export async function collectTurnDiff(
  cwd: string,
  baseline: DiffBaseline,
  hintPaths: readonly string[] = [],
): Promise<TurnDiff> {
  if (!baseline.isGit) {
    return fallbackDiff(cwd, hintPaths);
  }

  const scope = ['.'];
  try {
    // --numstat 给出每个文件的增删行数，比解析 unified diff 稳
    const numstat = await exec('git', ['diff', '--numstat', '--relative', 'HEAD', '--', ...scope], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    });
    const changes = parseNumstat(numstat.stdout);

    // 未跟踪的新文件不在 git diff 里，单独捞一次，并自己拼出可读的片段
    const untracked = await exec(
      'git',
      ['ls-files', '--others', '--exclude-standard', '--', ...scope],
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    );
    const newFiles: string[] = [];
    for (const line of untracked.stdout.split('\n')) {
      const file = line.trim();
      if (!file) continue;
      newFiles.push(file);
      const lines = await countLines(path.join(cwd, file)).catch(() => 0);
      changes.push({ path: file, status: 'added', insertions: lines, deletions: 0 });
    }

    if (changes.length === 0) {
      return { tracked: true, changes, diff: '', truncated: false };
    }

    const patch = await exec(
      'git',
      ['diff', '--relative', 'HEAD', '--', ...scope],
      { cwd, timeout: GIT_TIMEOUT_MS, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
    ).catch(() => ({ stdout: '' }));

    // 未跟踪的新文件得自己拼 —— 面板的展开体靠「diff --git」分节，
    // 缺了这段，新建文件点开就是空的
    const synthetic = await buildNewFilePatches(cwd, newFiles);
    const merged = [patch.stdout, synthetic].filter(Boolean).join('\n');

    const truncated = merged.length > MAX_DIFF_CHARS;
    return {
      tracked: true,
      changes,
      diff: truncated ? merged.slice(0, MAX_DIFF_CHARS) : merged,
      truncated,
    };
  } catch {
    // git 出问题不该让整轮报错：退回「碰过哪些路径」
    return fallbackDiff(cwd, hintPaths);
  }
}

function parseNumstat(stdout: string): FileChange[] {
  const changes: FileChange[] = [];
  for (const line of stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 3) continue;
    const [add, del, rawPath] = parts as [string, string, string];
    // 二进制文件 git 给的是 "-"
    const insertions = add === '-' ? 0 : Number(add) || 0;
    const deletions = del === '-' ? 0 : Number(del) || 0;
    const renamed = rawPath.includes('=>');
    changes.push({
      path: rawPath.replace(/\{([^}]*) => ([^}]*)\}/g, '$2').trim(),
      status: renamed ? 'renamed' : insertions > 0 && deletions === 0 ? 'added' : 'modified',
      insertions,
      deletions,
    });
  }
  return changes;
}

async function fallbackDiff(cwd: string, hintPaths: readonly string[]): Promise<TurnDiff> {
  const unique = [...new Set(hintPaths)];
  const changes: FileChange[] = [];
  for (const raw of unique) {
    const abs = path.isAbsolute(raw) ? raw : path.join(cwd, raw);
    try {
      const stat = await fs.stat(abs);
      if (!stat.isFile()) continue;
      changes.push({
        path: path.relative(cwd, abs).split(path.sep).join('/'),
        status: 'modified',
        insertions: 0,
        deletions: 0,
      });
    } catch {
      // 文件没了 → 这一轮删掉了它
      changes.push({
        path: path.relative(cwd, abs).split(path.sep).join('/'),
        status: 'deleted',
        insertions: 0,
        deletions: 0,
      });
    }
  }
  return { tracked: false, changes, diff: '', truncated: false };
}

async function countLines(file: string): Promise<number> {
  const text = await fs.readFile(file, 'utf8');
  return text.length === 0 ? 0 : text.split('\n').length;
}

/**
 * 给未跟踪的新文件拼一段 unified diff。
 *
 * 格式对齐 `git diff`，前端按 `diff --git a/x b/x` 分节才能认。
 */
async function buildNewFilePatches(cwd: string, files: readonly string[]): Promise<string> {
  const chunks: string[] = [];
  for (const file of files) {
    const text = await fs.readFile(path.join(cwd, file), 'utf8').catch(() => null);
    // 二进制或读不了的文件就跳过，不要为了凑格式去猜内容
    if (text === null) continue;
    const lines = text.split('\n');
    if (lines.at(-1) === '') lines.pop();
    chunks.push(
      [
        `diff --git a/${file} b/${file}`,
        'new file mode 100644',
        '--- /dev/null',
        `+++ b/${file}`,
        `@@ -0,0 +1,${lines.length} @@`,
        ...lines.map((line) => `+${line}`),
      ].join('\n'),
    );
  }
  return chunks.join('\n');
}

/**
 * 主题状态的持久化（主进程侧）。
 *
 * 为什么主题要在主进程存一份：
 *   Acrylic 的染色是**窗口级**的（backgroundMaterial + backgroundColor），
 *   建窗那一刻就要决定用深色还是浅色的 85% 染色。
 *   而主题原本只存在渲染进程的 localStorage 里 —— 主进程在建窗前读不到，
 *   只能退而求其次看系统主题。结果是：用户在应用里选了深色，
 *   下次启动的第一次渲染侧栏却是浅色染色，切一下主题才正常。
 *
 * 做法与 Cindy 一致：主进程维护一份主题快照，建窗前读盘；
 * 渲染进程每次切换主题都通过 IPC 回写。
 *
 * 仍然不值得做成 SQLite 表：一个字段、4KB 上限、不需要查询。
 */
import { app, nativeTheme } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface ThemeSnapshot {
  /** 用户显式选择的主题；'system' 表示跟随系统 */
  mode: 'light' | 'dark' | 'system';
  /** 解析后的实际结果（mode=system 时由系统主题决定） */
  resolvedIsDark: boolean;
  /** 写入时的系统主题 —— 系统主题变了、而 mode 是 system 时要用新值 */
  systemIsDark: boolean;
}

const DEFAULTS: ThemeSnapshot = { mode: 'system', resolvedIsDark: false, systemIsDark: false };

let cachedPath: string | null = null;
function themePath(): string {
  if (!cachedPath) cachedPath = path.join(app.getPath('userData'), 'theme-mode.json');
  return cachedPath;
}

/**
 * 把快照按当前系统主题解析。
 *
 * 关键：mode 为 'system' 时必须**用当前的系统主题**，而不是存盘时那个。
 * 用户白天写的是浅色、晚上开机系统变深色，还按存盘值走就错了。
 */
export function resolveIsDark(snapshot: ThemeSnapshot): boolean {
  if (snapshot.mode === 'system') return nativeTheme.shouldUseDarkColors;
  return snapshot.resolvedIsDark;
}

/**
 * 读主题快照。文件缺失/损坏就跟随系统。
 * 不能因为一份坏记录让窗口起不来。
 */
export async function loadThemeSnapshot(): Promise<ThemeSnapshot> {
  const systemIsDark = nativeTheme.shouldUseDarkColors;
  let raw: string;
  try {
    raw = await fs.readFile(themePath(), 'utf8');
  } catch {
    return { ...DEFAULTS, systemIsDark, resolvedIsDark: systemIsDark };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ThemeSnapshot>;
    const mode =
      parsed.mode === 'light' || parsed.mode === 'dark' || parsed.mode === 'system'
        ? parsed.mode
        : 'system';
    const snap: ThemeSnapshot = {
      mode,
      resolvedIsDark: parsed.resolvedIsDark === true,
      systemIsDark,
    };
    return { ...snap, resolvedIsDark: resolveIsDark(snap) };
  } catch {
    console.warn('[theme] 解析失败，跟随系统主题');
    return { ...DEFAULTS, systemIsDark, resolvedIsDark: systemIsDark };
  }
}

/** 写主题快照。失败不阻断 —— 主题记不住不该影响使用 */
export async function saveThemeSnapshot(snapshot: ThemeSnapshot): Promise<void> {
  try {
    await fs.mkdir(path.dirname(themePath()), { recursive: true });
    await fs.writeFile(themePath(), JSON.stringify(snapshot, null, 2), 'utf8');
  } catch (e) {
    console.warn('[theme] 写入失败', e);
  }
}

/**
 * 窗口尺寸与位置记忆。
 *
 * 要解决的问题：每次打开都变回固定的 1180×800，用户每次都要重新调。
 *
 * 两个容易做错的地方：
 *   1. **最大化 / 全屏时要记住的是「还原后」的尺寸**，不是最大化的尺寸。
 *      记成最大化的话，用户取消最大化后窗口会变得巨大。
 *   2. **位置可能失效**：上次在副屏，这次副屏拔了；或者分辨率变了 →
 *      恢复出来的窗口在屏幕外，用户会看到「程序启动了但窗口不见了」。
 *      所以恢复前必须校验位置是否还落在某个可见屏幕里。
 */
import { app, screen, type BrowserWindow } from 'electron';
import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface WindowState {
  width: number;
  height: number;
  x?: number;
  y?: number;
  maximized?: boolean;
}

const DEFAULTS: WindowState = { width: 1180, height: 800 };
/** 恢复的窗口至少要有这么多像素落在屏幕里，否则当作位置失效 */
const MIN_VISIBLE_PX = 80;

let cachedPath: string | null = null;
function statePath(): string {
  if (!cachedPath) cachedPath = path.join(app.getPath('userData'), 'window-state.json');
  return cachedPath;
}

/**
 * 读上次的窗口状态。
 *
 * 文件不存在 / 损坏 → 返回默认值。不能因为一份坏的窗口记录让 app 起不来。
 */
export async function loadWindowState(): Promise<WindowState> {
  let raw: string;
  try {
    raw = await fs.readFile(statePath(), 'utf8');
  } catch {
    return { ...DEFAULTS };
  }

  let parsed: Partial<WindowState>;
  try {
    parsed = JSON.parse(raw) as Partial<WindowState>;
  } catch {
    console.warn('[window-state] 解析失败，使用默认尺寸');
    return { ...DEFAULTS };
  }

  const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  const state: WindowState = {
    width: num(parsed.width) && parsed.width > 0 ? Math.round(parsed.width) : DEFAULTS.width,
    height: num(parsed.height) && parsed.height > 0 ? Math.round(parsed.height) : DEFAULTS.height,
    maximized: parsed.maximized === true,
  };
  if (num(parsed.x) && num(parsed.y)) {
    state.x = Math.round(parsed.x);
    state.y = Math.round(parsed.y);
  }

  return ensureOnScreen(state);
}

/**
 * 校验位置是否仍在某个可见屏幕里。
 *
 * 位置失效时丢掉 x/y（不丢尺寸）—— 让 Electron 用系统默认位置居中打开，
 * 比硬塞一个屏幕外的坐标强。
 */
export function ensureOnScreen(state: WindowState): WindowState {
  if (state.x === undefined || state.y === undefined) return state;

  const x = state.x;
  const y = state.y;
  const visible = screen.getAllDisplays().some((display) => {
    const { x: dx, y: dy, width, height } = display.workArea;
    // 窗口左上角必须落在某个工作区里，且留出可抓取的最小重叠
    const overlapX = Math.min(x + state.width, dx + width) - Math.max(x, dx);
    const overlapY = Math.min(y + state.height, dy + height) - Math.max(y, dy);
    return overlapX >= MIN_VISIBLE_PX && overlapY >= MIN_VISIBLE_PX;
  });

  if (visible) return state;
  console.warn('[window-state] 上次的位置不在任何屏幕上，改为居中打开');
  return { width: state.width, height: state.height, maximized: state.maximized };
}

/**
 * 保存窗口状态。
 *
 * 最大化时用 getNormalBounds() 拿「还原后」的尺寸 ——
 * getBounds() 在最大化状态下返回的是整个屏幕大小。
 */
export async function saveWindowState(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed()) return;
  const normal = win.getNormalBounds();
  const state: WindowState = {
    width: normal.width,
    height: normal.height,
    x: normal.x,
    y: normal.y,
    maximized: win.isMaximized(),
  };
  try {
    await fs.mkdir(path.dirname(statePath()), { recursive: true });
    await fs.writeFile(statePath(), JSON.stringify(state, null, 2), 'utf8');
  } catch (error) {
    // 存不下来不影响使用，只是下次回到默认尺寸
    console.warn('[window-state] 保存失败:', String(error));
  }
}

/** 只在开发调试时看得到，方便排查「为什么窗口没恢复」 */
export function windowStatePath(): string {
  return statePath();
}

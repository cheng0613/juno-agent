/**
 * 窗口背板材质。
 *
 * 目标：左侧栏透出桌面壁纸（Cindy 的玻璃效果），而不是实色。
 *
 * 关键事实（上游实测记录，别自己发明）：
 *   1. CSS backdrop-filter: blur 在透明窗上**会把背衬渲染成黑色**，
 *      所以上游撤掉了 CSS blur，模糊交给系统材质（Windows Acrylic）。
 *   2. Acrylic 的原生 backing 自带侧栏染色，左栏不要再叠一层 CSS tint，
 *      叠了会变重。
 *   3. 只在 Windows 11（build >= 22000）可用；Win10 上 Acrylic 效果差，
 *      上游直接回退不透明。
 */
import { execSync } from 'node:child_process';

export type WindowsBackdropMaterial = 'none' | 'acrylic' | 'mica' | 'tabbed';

export interface BackdropConfig {
  /** 透传给 BrowserWindow 的 backgroundMaterial；'none' 表示不加材质 */
  backgroundMaterial: WindowsBackdropMaterial;
  /** 窗口背景色。透明材质下必须是带 alpha 的，否则壁纸透不出来 */
  backgroundColor: string;
}

/**
 * 侧栏染色的两个色值。
 * 与上游 CINDY_ACRYLIC_WINDOW_BACKING 一致 —— 不是 --surface，更灰一点。
 */
const ACRYLIC_TINT = {
  light: 'rgba(238, 238, 233, 0.85)',
  dark: 'rgba(5, 5, 5, 0.85)',
} as const;

/** 无材质时的不透明底，与 tokens 的 --surface 一致 */
const OPAQUE_BG = {
  light: '#f2f2ed',
  dark: '#181818',
} as const;

/** 读 Windows build 号。读不到就返回 null（当作不支持） */
function windowsBuild(): number | null {
  if (process.platform !== 'win32') return null;
  try {
    // wmic 在新系统上被移除，改用 PowerShell
    const out = execSync('powershell -NoProfile -Command "(Get-CimInstance Win32_OperatingSystem).Version"', {
      encoding: 'utf8',
      timeout: 5000,
      windowsHide: true,
    }).trim();
    const parts = out.split('.');
    if (parts.length < 3) return null;
    const build = Number.parseInt(parts[2] ?? '', 10);
    return Number.isFinite(build) ? build : null;
  } catch {
    return null;
  }
}

/**
 * 决定用哪种背板。
 *
 * 环境变量 XDT_BACKDROP_MATERIAL 可以在启动时覆盖，方便 A/B：
 *   acrylic（默认） / mica / tabbed / none
 */
export function resolveBackdropConfig(isDark: boolean): BackdropConfig {
  // 非 Windows：不加材质，用不透明底。macOS 的 vibrancy 没做，先不假装支持
  if (process.platform !== 'win32') {
    return { backgroundMaterial: 'none', backgroundColor: isDark ? OPAQUE_BG.dark : OPAQUE_BG.light };
  }

  const build = windowsBuild();
  if (build === null || build < 22000) {
    // Win10：Acrylic 效果差且不稳，回退不透明
    return { backgroundMaterial: 'none', backgroundColor: isDark ? OPAQUE_BG.dark : OPAQUE_BG.light };
  }

  const raw = (process.env.XDT_BACKDROP_MATERIAL ?? 'acrylic').toLowerCase();
  const allowed: WindowsBackdropMaterial[] = ['none', 'acrylic', 'mica', 'tabbed'];
  const material = (allowed as string[]).includes(raw) ? (raw as WindowsBackdropMaterial) : 'acrylic';

  if (material === 'none') {
    return { backgroundMaterial: 'none', backgroundColor: isDark ? OPAQUE_BG.dark : OPAQUE_BG.light };
  }

  return {
    backgroundMaterial: material,
    // 只有 acrylic 需要染色；mica/tabbed 系统自己处理
    backgroundColor: material === 'acrylic' ? (isDark ? ACRYLIC_TINT.dark : ACRYLIC_TINT.light) : '#00000000',
  };
}

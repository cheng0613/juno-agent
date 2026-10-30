import type { Config } from 'tailwindcss';

/**
 * Tailwind 配置 —— 与 Cindy 的 apps/desktop/tailwind.config.ts 同构。
 *
 * 上游这份文件由 design-tokens 的 generate.ts 生成，把 CSS 变量映射成
 * utility（`text-13`、`bg-surface`、`border-default` …）。
 * 我们手写一份等价映射：颜色角色来自 tokens.css，基础值来自 base-tokens.css。
 *
 * 为什么这样做而不是继续写自定义 class：
 *   1. 与上游一致，以后 cherry-pick 组件时样式能用
 *   2. 组件里的 padding/gap 不再散落在 app.css，改一处不用翻两个文件
 */

const fontSize: Record<string, string | [string, { lineHeight: string }]> = {
  '10': 'var(--text-10)',
  '11': 'var(--text-11)',
  '12': 'var(--text-12)',
  '13': 'var(--text-13)',
  '14': 'var(--text-14)',
  '15': 'var(--text-15)',
  '16': 'var(--text-16)',
  '18': 'var(--text-18)',
  '20': 'var(--text-20)',
  '24': 'var(--text-24)',
  '28': 'var(--text-28)',
  xs: ['var(--text-xs)', { lineHeight: 'var(--text-xs-line-height)' }],
  sm: ['var(--text-sm)', { lineHeight: 'var(--text-sm-line-height)' }],
  base: ['var(--text-base)', { lineHeight: 'var(--text-base-line-height)' }],
  lg: ['var(--text-lg)', { lineHeight: 'var(--text-lg-line-height)' }],
  '2xl': ['var(--text-2xl)', { lineHeight: 'var(--text-2xl-line-height)' }],
};

export default {
  darkMode: ['class', '.dark'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      fontSize,
      fontFamily: {
        sans: 'var(--app-font-ui-default)',
        mono: 'var(--app-font-code-default)',
      },
      spacing: {
        0: 'var(--space-0)',
        1: 'var(--space-1)',
        2: 'var(--space-2)',
        3: 'var(--space-3)',
        4: 'var(--space-4)',
        5: 'var(--space-5)',
        6: 'var(--space-6)',
        8: 'var(--space-8)',
        10: 'var(--space-10)',
        12: 'var(--space-12)',
        16: 'var(--space-16)',
      },
      borderRadius: {
        none: 'var(--radius-none)',
        DEFAULT: 'var(--radius-default)',
        xl: 'var(--radius-xl)',
        '2xl': 'var(--radius-2xl)',
        full: 'var(--radius-full)',
      },
      colors: {
        // 与 token 名逐一对齐，写 `bg-surface` 就是 `background: var(--surface)`
        surface: 'var(--surface)',
        'surface-elevated': 'var(--surface-elevated)',
        'surface-elevated-soft': 'var(--surface-elevated-soft)',
        'surface-chip': 'var(--surface-chip)',
        'surface-hover': 'var(--surface-hover)',
        'surface-hover-soft': 'var(--surface-hover-soft)',
        'surface-on-card': 'var(--surface-on-card)',
        border: 'var(--border-default)',
        'border-default': 'var(--border-default)',
        'text-primary': 'var(--text-primary)',
        'text-secondary': 'var(--text-secondary)',
        'text-tertiary': 'var(--text-tertiary)',
        'text-disabled': 'var(--text-disabled)',
        'text-inv': 'var(--text-primary-inv)',
        accent: 'var(--accent)',
        'accent-soft': 'var(--accent-soft)',
        'accent-emphasis': 'var(--accent-emphasis)',
        'accent-cta': 'var(--accent-cta-bg)',
      },
      transitionTimingFunction: {
        out: 'var(--motion-ease-out)',
        in: 'var(--motion-ease-in)',
        move: 'var(--motion-ease-move)',
      },
      transitionDuration: {
        instant: 'var(--motion-instant)',
        fast: 'var(--motion-fast)',
        base: 'var(--motion-base)',
        enter: 'var(--motion-enter)',
        exit: 'var(--motion-exit)',
      },
    },
  },
  plugins: [],
} satisfies Config;

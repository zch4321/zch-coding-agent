import type { GlobalThemeOverrides } from 'naive-ui'

export const palette = {
  background: '#ffffff',
  surface: '#f6f8fa',
  canvas: '#f3f3f3',
  border: '#d0d7de',
  borderSubtle: '#e5e7eb',
  text: '#24292f',
  textSecondary: '#57606a',
  textMuted: '#6e7781',
  accent: '#0969da',
  accentHover: '#0550ae',
  accentPressed: '#033d8b',
  accentSoft: '#ddf4ff',
  success: '#1a7f37',
  successHover: '#116329',
  successPressed: '#044f1e',
  warning: '#9a6700',
  warningHover: '#7d4e00',
  warningPressed: '#633c01',
  danger: '#cf222e',
  dangerHover: '#a40e26',
  dangerPressed: '#82071e',
  surfaceHover: '#eaeef2',
} as const

const typography = {
  sans: [
    'Inter',
    'system-ui',
    '-apple-system',
    'BlinkMacSystemFont',
    "'Segoe UI'",
    'sans-serif',
  ].join(', '),
  mono: [
    "'Cascadia Code'",
    "'SFMono-Regular'",
    'Consolas',
    "'Liberation Mono'",
    'monospace',
  ].join(', '),
} as const

const radius = {
  small: '6px',
  medium: '8px',
  large: '12px',
  pill: '999px',
} as const

const cssVariables = {
  '--font-sans': typography.sans,
  '--font-mono': typography.mono,
  '--background': palette.background,
  '--surface': palette.surface,
  '--canvas': palette.canvas,
  '--border': palette.border,
  '--border-subtle': palette.borderSubtle,
  '--text': palette.text,
  '--text-secondary': palette.textSecondary,
  '--text-muted': palette.textMuted,
  '--accent': palette.accent,
  '--accent-hover': palette.accentHover,
  '--accent-pressed': palette.accentPressed,
  '--accent-soft': palette.accentSoft,
  '--success': palette.success,
  '--success-hover': palette.successHover,
  '--success-pressed': palette.successPressed,
  '--warning': palette.warning,
  '--warning-hover': palette.warningHover,
  '--warning-pressed': palette.warningPressed,
  '--danger': palette.danger,
  '--danger-hover': palette.dangerHover,
  '--danger-pressed': palette.dangerPressed,
  '--focus': '0 0 0 2px rgba(9, 105, 218, 0.24)',
  '--surface-hover': palette.surfaceHover,
  '--radius-sm': radius.small,
  '--radius-md': radius.medium,
  '--radius-lg': radius.large,
  '--radius-pill': radius.pill,
} as const

/**
 * Applies the shared application palette before Vue mounts so custom CSS and
 * teleported Naive UI components inherit identical tokens.
 */
export function applyAppThemeVariables(root: HTMLElement): void {
  for (const [name, value] of Object.entries(cssVariables)) {
    root.style.setProperty(name, value)
  }
}

/**
 * Maps the application palette to Naive UI without CSS variable color values,
 * which Naive UI must parse to derive hover and translucent colors.
 */
export const naiveThemeOverrides: GlobalThemeOverrides = {
  common: {
    primaryColor: palette.accent,
    primaryColorHover: palette.accentHover,
    primaryColorPressed: palette.accentPressed,
    primaryColorSuppl: palette.accentHover,
    infoColor: palette.accent,
    infoColorHover: palette.accentHover,
    infoColorPressed: palette.accentPressed,
    infoColorSuppl: palette.accentHover,
    successColor: palette.success,
    successColorHover: palette.successHover,
    successColorPressed: palette.successPressed,
    successColorSuppl: palette.successHover,
    warningColor: palette.warning,
    warningColorHover: palette.warningHover,
    warningColorPressed: palette.warningPressed,
    warningColorSuppl: palette.warningHover,
    errorColor: palette.danger,
    errorColorHover: palette.dangerHover,
    errorColorPressed: palette.dangerPressed,
    errorColorSuppl: palette.dangerHover,
    textColorBase: palette.text,
    textColor1: palette.text,
    textColor2: palette.textSecondary,
    textColor3: palette.textMuted,
    dividerColor: palette.borderSubtle,
    borderColor: palette.border,
    bodyColor: palette.canvas,
    cardColor: palette.background,
    modalColor: palette.background,
    popoverColor: palette.background,
    inputColor: palette.background,
    inputColorDisabled: palette.surface,
    tagColor: palette.surface,
    hoverColor: palette.surfaceHover,
    pressedColor: palette.borderSubtle,
    fontFamily: typography.sans,
    fontFamilyMono: typography.mono,
    borderRadius: radius.medium,
    borderRadiusSmall: radius.small,
  },
  Message: {
    maxWidth: 'min(640px, calc(100vw - 32px))',
  },
}

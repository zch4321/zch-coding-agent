import { createI18n } from 'vue-i18n'
import enUS from './locales/en-us'
import zhCN from './locales/zh-cn'

export type AppLocale = 'zh-CN' | 'en-US'

const LOCALE_KEY = 'zch-coding-agent.locale'

const messages = {
  'zh-CN': zhCN,
  'en-US': enUS,
} as const

function initialLocale(): AppLocale {
  try {
    const saved = window.localStorage.getItem(LOCALE_KEY)
    if (saved === 'zh-CN' || saved === 'en-US') return saved
  } catch {
    // Local storage is optional in hardened renderer contexts.
  }
  return 'zh-CN'
}

const startingLocale = initialLocale()
document.documentElement.lang = startingLocale

export const i18n = createI18n({
  legacy: false,
  locale: startingLocale,
  fallbackLocale: 'en-US',
  messages,
})

/** Sets app locale. */
export function setAppLocale(locale: AppLocale) {
  i18n.global.locale.value = locale
  document.documentElement.lang = locale
  try {
    window.localStorage.setItem(LOCALE_KEY, locale)
  } catch {
    // Language still applies for the current renderer lifetime.
  }
}

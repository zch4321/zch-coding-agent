import { createApp } from 'vue'
import { createPinia } from 'pinia'
import './style.css'
import App from './App.vue'
import { i18n } from './i18n'
import { applyAppThemeVariables } from './theme/naive-theme'

applyAppThemeVariables(document.documentElement)
createApp(App).use(createPinia()).use(i18n).mount('#app')

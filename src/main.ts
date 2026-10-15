import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import WebApp from './WebApp.vue'
import './styles.css'

const isTauri = '__TAURI_INTERNALS__' in window
if (!isTauri) {
  void import('virtual:pwa-register').then(({ registerSW }) => registerSW({ immediate: true }))
}

const Root = isTauri ? App : WebApp
createApp(Root).use(createPinia()).mount('#app')

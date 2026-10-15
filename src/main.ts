import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import WebApp from './WebApp.vue'
import './styles.css'

const Root = '__TAURI_INTERNALS__' in window ? App : WebApp
createApp(Root).use(createPinia()).mount('#app')

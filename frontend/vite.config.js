import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Бэкенд для `npm run dev`. Страница обращается к /api и /socket.io на своём
// же адресе, а Vite перекидывает их сюда — как nginx на VPS.
const BACKEND = process.env.PISMO_BACKEND || 'http://localhost:5000'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    host: '0.0.0.0', // доступ с других устройств в локальной сети
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/socket.io': { target: BACKEND, changeOrigin: true, ws: true }
    }
  }
})

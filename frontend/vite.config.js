import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * Режим разработки: Vite отдаёт страницу на :5173, а бэкенд слушает :5000.
 *
 * Без прокси страница звала бы /api/auth/login на самом Vite и получала 404,
 * а сокет пытался бы подключиться к :5173, где его никто не слушает, — то
 * есть «npm run dev» не работал бы вовсе, пока вручную не задашь
 * VITE_BACKEND_URL. Прокси убирает этот шаг: адреса остаются
 * относительными, и та же сборка работает и в бою, где всё на одном порту.
 *
 * PISMO_BACKEND — если бэкенд поднят не на localhost:5000.
 */
const backend = process.env.PISMO_BACKEND || 'http://localhost:5000';

export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173,
        host: '0.0.0.0',
        proxy: {
            '/api': { target: backend, changeOrigin: true },
            // ws: true обязателен — socket.io живёт на WebSocket, и без него
            // соединение молча падает в бесконечное переподключение.
            '/socket.io': { target: backend, changeOrigin: true, ws: true },
        },
    },
});

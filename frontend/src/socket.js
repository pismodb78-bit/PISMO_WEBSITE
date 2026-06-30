import { io } from 'socket.io-client';

const URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';

// autoConnect: false — подключаемся сами, вручную, после логина (см. App.jsx).
// auth передаётся функцией, чтобы токен брался свежим при каждой попытке подключения
// (важно при reconnect после смены/обновления токена).
export const socket = io(URL, {
    autoConnect: false,
    withCredentials: true,
    auth: (cb) => {
        cb({ token: localStorage.getItem('pismo_token') });
    }
});

// Промис-обёртка над socket.emit с ack-колбэком сервера.
// Использование: const { history } = await emitAsync('chat:join', { partnerId: 5 });
export function emitAsync(event, payload = {}) {
    return new Promise((resolve, reject) => {
        socket.emit(event, payload, (response) => {
            if (response?.ok) {
                resolve(response);
            } else {
                reject(new Error(response?.error || 'SOCKET_ERROR'));
            }
        });
    });
}
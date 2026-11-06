import { io } from 'socket.io-client';

// Без VITE_BACKEND_URL сокет идёт на тот же сайт, что и страница (undefined —
// значит «текущий адрес»): так он работает и через nginx на VPS, и через
// прокси Vite при разработке. Раньше здесь стоял localhost:5000, и открытая
// с другого компьютера страница стучалась в свой собственный localhost.
const URL = import.meta.env.VITE_BACKEND_URL || undefined;

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
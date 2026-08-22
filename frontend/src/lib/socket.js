import { io } from 'socket.io-client';
import { getToken } from './api';

const URL = import.meta.env.VITE_BACKEND_URL || window.location.origin;

/**
 * autoConnect: false — подключаемся вручную после входа.
 * auth функцией, чтобы при переподключении брался свежий токен.
 */
export const socket = io(URL, {
    autoConnect: false,
    withCredentials: true,
    auth: (cb) => cb({ token: getToken() }),
});

/**
 * Промис-обёртка над emit с ack-колбэком.
 * Все обработчики бэкенда отвечают {ok:true,...} либо {ok:false,error}.
 */
export function ask(event, payload = {}) {
    return new Promise((resolve, reject) => {
        if (!socket.connected) {
            reject(new Error('Нет связи с сервером'));
            return;
        }
        const timer = setTimeout(() => reject(new Error('Сервер не ответил')), 30000);
        socket.emit(event, payload, (res) => {
            clearTimeout(timer);
            if (res && res.ok) resolve(res);
            else reject(new Error(res?.error || 'Ошибка'));
        });
    });
}

/** Подписка с автоотпиской — удобно возвращать прямо из useEffect. */
export function on(event, handler) {
    socket.on(event, handler);
    return () => socket.off(event, handler);
}

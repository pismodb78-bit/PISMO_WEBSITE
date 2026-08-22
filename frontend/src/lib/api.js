/**
 * REST-часть: вход, регистрация, смена пароля и ссылки на вложения.
 * Всё остальное общение идёт через сокет — см. lib/socket.js.
 */
const BASE = import.meta.env.VITE_BACKEND_URL || '';

const TOKEN_KEY = 'pismo_token';
const USER_KEY = 'pismo_user';

export function getToken() {
    return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser() {
    try {
        const raw = localStorage.getItem(USER_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch (_) {
        return null;
    }
}

export function storeSession(token, user) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
}

async function post(path, body) {
    const res = await fetch(`${BASE}/api${path}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(getToken() ? { Authorization: `Bearer ${getToken()}` } : {}),
        },
        body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || 'Ошибка сервера');
    return data;
}

export async function login(loginName, password) {
    const data = await post('/auth/login', { login: loginName, password });
    storeSession(data.token, data.user);
    return data.user;
}

export async function register(name, surname, loginName, password) {
    return post('/auth/register', { name, surname, login: loginName, password });
}

export async function changePassword(oldPassword, newPassword, confirm) {
    return post('/auth/change-password', { oldPassword, newPassword, confirm });
}

export async function fetchConfig() {
    const res = await fetch(`${BASE}/api/config`);
    return res.json();
}

/**
 * Ссылка на вложение. Токен идёт в query, потому что у <img> и <audio>
 * заголовки не выставить; на бэкенде он проверяется так же строго.
 */
export function mediaUrl(scope, messageId, kind) {
    return `${BASE}/api/media/${scope}/${messageId}/${kind}?token=${encodeURIComponent(getToken() || '')}`;
}

export function avatarUrl(userId) {
    return `${BASE}/api/media/avatar/${userId}?token=${encodeURIComponent(getToken() || '')}`;
}

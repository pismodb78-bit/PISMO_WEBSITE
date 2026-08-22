/**
 * Токен сессии сайта.
 *
 * Формат payload совпадает с JwtAuth.cs / JwtAuth.kt: uid, login, iat, exp
 * — и подписывается тем же секретом. Благодаря этому токен, выданный
 * сайтом, принимает и ws-сервер сигналинга: отдельный вход туда не нужен.
 *
 * Поле `uid` обязательно именно под этим именем — по нему сигналинг
 * опознаёт пользователя. `id`, `name` и `role` добавлены для нужд самого
 * сайта; лишние поля сигналинг игнорирует.
 */
const jwt = require('jsonwebtoken');
const config = require('../config');

function createToken({ id, login, name, role }) {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign(
        {
            uid: id,
            id,
            login,
            name: name || login,
            role: role || '',
            iat: now,
            exp: now + config.jwtTtlDays * 86400,
        },
        config.jwtSecret,
        { algorithm: 'HS256' },
    );
}

/** Возвращает payload или null. Ошибку наверх не бросаем — вызов проще. */
function verifyToken(token) {
    if (!token) return null;
    try {
        return jwt.verify(token, config.jwtSecret);
    } catch (_) {
        return null;
    }
}

/** Middleware для REST-роутов. */
function authGuard(req, res, next) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    const payload = verifyToken(token);
    if (!payload) return res.status(401).json({ message: 'Требуется вход' });
    req.user = { id: payload.uid || payload.id, login: payload.login, name: payload.name, role: payload.role };
    return next();
}

/** Авторизация сокета на этапе handshake — единственное место проверки. */
function socketAuth(socket, next) {
    const payload = verifyToken(socket.handshake.auth?.token);
    if (!payload) return next(new Error('AUTH_INVALID_TOKEN'));
    socket.userId = payload.uid || payload.id;
    socket.userLogin = payload.login;
    socket.userName = payload.name || payload.login;
    socket.userRole = payload.role;
    return next();
}

module.exports = { createToken, verifyToken, authGuard, socketAuth };

const jwt = require('jsonwebtoken');

// ВАЖНО: секрет совпадает с JwtAuth.cs в десктопном клиенте
const JWT_SECRET = process.env.JWT_SECRET || 'uc5KT2e+qYwa6tb0HUXnLZwsC55VuB93szkSpkucr8i1BFjKA6RXbyIrjk0+ign9';

module.exports = function (req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Формат: "Bearer <token>"

    if (!token) {
        return res.status(401).json({ message: 'Доступ запрещен. Токен авторизации отсутствует.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; // Передаём id, login и role в объект запроса
        next();
    } catch (err) {
        return res.status(403).json({ message: 'Невалидный или просроченный токен сессии.' });
    }
};
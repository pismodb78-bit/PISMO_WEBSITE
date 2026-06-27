const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'pismo_secret_blurple_key_2026';

module.exports = function (req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1]; // Ожидаем формат "Bearer <token>"

    if (!token) {
        return res.status(401).json({ message: 'Доступ запрещен. Токен авторизации отсутствует.' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; // Передаем id, login и role в объект запроса
        next();
    } catch (err) {
        return res.status(403).json({ message: 'Невалидный или просроченный токен сессии.' });
    }
};
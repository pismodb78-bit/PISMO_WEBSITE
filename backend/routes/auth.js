const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const authGuard = require('../middleware/auth');

// ВАЖНО: секрет совпадает с JwtAuth.cs в десктопном клиенте
const JWT_SECRET = process.env.JWT_SECRET || 'uc5KT2e+qYwa6tb0HUXnLZwsC55VuB93szkSpkucr8i1BFjKA6RXbyIrjk0+ign9';

// POST /api/auth/register
router.post('/register', async (req, res) => {
    const { login, password, name, surname, role } = req.body;

    if (!login || !password) {
        return res.status(400).json({ message: 'Логин и пароль обязательны для заполнения' });
    }

    try {
        const [existingUsers] = await db.query('SELECT id FROM users WHERE login = ?', [login]);
        if (existingUsers.length > 0) {
            return res.status(400).json({ message: 'Пользователь с таким логином уже зарегистрирован' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const userRole = role || 'student';

        await db.query(
            'INSERT INTO users (login, password, Name, Surname, role) VALUES (?, ?, ?, ?, ?)',
            [login, hashedPassword, name || null, surname || null, userRole]
        );

        return res.status(201).json({ message: 'Регистрация успешно завершена' });
    } catch (err) {
        console.error('[Ошибка регистрации]:', err);
        return res.status(500).json({ message: 'Внутренняя ошибка сервера при регистрации' });
    }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
    const { login, password } = req.body;

    if (!login || !password) {
        return res.status(400).json({ message: 'Пожалуйста, заполните все поля' });
    }

    try {
        const [users] = await db.query('SELECT * FROM users WHERE login = ?', [login]);
        if (users.length === 0) {
            return res.status(400).json({ message: 'Неверный логин или пароль' });
        }

        const user = users[0];

        // Проверяем bcrypt-пароль (веб) и plain text (легаси десктоп WinForms)
        let isMatch = await bcrypt.compare(password, user.password).catch(() => false);
        if (!isMatch && password === user.password) {
            isMatch = true; // Фолбек для старых записей из десктопа
        }

        if (!isMatch) {
            return res.status(400).json({ message: 'Неверный логин или пароль' });
        }

        const now = Math.floor(Date.now() / 1000);

        // Payload совместим с JwtAuth.cs: uid, login, iat, exp
        const token = jwt.sign(
            {
                uid: user.id,       // десктоп использует "uid", не "id"
                id: user.id,        // оставляем "id" для совместимости с нашим middleware
                login: user.login,
                role: user.role,
                iat: now,
            },
            JWT_SECRET,
            { expiresIn: '24h' }
        );

        return res.json({
            token,
            user: {
                id: user.id,
                login: user.login,
                name: user.Name,
                surname: user.Surname,
                role: user.role
            }
        });
    } catch (err) {
        console.error('[Ошибка авторизации]:', err);
        return res.status(500).json({ message: 'Внутренняя ошибка сервера при авторизации' });
    }
});

// POST /api/auth/logout
router.post('/logout', (req, res) => {
    return res.json({ message: 'Успешный выход из системы' });
});

// POST /api/auth/change-password
router.post('/change-password', authGuard, async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    const userId = req.user.id || req.user.uid;

    if (!oldPassword || !newPassword) {
        return res.status(400).json({ message: 'Необходимо указать старый и новый пароли' });
    }

    if (newPassword.length < 4) {
        return res.status(400).json({ message: 'Новый пароль слишком короткий (минимум 4 символа)' });
    }

    try {
        const [users] = await db.query('SELECT password FROM users WHERE id = ?', [userId]);
        if (users.length === 0) {
            return res.status(404).json({ message: 'Пользователь не найден' });
        }

        const currentPasswordHash = users[0].password;

        // Проверяем bcrypt (веб) и plain text (легаси десктоп)
        let isMatch = await bcrypt.compare(oldPassword, currentPasswordHash).catch(() => false);
        if (!isMatch && oldPassword === currentPasswordHash) {
            isMatch = true;
        }

        if (!isMatch) {
            return res.status(400).json({ message: 'Старый пароль указан неверно' });
        }

        // Новый пароль не должен совпадать со старым (учитываем и bcrypt, и legacy plain text)
        let sameAsOld = await bcrypt.compare(newPassword, currentPasswordHash).catch(() => false);
        if (!sameAsOld && newPassword === currentPasswordHash) sameAsOld = true;

        if (newPassword === oldPassword || sameAsOld) {
            return res.status(400).json({ message: 'Новый пароль совпадает со старым' });
        }

        const hashedNewPassword = await bcrypt.hash(newPassword, 10);
        await db.query('UPDATE users SET password = ? WHERE id = ?', [hashedNewPassword, userId]);

        return res.json({ message: 'Пароль успешно обновлен' });
    } catch (err) {
        console.error('[Ошибка смены пароля]:', err);
        return res.status(500).json({ message: 'Не удалось обновить пароль' });
    }
});

// GET /api/auth/users — список пользователей для сайдбара
router.get('/users', authGuard, async (req, res) => {
    try {
        const [users] = await db.query('SELECT id, login, Name, Surname, role FROM users');
        return res.json(users);
    } catch (err) {
        console.error('[Ошибка получения списка пользователей]:', err);
        return res.status(500).json({ message: 'Внутренняя ошибка сервера при получении списка пользователей' });
    }
});

module.exports = router;
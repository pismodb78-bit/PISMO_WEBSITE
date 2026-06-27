const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../db');
const authGuard = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'pismo_secret_blurple_key_2026';

// POST /api/auth/register
router.post('/register', async (req, res) => {
    const { login, password, name, surname, role } = req.body;

    if (!login || !password) {
        return res.status(400).json({ message: 'Логин и пароль обязательны для заполнения' });
    }

    try {
        // Проверка на уникальность логина
        const [existingUsers] = await db.query('SELECT id FROM users WHERE login = ?', [login]);
        if (existingUsers.length > 0) {
            return res.status(400).json({ message: 'Пользователь с таким логином уже зарегистрирован' });
        }

        // Хешируем новый пароль для веб-версии
        const hashedPassword = await bcrypt.hash(password, 10);
        const userRole = role || 'student';

        // Важно: Поля Name и Surname пишем с большой буквы, как в схеме MySQL!
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

        // Проверяем пароль (совместимость с bcrypt + легаси plain text)
        let isMatch = await bcrypt.compare(password, user.password).catch(() => false);
        
        if (!isMatch && password === user.password) {
            isMatch = true; // Фолбек для старой базы данных WinForms
        }

        if (!isMatch) {
            return res.status(400).json({ message: 'Неверный логин или пароль' });
        }

        // Генерация токена на 24 часа
        const token = jwt.sign(
            { id: user.id, login: user.login, role: user.role },
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
    // В JWT-архитектуре инвалидация происходит на стороне клиента удалением токена
    return res.json({ message: 'Успешный выход из системы' });
});

// POST /api/auth/change-password
router.post('/change-password', authGuard, async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    const userId = req.user.id;

    if (!oldPassword || !newPassword) {
        return res.status(400).json({ message: 'Необходимо указать старый и новый пароли' });
    }

    try {
        const [users] = await db.query('SELECT password FROM users WHERE id = ?', [userId]);
        if (users.length === 0) {
            return res.status(404).json({ message: 'Пользователь не найден' });
        }

        const currentPasswordHash = users[0].password;
        let isMatch = await bcrypt.compare(oldPassword, currentPasswordHash).catch(() => false);
        
        if (!isMatch && oldPassword === currentPasswordHash) {
            isMatch = true;
        }

        if (!isMatch) {
            return res.status(400).json({ message: 'Старый пароль указан неверно' });
        }

        const hashedNewPassword = await bcrypt.hash(newPassword, 10);
        await db.query('UPDATE users SET password = ? WHERE id = ?', [hashedNewPassword, userId]);

        return res.json({ message: 'Пароль успешно обновлен' });
    } catch (err) {
        console.error('[Ошибка смены пароля]:', err);
        return res.status(500).json({ message: 'Не удалось обновить пароль' });
    }
});

/**
 * @route   GET /api/auth/users
 * @desc    Получить список всех пользователей мессенджера для сайдбара
 * @access  Private (нужен валидный JWT токен)
 */
router.get('/users', authGuard, async (req, res) => {
    try {
        // Запрашиваем только безопасные поля, исключая пароли
        const [users] = await db.query('SELECT id, login, Name, Surname, role FROM users');
        return res.json(users);
    } catch (err) {
        console.error('[Ошибка получения списка пользователей]:', err);
        return res.status(500).json({ 
            message: 'Внутренняя ошибка сервера при получении списка пользователей' 
        });
    }
});

module.exports = router;
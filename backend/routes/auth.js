/**
 * Вход, регистрация и смена пароля — порт LoginForm.cs / RegisterForm.cs /
 * ChangePasswordForm.cs (они же AuthRepository.kt).
 *
 * ГЛАВНОЕ: пароль НЕ сверяется в SQL. Берём хеш по логину и проверяем в
 * коде — в базе рядом лежат три формата (pbkdf2, bcrypt от старой версии
 * сайта и легаси-plaintext), и сравнение «WHERE password=?» отсекло бы
 * почти всех. Правила валидации повторяют клиентов дословно, иначе на
 * сайте заводились бы учётные записи, которые ПК потом не принимает.
 */
const express = require('express');
const db = require('../db');
const passwords = require('../utils/passwords');
const { createToken, authGuard } = require('../utils/session');
const { buildName } = require('../utils/format');

const router = express.Router();

/**
 * Защита от подбора — порт ограничения из LoginForm.cs: пять промахов
 * подряд, и вход запирается с нарастающей задержкой. Живой человек
 * разницы не замечает, а перебор через форму теряет смысл.
 *
 * Счётчик в памяти процесса: при перезапуске обнуляется, как и на ПК.
 */
const attempts = new Map();
const MAX_ATTEMPTS = 5;

function lockRemainingMs(login) {
    const rec = attempts.get(login);
    if (!rec || rec.fails < MAX_ATTEMPTS) return 0;
    // 5 промахов — 30 секунд, дальше удвоение до пяти минут.
    const penalty = Math.min(30000 * 2 ** (rec.fails - MAX_ATTEMPTS), 300000);
    const left = rec.last + penalty - Date.now();
    return left > 0 ? left : 0;
}

function registerFailure(login) {
    const rec = attempts.get(login) || { fails: 0, last: 0 };
    rec.fails += 1;
    rec.last = Date.now();
    attempts.set(login, rec);
}

function registerSuccess(login) {
    attempts.delete(login);
}

// POST /api/auth/login
router.post('/login', async (req, res) => {
    const { login, password } = req.body || {};
    if (!login || !password) {
        return res.status(400).json({ message: 'Пожалуйста, заполните все поля' });
    }

    const lock = lockRemainingMs(login);
    if (lock > 0) {
        return res.status(429).json({
            message: `Слишком много попыток. Подождите ${Math.ceil(lock / 1000)} с.`,
        });
    }

    try {
        const user = await db.queryFirst(
            'SELECT id, Name, Surname, role, password FROM users WHERE login=?', [login],
        );
        if (!user) {
            registerFailure(login);
            return res.status(400).json({ message: 'Неверный логин или пароль' });
        }

        if (!passwords.verify(password, user.password)) {
            registerFailure(login);
            return res.status(400).json({ message: 'Неверный логин или пароль' });
        }
        registerSuccess(login);

        // Перевод пароля в pbkdf2. Именно это чинит вход в приложения для
        // тех, кто регистрировался на старом сайте под bcrypt: до апгрейда
        // ПК и Android такой пароль отвергают безоговорочно.
        if (passwords.needsUpgrade(user.password)) {
            await db.exec(
                'UPDATE users SET password=? WHERE id=?', [passwords.hash(password), user.id],
            ).catch(() => {});
        }

        const name = buildName(user.Name, user.Surname, login);
        const role = (user.role || '').toLowerCase();
        return res.json({
            token: createToken({ id: user.id, login, name, role }),
            user: { id: user.id, login, name, role },
        });
    } catch (err) {
        console.error('[вход]', err.message);
        return res.status(500).json({ message: 'Сервер недоступен. Попробуйте позже.' });
    }
});

// POST /api/auth/register
router.post('/register', async (req, res) => {
    const { name, surname, login, password } = req.body || {};

    // Правила дословно из RegisterForm.cs — чтобы учётные записи,
    // заведённые с сайта, вели себя как заведённые с ПК.
    if (!name || !surname || !login || !password) {
        return res.status(400).json({ message: 'Заполните все поля!' });
    }
    if (String(login).toLowerCase() === 'admin') {
        return res.status(400).json({ message: 'Этот логин зарезервирован.' });
    }
    if (String(password).length < 8) {
        return res.status(400).json({ message: 'Пароль минимум 8 символов.' });
    }
    if (password === '12345678' || password === '87654321') {
        return res.status(400).json({ message: 'Пароль слишком предсказуем!' });
    }

    try {
        const taken = await db.scalarInt('SELECT COUNT(*) FROM users WHERE login=?', [login], 0);
        if (taken > 0) return res.status(400).json({ message: 'Этот логин уже занят.' });

        await db.exec(
            "INSERT INTO users (login, password, Name, Surname, role) VALUES (?, ?, ?, ?, 'teacher')",
            [login, passwords.hash(password), name, surname],
        );
        return res.status(201).json({ message: 'Регистрация успешно завершена' });
    } catch (err) {
        console.error('[регистрация]', err.message);
        return res.status(500).json({ message: 'Не удалось зарегистрироваться' });
    }
});

// POST /api/auth/change-password
router.post('/change-password', authGuard, async (req, res) => {
    const { oldPassword, newPassword, confirm } = req.body || {};
    const userId = req.user.id;

    // Валидация как в ChangePasswordForm.cs.
    if (!oldPassword || !newPassword) {
        return res.status(400).json({ message: 'Необходимо указать старый и новый пароли' });
    }
    if (String(newPassword).length < 8) {
        return res.status(400).json({ message: 'Пароль минимум 8 символов!' });
    }
    if (newPassword === '12345678' || newPassword === '87654321') {
        return res.status(400).json({ message: 'Пароль слишком предсказуем!' });
    }
    if (!String(newPassword).trim()) {
        return res.status(400).json({ message: 'Пароль не может состоять из пробелов!' });
    }
    if (confirm !== undefined && newPassword !== confirm) {
        return res.status(400).json({ message: 'Пароли не совпадают!' });
    }

    try {
        const stored = await db.scalar('SELECT password FROM users WHERE id=?', [userId], null);
        if (stored === null) return res.status(404).json({ message: 'Пользователь не найден.' });
        if (!passwords.verify(oldPassword, stored)) {
            return res.status(400).json({ message: 'Старый пароль неверен!' });
        }
        if (oldPassword === newPassword) {
            return res.status(400).json({ message: 'Новый пароль совпадает со старым' });
        }

        await db.exec('UPDATE users SET password=? WHERE id=?', [passwords.hash(newPassword), userId]);
        return res.json({ message: 'Пароль успешно обновлён' });
    } catch (err) {
        console.error('[смена пароля]', err.message);
        return res.status(500).json({ message: 'Не удалось обновить пароль' });
    }
});

// POST /api/auth/logout — токен без состояния, чистит его клиент.
router.post('/logout', (_req, res) => res.json({ message: 'Выход выполнен' }));

module.exports = router;

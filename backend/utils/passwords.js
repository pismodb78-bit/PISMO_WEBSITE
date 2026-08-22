/**
 * Хеширование паролей — порт PISMO/PasswordHasher.cs и PasswordHasher.kt.
 *
 * Формат хранения: pbkdf2$<iterations>$<base64 salt>$<base64 hash>
 * (PBKDF2-HMAC-SHA256, 100 000 итераций, соль 16 байт, ключ 32 байта).
 *
 * ПОЧЕМУ НЕ BCRYPT. Прежняя версия сайта хешировала bcrypt-ом, и это
 * разводило пользователей по разным клиентам НАСМЕРТЬ, в обе стороны:
 *
 *   • PasswordHasher.verify на ПК и Android явно возвращает false на всё,
 *     что начинается с "$2" — то есть человек, сменивший пароль на сайте,
 *     терял вход в приложение и не мог понять почему: пароль-то верный.
 *   • Обратно так же: у пользователя из приложения в базе лежит "pbkdf2$…",
 *     а сайт звал bcrypt.compare, который на этой строке даёт false, и
 *     сравнение с открытым текстом тоже не срабатывало.
 *
 * Поэтому сайт теперь ПИШЕТ только pbkdf2, а читать умеет всё:
 *
 *   pbkdf2$…  — родной формат, сверяем;
 *   $2…       — bcrypt, наследство старой версии сайта: сверяем и при
 *               успешном входе молча перехешируем в pbkdf2, после чего
 *               учётная запись начинает работать и в приложениях;
 *   остальное — легаси-plaintext из ранних версий ПК, сравниваем напрямую
 *               и точно так же перехешируем (ровно как LoginForm.cs).
 */
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const PREFIX = 'pbkdf2$';
const ITERATIONS = 100000;
const SALT_SIZE = 16;
const KEY_SIZE = 32;
const DIGEST = 'sha256';

function hash(password) {
    const salt = crypto.randomBytes(SALT_SIZE);
    const key = crypto.pbkdf2Sync(String(password ?? ''), salt, ITERATIONS, KEY_SIZE, DIGEST);
    return `${PREFIX}${ITERATIONS}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/**
 * Проверяет пароль против того, что лежит в базе.
 * Возвращает true/false; какой это был формат — см. needsUpgrade().
 */
function verify(password, stored) {
    if (!stored) return false;
    const pass = String(password ?? '');

    if (stored.startsWith(PREFIX)) {
        try {
            const parts = stored.split('$');       // [pbkdf2, iter, salt, key]
            if (parts.length !== 4) return false;
            const iterations = parseInt(parts[1], 10);
            if (!Number.isFinite(iterations) || iterations <= 0) return false;
            const salt = Buffer.from(parts[2], 'base64');
            const expected = Buffer.from(parts[3], 'base64');
            const actual = crypto.pbkdf2Sync(pass, salt, iterations, expected.length, DIGEST);
            // Сравнение за постоянное время — как fixedTimeEquals на клиентах.
            return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
        } catch (_) {
            return false;
        }
    }

    // Наследство старой версии сайта. Приложения такой пароль не примут,
    // поэтому при успешном входе он будет перехеширован — см. needsUpgrade.
    if (stored.startsWith('$2')) {
        try {
            return bcrypt.compareSync(pass, stored);
        } catch (_) {
            return false;
        }
    }

    // Легаси-plaintext. Длины разные — timingSafeEqual бросает, поэтому
    // сначала сверяем длину.
    const a = Buffer.from(pass, 'utf8');
    const b = Buffer.from(stored, 'utf8');
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Нужно ли перехешировать (всё, что не наш PBKDF2-формат). */
function needsUpgrade(stored) {
    return !stored || !stored.startsWith(PREFIX);
}

module.exports = { hash, verify, needsUpgrade, PREFIX, ITERATIONS };

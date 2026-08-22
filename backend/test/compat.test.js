/**
 * Тесты слоя совместимости с ПК-клиентом и Android.
 *
 * Смысл именно в них: расхождение здесь не роняет сборку и не даёт ошибку
 * в логах — оно проявляется как «сообщения с телефона выглядят как
 * enc:v2:AAAA» или «пароль верный, но приложение не пускает». Такое
 * ловится только проверкой формата.
 *
 * Запуск: npm test (база не нужна).
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const { enc, dec } = require('../utils/crypto');
const passwords = require('../utils/passwords');
const livekit = require('../utils/livekit');
const format = require('../utils/format');

const KEY = crypto.createHash('sha256')
    .update('PISMO::message::secret::v1::do-not-change', 'utf8').digest();

// ── Шифрование ─────────────────────────────────────────────────────────

test('enc даёт формат enc:v2 и читается обратно', () => {
    const src = 'Привет 👋 ёжик <b>жирный</b>';
    const out = enc(src);
    assert.ok(out.startsWith('enc:v2:'), 'должен быть префикс enc:v2:');
    assert.strictEqual(dec(out), src);
});

test('раскладка байт совпадает с .NET: nonce(12) ‖ tag(16) ‖ ciphertext', () => {
    // Разбираем НАШ вывод так, как это делает Kotlin-клиент: тег он берёт
    // сразу после nonce и переставляет в хвост для javax.crypto.
    const src = 'проверка раскладки';
    const raw = Buffer.from(enc(src).slice('enc:v2:'.length), 'base64');

    const nonce = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);

    const d = crypto.createDecipheriv('aes-256-gcm', KEY, nonce, { authTagLength: 16 });
    d.setAuthTag(tag);
    const plain = Buffer.concat([d.update(ct), d.final()]).toString('utf8');

    assert.strictEqual(plain, src, 'клиент обязан прочитать наш шифртекст');
});

test('читаем то, что зашифровал клиент (сборка в порядке .NET)', () => {
    // Собираем ровно как Crypto.kt: java-путь даёт ct‖tag, клиент
    // переставляет тег вперёд.
    const src = 'сообщение с телефона';
    const nonce = crypto.randomBytes(12);
    const c = crypto.createCipheriv('aes-256-gcm', KEY, nonce, { authTagLength: 16 });
    const ct = Buffer.concat([c.update(src, 'utf8'), c.final()]);
    const tag = c.getAuthTag();
    const asClientWrites = `enc:v2:${Buffer.concat([nonce, tag, ct]).toString('base64')}`;

    assert.strictEqual(dec(asClientWrites), src);
});

test('легаси enc:v1 (AES-CBC) ещё читается', () => {
    const src = 'старое сообщение';
    const iv = crypto.randomBytes(16);
    const c = crypto.createCipheriv('aes-256-cbc', KEY, iv);
    const ct = Buffer.concat([c.update(src, 'utf8'), c.final()]);
    const v1 = `enc:v1:${Buffer.concat([iv, ct]).toString('base64')}`;

    assert.strictEqual(dec(v1), src);
});

test('незашифрованный текст и порча не роняют разбор', () => {
    assert.strictEqual(dec('обычный текст'), 'обычный текст');
    assert.strictEqual(dec('enc:v2:мусор'), 'enc:v2:мусор');
    assert.strictEqual(dec(''), '');
    assert.strictEqual(enc(''), '');
});

// ── Пароли ─────────────────────────────────────────────────────────────

test('хеш имеет вид pbkdf2$100000$соль$ключ', () => {
    const h = passwords.hash('secret123');
    const parts = h.split('$');
    assert.strictEqual(parts[0], 'pbkdf2');
    assert.strictEqual(parts[1], '100000');
    assert.strictEqual(Buffer.from(parts[2], 'base64').length, 16, 'соль 16 байт');
    assert.strictEqual(Buffer.from(parts[3], 'base64').length, 32, 'ключ 32 байта');
});

test('наш хеш сходится с независимым PBKDF2-HMAC-SHA256', () => {
    // Тот же счёт, что делает PasswordHasher.kt вручную через Mac.
    const h = passwords.hash('пароль');
    const [, iter, salt, key] = h.split('$');
    const expected = crypto.pbkdf2Sync(
        'пароль', Buffer.from(salt, 'base64'), Number(iter), 32, 'sha256',
    );
    assert.strictEqual(expected.toString('base64'), key);
});

test('проверка пароля: верный, неверный, пустое хранилище', () => {
    const h = passwords.hash('secret123');
    assert.ok(passwords.verify('secret123', h));
    assert.ok(!passwords.verify('secret124', h));
    assert.ok(!passwords.verify('secret123', null));
    assert.ok(!passwords.needsUpgrade(h));
});

test('bcrypt со старого сайта читается и помечается на перехеширование', () => {
    // Именно этот случай ломал вход в приложения: PasswordHasher на ПК и
    // Android отвергает всё, что начинается с "$2", безоговорочно.
    const bcrypt = require('bcryptjs');
    const stored = bcrypt.hashSync('web123', 10);
    assert.ok(passwords.verify('web123', stored));
    assert.ok(!passwords.verify('web124', stored));
    assert.ok(passwords.needsUpgrade(stored), 'должен быть переведён в pbkdf2');
});

test('легаси-plaintext сверяется и помечается на перехеширование', () => {
    assert.ok(passwords.verify('abc', 'abc'));
    assert.ok(!passwords.verify('abd', 'abc'));
    assert.ok(passwords.needsUpgrade('abc'));
});

// ── Токены LiveKit ─────────────────────────────────────────────────────

function decodePart(part) {
    return JSON.parse(Buffer.from(part.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}

test('identity — голый id пользователя, без префикса user_', () => {
    // По identity ПК сопоставляет участников с плитками. Прежняя версия
    // сайта слала "user_5", и такой участник оставался неопознанным.
    const payload = decodePart(livekit.createToken('call_1', 5, 'Пётр').split('.')[1]);
    assert.strictEqual(payload.sub, '5');
});

test('имена комнат совпадают с клиентами', () => {
    assert.strictEqual(livekit.roomForCall(17), 'call_17');
    assert.strictEqual(livekit.roomForVoiceChannel(42), 'vch_42');
    assert.strictEqual(livekit.channelIdFromRoom('vch_42'), 42);
    assert.strictEqual(livekit.channelIdFromRoom('call_42'), -1);
});

test('canUpdateOwnMetadata на месте — без него не работают значки мьюта', () => {
    const payload = decodePart(livekit.createToken('vch_9', 3, 'Аня').split('.')[1]);
    assert.strictEqual(payload.video.canUpdateOwnMetadata, true);
    assert.strictEqual(payload.video.roomJoin, true);
    assert.strictEqual(payload.video.room, 'vch_9');
});

test('токен — HS256, Base64Url без паддинга, подпись сходится', () => {
    const token = livekit.createToken('call_1', 1, 'Тест');
    const [h, p, s] = token.split('.');
    assert.strictEqual(decodePart(h).alg, 'HS256');
    assert.ok(!token.includes('='), 'паддинга быть не должно');
    assert.ok(!token.includes('+') && !token.includes('/'), 'символы должны быть url-safe');

    const config = require('../config');
    const expected = livekit.b64url(
        crypto.createHmac('sha256', config.livekit.apiSecret).update(`${h}.${p}`, 'ascii').digest(),
    );
    assert.strictEqual(s, expected);
});

// ── Разбор текста ──────────────────────────────────────────────────────

test('упоминания разбираются по правилам ПК', () => {
    assert.deepStrictEqual([...format.mentionTokens('привет @petrov, и @все!')].sort(),
        ['petrov', 'все']);
    assert.ok(format.mentionsMe('эй @petrov', 'petrov', ''));
    assert.ok(format.mentionsMe('@админы сюда', 'x', 'Админы'), 'упоминание роли');
    assert.ok(format.mentionsMe('@everyone', 'x', ''), 'общее упоминание');
    assert.ok(!format.mentionsMe('просто текст', 'petrov', ''));
    assert.ok(!format.mentionsMe('почта petrov@mail.ru', 'ivanov', ''));
});

test('описание сообщения повторяет формулировки ПК', () => {
    assert.strictEqual(format.describeMessage({ hasAudio: true }), '🎤 Голосовое');
    assert.strictEqual(format.describeMessage({ hasVideo: true }), '⭕ Кружок');
    assert.strictEqual(format.describeMessage({ hasImage: true }), '🖼 Фото');
    assert.strictEqual(format.describeMessage({ hasImage: true, text: 'gif:x' }), '🎞 GIF');
    assert.strictEqual(format.describeMessage({ hasFile: true, fileName: 'о.pdf' }), '📄 Документ · о.pdf');
    assert.strictEqual(format.describeMessage({ text: 'привет' }), 'привет');
    assert.strictEqual(format.describeMessage({ text: '' }), '💬 Сообщение');
});

test('отображаемое имя собирается как buildName', () => {
    assert.strictEqual(format.buildName('Пётр', 'Петров', 'p'), 'Пётр Петров');
    assert.strictEqual(format.buildName('', '', 'ppetrov'), 'ppetrov');
    assert.strictEqual(format.buildName('Пётр', '', 'p'), 'Пётр');
});

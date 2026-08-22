/**
 * Шифрование текста сообщений — порт PISMO/Crypto.cs и Crypto.kt.
 *
 * Формат записи: "enc:v2:" + base64(nonce(12) ‖ tag(16) ‖ ciphertext),
 * AES-256-GCM. Легаси "enc:v1:" (AES-256-CBC, iv(16) ‖ ciphertext) читается,
 * но больше не пишется.
 *
 * ПРО ПОРЯДОК БАЙТ. .NET AesGcm отдаёт шифртекст и тег ОТДЕЛЬНО, и ПК
 * складывает их как nonce‖tag‖ct. Node (как и javax.crypto) держит тег
 * отдельным вызовом getAuthTag(), поэтому порядок задаём вручную — тег
 * ставится ПЕРЕД шифртекстом. Без этой перестановки расшифровка молча
 * падает на проверке тега, и сообщения с ПК выглядят на сайте как
 * «enc:v2:AAAA…».
 *
 * ПОЧЕМУ ЭТО ПРИШЛОСЬ ПЕРЕПИСАТЬ. Прежняя версия сайта умела только v1
 * (AES-CBC) и на любое сообщение с телефона или ПК показывала base64: они
 * пишут v2 с 2025 года. Обратно тоже ломалось не сразу — v1 клиенты ещё
 * читают, так что расхождение выглядело как «на сайте часть сообщений
 * нечитаема», а не как отказ.
 *
 * Ключ выводится из той же фразы, что на ПК. Менять её нельзя — иначе
 * перестанут читаться все ранее сохранённые сообщения.
 */
const crypto = require('crypto');

const PREFIX_V1 = 'enc:v1:';
const PREFIX_V2 = 'enc:v2:';
const NONCE_LEN = 12;
const TAG_LEN = 16;

const KEY = crypto
    .createHash('sha256')
    .update('PISMO::message::secret::v1::do-not-change', 'utf8')
    .digest();

/** Шифрует текст в формат ПК-версии. Пустая строка не трогается. */
function enc(plain) {
    if (plain === null || plain === undefined || plain === '') return plain ?? '';
    try {
        const nonce = crypto.randomBytes(NONCE_LEN);
        const cipher = crypto.createCipheriv('aes-256-gcm', KEY, nonce, {
            authTagLength: TAG_LEN,
        });
        const ct = Buffer.concat([
            cipher.update(String(plain), 'utf8'),
            cipher.final(),
        ]);
        const tag = cipher.getAuthTag();
        // Порядок .NET: nonce ‖ tag ‖ ciphertext.
        return PREFIX_V2 + Buffer.concat([nonce, tag, ct]).toString('base64');
    } catch (err) {
        console.error('[crypto] enc:', err.message);
        return plain;
    }
}

/** Расшифровывает, если текст зашифрован; иначе возвращает как есть. */
function dec(stored) {
    if (!stored || typeof stored !== 'string') return stored ?? '';

    if (stored.startsWith(PREFIX_V2)) {
        try {
            const data = Buffer.from(stored.slice(PREFIX_V2.length), 'base64');
            if (data.length < NONCE_LEN + TAG_LEN) return stored;

            const nonce = data.subarray(0, NONCE_LEN);
            const tag = data.subarray(NONCE_LEN, NONCE_LEN + TAG_LEN);
            const ct = data.subarray(NONCE_LEN + TAG_LEN);

            const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, nonce, {
                authTagLength: TAG_LEN,
            });
            decipher.setAuthTag(tag);
            return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
        } catch (_) {
            // Подмена или порча — не падаем, показываем как есть (как на ПК).
            return stored;
        }
    }

    if (stored.startsWith(PREFIX_V1)) {
        try {
            const data = Buffer.from(stored.slice(PREFIX_V1.length), 'base64');
            if (data.length <= 16) return stored;
            const decipher = crypto.createDecipheriv('aes-256-cbc', KEY, data.subarray(0, 16));
            return Buffer.concat([
                decipher.update(data.subarray(16)),
                decipher.final(),
            ]).toString('utf8');
        } catch (_) {
            return stored;
        }
    }

    return stored;
}

module.exports = { enc, dec, PREFIX_V1, PREFIX_V2 };

const crypto = require('crypto');

const PREFIX = 'enc:v1:';

// Тот же секрет и та же схема вывода ключа, что и в C#-клиенте.
// МЕНЯТЬ СТРОКУ НЕЛЬЗЯ — иначе старые сообщения перестанут расшифровываться.
const KEY = crypto
    .createHash('sha256')
    .update('PISMO::message::secret::v1::do-not-change', 'utf8')
    .digest(); // 32 байта -> AES-256

function enc(plain) {
    if (plain === null || plain === undefined || plain === '') return plain;
    try {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', KEY, iv);
        const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
        const combined = Buffer.concat([iv, ct]);
        return PREFIX + combined.toString('base64');
    } catch (err) {
        console.error('Crypto.enc error:', err);
        return plain;
    }
}

function dec(stored) {
    if (!stored || typeof stored !== 'string' || !stored.startsWith(PREFIX)) {
        return stored; // обычный/старый нешифрованный текст
    }
    try {
        const data = Buffer.from(stored.slice(PREFIX.length), 'base64');
        if (data.length <= 16) return stored;
        const iv = data.subarray(0, 16);
        const ct = data.subarray(16);
        const decipher = crypto.createDecipheriv('aes-256-cbc', KEY, iv);
        const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
        return pt.toString('utf8');
    } catch (err) {
        console.error('Crypto.dec error:', err);
        return stored;
    }
}

module.exports = { enc, dec };
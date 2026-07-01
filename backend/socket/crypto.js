const crypto = require('crypto');

// Ключ идентичен C# версии: SHA256("PISMO::message::secret::v1::do-not-change")
// Менять нельзя — все старые сообщения в БД зашифрованы именно этим ключом
const KEY = crypto.createHash('sha256')
    .update('PISMO::message::secret::v1::do-not-change')
    .digest();

const PREFIX = 'enc:v1:';

function encrypt(plain) {
    if (!plain) return plain;
    try {
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-cbc', KEY, iv);
        const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
        const combined = Buffer.concat([iv, encrypted]);
        return PREFIX + combined.toString('base64');
    } catch {
        return plain;
    }
}

function decrypt(stored) {
    if (!stored || !stored.startsWith(PREFIX)) return stored; // старый/нешифрованный текст
    try {
        const data = Buffer.from(stored.slice(PREFIX.length), 'base64');
        if (data.length <= 16) return stored;
        const iv = data.slice(0, 16);
        const ct = data.slice(16);
        const decipher = crypto.createDecipheriv('aes-256-cbc', KEY, iv);
        const decrypted = Buffer.concat([decipher.update(ct), decipher.final()]);
        return decrypted.toString('utf8');
    } catch {
        return stored; // если расшифровка не удалась — вернуть как есть
    }
}

module.exports = { encrypt, decrypt };
/**
 * Реакции на сообщения — порт ReactionsRepository.kt.
 *
 * ПРО COLLATE utf8mb4_bin. В utf8mb4_general_ci разные эмодзи сравниваются
 * как РАВНЫЕ, и без явной бинарной коллации тумблер реакции снимал чужую
 * реакцию другим эмодзи. Миграция 9 чинит колонку, но сравнение всё равно
 * задаётся в запросе — на базе, где миграцию не прокатили, иначе повторится
 * ровно тот же баг.
 */
const db = require('../db');
const { normalizeScope } = require('./scopes');

/** Довесок к WHERE, сравнивающий эмодзи побайтово. */
const EQ = ' AND emoji = CONVERT(? USING utf8mb4) COLLATE utf8mb4_bin';

/** Поставить/снять реакцию. Возвращает true, если после операции она стоит. */
async function toggle(userId, messageId, scope, emoji) {
    if (!messageId || messageId <= 0 || !emoji || !String(emoji).trim()) return false;
    const sc = normalizeScope(scope);
    try {
        const already = await db.exists(
            `SELECT 1 FROM message_reactions WHERE message_id=? AND scope=? AND user_id=?${EQ}`,
            [messageId, sc, userId, emoji],
        );
        if (already) {
            await db.exec(
                `DELETE FROM message_reactions WHERE message_id=? AND scope=? AND user_id=?${EQ}`,
                [messageId, sc, userId, emoji],
            );
            return false;
        }
        await db.exec(
            'INSERT IGNORE INTO message_reactions (message_id, scope, user_id, emoji) VALUES (?, ?, ?, ?)',
            [messageId, sc, userId, emoji],
        );
        return true;
    } catch (err) {
        console.warn('[реакции] toggle:', err.message);
        return false;
    }
}

/**
 * Реакции сразу для набора сообщений — один запрос на страницу ленты.
 * Возвращает Map<messageId, [{emoji, count, mine}]>.
 */
async function forMessages(userId, ids, scope) {
    if (!ids || ids.length === 0) return new Map();
    const sc = normalizeScope(scope);
    // id приходят из наших же выборок, но через parseInt всё равно
    // прогоняем: строка в списке IN — это дыра под инъекцию.
    const list = ids.map((n) => parseInt(n, 10)).filter(Number.isFinite).join(',');
    if (!list) return new Map();

    try {
        const rows = await db.query(
            'SELECT message_id, emoji COLLATE utf8mb4_bin AS emoji, COUNT(*) AS cnt, '
            + 'MAX(CASE WHEN user_id=? THEN 1 ELSE 0 END) AS mine '
            + `FROM message_reactions WHERE scope=? AND message_id IN (${list}) `
            + 'GROUP BY message_id, emoji COLLATE utf8mb4_bin ORDER BY MIN(created_at)',
            [userId, sc],
        );
        const out = new Map();
        for (const r of rows) {
            const key = r.message_id;
            if (!out.has(key)) out.set(key, []);
            out.get(key).push({
                emoji: String(r.emoji),
                count: Number(r.cnt),
                mine: Number(r.mine) === 1,
            });
        }
        return out;
    } catch (err) {
        console.warn('[реакции] forMessages:', err.message);
        return new Map();
    }
}

/** Набор быстрых реакций — тот же, что в панели ПК-версии. */
const QUICK = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👎'];

module.exports = { toggle, forMessages, QUICK };

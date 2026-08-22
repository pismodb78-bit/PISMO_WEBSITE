/**
 * Закреплённые сообщения — порт PinsRepository.kt.
 * Общая таблица pinned_messages со scope-разделением на ЛС/группы/каналы.
 */
const db = require('../db');
const { dec } = require('../utils/crypto');
const { buildName } = require('../utils/format');
const { normalizeScope, SCOPE } = require('./scopes');

async function isPinned(messageId, scope) {
    try {
        return await db.exists(
            'SELECT 1 FROM pinned_messages WHERE message_id=? AND scope=?',
            [messageId, normalizeScope(scope)],
        );
    } catch (_) {
        return false;
    }
}

/** Тумблер закрепа. true — после операции сообщение закреплено. */
async function toggle(userId, messageId, scope) {
    const sc = normalizeScope(scope);
    try {
        if (await isPinned(messageId, sc)) {
            await db.exec('DELETE FROM pinned_messages WHERE message_id=? AND scope=?', [messageId, sc]);
            return false;
        }
        await db.exec(
            'INSERT IGNORE INTO pinned_messages (message_id, scope, pinned_by) VALUES (?, ?, ?)',
            [messageId, sc, userId],
        );
        return true;
    } catch (err) {
        console.warn('[закрепы] toggle:', err.message);
        return false;
    }
}

/** Все закреплённые id в этой области — для пометки пузырей на странице. */
async function pinnedIds(scope) {
    try {
        const rows = await db.query(
            'SELECT message_id FROM pinned_messages WHERE scope=?',
            [normalizeScope(scope)],
        );
        return new Set(rows.map((r) => r.message_id));
    } catch (_) {
        return new Set();
    }
}

function mapPin(row) {
    return {
        messageId: row.id,
        sender: String(row.sender || '').trim() || row.login || '',
        text: dec(row.text),
    };
}

/** Закреплённые личного диалога. */
async function listDirect(me, partnerId) {
    try {
        const rows = await db.query(
            "SELECT m.id, m.text, TRIM(CONCAT(u.Name,' ',u.Surname)) AS sender, u.login "
            + 'FROM pinned_messages p JOIN messages m ON m.id = p.message_id '
            + 'JOIN users u ON u.id = m.sender_id '
            + 'WHERE p.scope=0 AND ((m.sender_id=? AND m.receiver_id=?) '
            + '                  OR (m.sender_id=? AND m.receiver_id=?)) '
            + 'ORDER BY p.pinned_at DESC',
            [me, partnerId, partnerId, me],
        );
        return rows.map(mapPin);
    } catch (_) {
        return [];
    }
}

async function listGroup(groupId) {
    try {
        const rows = await db.query(
            "SELECT gm.id, gm.text, TRIM(CONCAT(u.Name,' ',u.Surname)) AS sender, u.login "
            + 'FROM pinned_messages p JOIN group_messages gm ON gm.id = p.message_id '
            + 'JOIN users u ON u.id = gm.sender_id '
            + 'WHERE p.scope=1 AND gm.group_id=? ORDER BY p.pinned_at DESC',
            [groupId],
        );
        return rows.map(mapPin);
    } catch (_) {
        return [];
    }
}

async function listChannel(channelId) {
    try {
        const rows = await db.query(
            "SELECT sm.id, sm.text, TRIM(CONCAT(u.Name,' ',u.Surname)) AS sender, u.login "
            + 'FROM pinned_messages p JOIN server_messages sm ON sm.id = p.message_id '
            + 'JOIN users u ON u.id = sm.sender_id '
            + 'WHERE p.scope=2 AND sm.channel_id=? ORDER BY p.pinned_at DESC',
            [channelId],
        );
        return rows.map(mapPin);
    } catch (_) {
        return [];
    }
}

/** Закреплённые нужной области одним вызовом. */
async function listFor(scope, { me, partnerId, groupId, channelId }) {
    const sc = normalizeScope(scope);
    if (sc === SCOPE.GROUP) return listGroup(groupId);
    if (sc === SCOPE.SERVER) return listChannel(channelId);
    return listDirect(me, partnerId);
}

module.exports = { isPinned, toggle, pinnedIds, listDirect, listGroup, listChannel, listFor, buildName };

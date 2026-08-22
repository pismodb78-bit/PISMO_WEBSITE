/**
 * Звонки — порт CallRepository.kt.
 *
 * Сама медиа идёт через LiveKit мимо бэкенда; здесь только сессии в
 * call_sessions, по которым клиенты узнают о входящем вызове. Таблица
 * общая с ПК и Android, поэтому позвонить с сайта на телефон — это просто
 * строка со статусом 'ringing'.
 */
const db = require('../db');

/** Активная сессия с этим человеком, иначе -1. */
async function activeWith(me, peerId) {
    return db.scalarInt(
        "SELECT id FROM call_sessions WHERE ((caller_id=? AND callee_id=?) "
        + "OR (caller_id=? AND callee_id=?)) AND status IN ('ringing','active') "
        + 'ORDER BY id DESC LIMIT 1',
        [me, peerId, peerId, me], -1,
    ).catch(() => -1);
}

async function activeInGroup(groupId) {
    return db.scalarInt(
        "SELECT id FROM call_sessions WHERE group_id=? AND status IN ('ringing','active') "
        + 'ORDER BY id DESC LIMIT 1',
        [groupId], -1,
    ).catch(() => -1);
}

/** Создаёт сессию в статусе ringing. Возвращает её id. */
async function createCall(me, peerId, groupId, withVideo) {
    return db.insert(
        'INSERT INTO call_sessions (caller_id, callee_id, group_id, status, has_video) '
        + "VALUES (?, ?, ?, 'ringing', ?)",
        [me, peerId > 0 ? peerId : null, groupId >= 0 ? groupId : null, withVideo ? 1 : 0],
    );
}

/**
 * Входящие звонки: адресованные лично мне либо в группу, где я состою.
 *
 * Условия «новее последнего id» здесь намеренно НЕТ. На ПК от него
 * отказались с прямой пометкой «ненадёжный фильтр, часть звонков
 * пропускалась»: отметка уезжала вперёд на звонке, который так и не
 * показали, и следующие вызовы молча отсеивались.
 */
async function incomingCalls(me) {
    if (!me || me <= 0) return [];
    const sql = `
        SELECT cs.id, cs.caller_id, cs.has_video, cs.group_id, cs.callee_id,
               TRIM(CONCAT(u.Name,' ',u.Surname)) AS caller_name, u.login
        FROM call_sessions cs
        JOIN users u ON u.id = cs.caller_id
        LEFT JOIN group_members gm ON gm.group_id = cs.group_id AND gm.user_id = ?
        WHERE (cs.callee_id = ? OR gm.user_id = ?)
          AND cs.status = 'ringing'
          AND cs.caller_id <> ?
        ORDER BY cs.id ASC
    `;
    try {
        const rows = await db.query(sql, [me, me, me, me]);
        return rows.map((r) => ({
            id: r.id,
            callerId: r.caller_id,
            callerName: String(r.caller_name || '').trim() || r.login || '',
            calleeId: r.callee_id ?? null,
            groupId: r.group_id ?? null,
            status: 'ringing',
            hasVideo: Number(r.has_video) === 1,
        }));
    } catch (_) {
        return [];
    }
}

async function status(sessionId) {
    return db.scalar('SELECT status FROM call_sessions WHERE id=?', [sessionId], '') || '';
}

async function accept(sessionId) {
    await db.exec(
        "UPDATE call_sessions SET status='active', answered_at=NOW() WHERE id=?", [sessionId],
    ).catch(() => {});
}

async function reject(sessionId) {
    await db.exec(
        "UPDATE call_sessions SET status='rejected', ended_at=NOW() WHERE id=?", [sessionId],
    ).catch(() => {});
}

async function end(sessionId) {
    await db.exec(
        "UPDATE call_sessions SET status='ended', ended_at=NOW() "
        + "WHERE id=? AND status IN ('ringing','active')",
        [sessionId],
    ).catch(() => {});
}

async function join(sessionId, me) {
    await db.exec(
        'INSERT INTO call_participants (call_id, user_id, joined_at) VALUES (?, ?, NOW())',
        [sessionId, me],
    ).catch(() => {});
}

async function leave(sessionId, me) {
    await db.exec(
        'DELETE FROM call_participants WHERE call_id=? AND user_id=?', [sessionId, me],
    ).catch(() => {});
}

async function participantCount(sessionId) {
    return db.scalarInt(
        'SELECT COUNT(*) FROM call_participants WHERE call_id=?', [sessionId], 0,
    ).catch(() => 0);
}

/** Кому звонит эта сессия — чтобы разослать приглашение. */
async function sessionInfo(sessionId) {
    const row = await db.queryFirst(
        'SELECT id, caller_id, callee_id, group_id, status, has_video FROM call_sessions WHERE id=?',
        [sessionId],
    ).catch(() => null);
    if (!row) return null;
    return {
        id: row.id,
        callerId: row.caller_id,
        calleeId: row.callee_id ?? null,
        groupId: row.group_id ?? null,
        status: row.status,
        hasVideo: Number(row.has_video) === 1,
    };
}

module.exports = {
    activeWith, activeInGroup, createCall, incomingCalls, status,
    accept, reject, end, join, leave, participantCount, sessionInfo,
};

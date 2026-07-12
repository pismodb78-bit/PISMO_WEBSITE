const db = require('../db');
const { createCallToken, closeRoom, LIVEKIT_WS_URL } = require('../utils/livekit');

// Сколько секунд ждём ответа на личный звонок, прежде чем пометить его "пропущенным"
const RINGING_TIMEOUT_MS = 30_000;

// Таймеры "не ответили вовремя" по call_id, чтобы можно было их отменить при ответе/отмене
const ringingTimers = new Map();

function clearRingTimer(callId) {
    const t = ringingTimers.get(callId);
    if (t) {
        clearTimeout(t);
        ringingTimers.delete(callId);
    }
}

module.exports = (io, socket) => {
    const userId = socket.userId;

    async function getUserDisplayName(uid) {
        const [rows] = await db.execute('SELECT Name, Surname, login FROM users WHERE id = ?', [uid]);
        if (!rows.length) return `user_${uid}`;
        const u = rows[0];
        return u.Name ? `${u.Name} ${u.Surname || ''}`.trim() : u.login;
    }

    // ── Начать звонок: либо личный (calleeId), либо групповой (groupId) ──
    socket.on('call:invite', async ({ calleeId, groupId, hasVideo }, cb) => {
        try {
            if (!calleeId && !groupId) return cb?.({ ok: false, error: 'NO_TARGET' });

            // Групповой звонок: если в этой группе уже идёт активный звонок —
            // просто подключаем инициатора к нему же, а не создаём новый (как голосовой канал в Discord)
            if (groupId) {
                const [active] = await db.execute(
                    `SELECT id, room_name FROM calls WHERE group_id = ? AND status = 'active' LIMIT 1`,
                    [groupId]
                );
                if (active.length) {
                    return joinExistingCall(active[0].id, active[0].room_name, cb);
                }
            }

            const roomName = `call_${Date.now()}_${userId}`;
            const [result] = await db.execute(
                `INSERT INTO calls (caller_id, callee_id, group_id, room_name, status, has_video, created_at)
         VALUES (?, ?, ?, ?, 'ringing', ?, NOW())`,
                [userId, calleeId || null, groupId || null, roomName, hasVideo ? 1 : 0]
            );
            const callId = result.insertId;

            await db.execute(
                'INSERT INTO call_participants (call_id, user_id, joined_at) VALUES (?, ?, NOW())',
                [callId, userId]
            );

            const callerName = await getUserDisplayName(userId);
            const token = await createCallToken({ roomName, userId, displayName: callerName });

            const payload = {
                callId,
                roomName,
                callerId: userId,
                callerName,
                hasVideo: !!hasVideo,
                isGroup: !!groupId,
                groupId: groupId || null
            };

            if (calleeId) {
                io.to(`user_${calleeId}`).emit('call:incoming', payload);
                // Автоотмена, если за RINGING_TIMEOUT_MS никто не взял трубку
                const timer = setTimeout(() => autoMissCall(callId, calleeId), RINGING_TIMEOUT_MS);
                ringingTimers.set(callId, timer);
            } else {
                const [members] = await db.execute(
                    'SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?',
                    [groupId, userId]
                );
                members.forEach(m => io.to(`user_${m.user_id}`).emit('call:incoming', payload));
            }

            socket.join(`call_signal_${callId}`);
            cb?.({ ok: true, callId, roomName, token, livekitUrl: LIVEKIT_WS_URL });
        } catch (err) {
            console.error('call:invite', err);
            cb?.({ ok: false, error: 'DB_ERROR' });
        }
    });

    async function autoMissCall(callId, calleeId) {
        try {
            const [rows] = await db.execute('SELECT status FROM calls WHERE id = ?', [callId]);
            if (!rows.length || rows[0].status !== 'ringing') return; // уже ответили/отменили

            await db.execute(`UPDATE calls SET status = 'missed', ended_at = NOW() WHERE id = ?`, [callId]);
            io.to(`call_signal_${callId}`).emit('call:missed', { callId });
            io.to(`user_${calleeId}`).emit('call:missed', { callId });
            ringingTimers.delete(callId);
        } catch (err) {
            console.error('autoMissCall', err);
        }
    }

    async function joinExistingCall(callId, roomName, cb) {
        const [existing] = await db.execute(
            'SELECT id FROM call_participants WHERE call_id = ? AND user_id = ? AND left_at IS NULL',
            [callId, userId]
        );
        if (!existing.length) {
            await db.execute(
                'INSERT INTO call_participants (call_id, user_id, joined_at) VALUES (?, ?, NOW())',
                [callId, userId]
            );
        }
        const displayName = await getUserDisplayName(userId);
        const token = await createCallToken({ roomName, userId, displayName });

        socket.join(`call_signal_${callId}`);
        socket.to(`call_signal_${callId}`).emit('call:participant_joined', { callId, userId, displayName });

        cb?.({ ok: true, callId, roomName, token, livekitUrl: LIVEKIT_WS_URL, alreadyActive: true });
    }

    // ── Принять входящий звонок ──
    socket.on('call:accept', async ({ callId }, cb) => {
        try {
            const [rows] = await db.execute('SELECT * FROM calls WHERE id = ?', [callId]);
            if (!rows.length) return cb?.({ ok: false, error: 'NOT_FOUND' });
            const call = rows[0];

            if (call.status === 'ended' || call.status === 'declined' || call.status === 'missed') {
                return cb?.({ ok: false, error: 'CALL_CLOSED' });
            }

            clearRingTimer(callId);

            if (call.status === 'ringing') {
                await db.execute(`UPDATE calls SET status = 'active', answered_at = NOW() WHERE id = ?`, [callId]);
            }

            const [existing] = await db.execute(
                'SELECT id FROM call_participants WHERE call_id = ? AND user_id = ? AND left_at IS NULL',
                [callId, userId]
            );
            if (!existing.length) {
                await db.execute(
                    'INSERT INTO call_participants (call_id, user_id, joined_at) VALUES (?, ?, NOW())',
                    [callId, userId]
                );
            }

            const displayName = await getUserDisplayName(userId);
            const token = await createCallToken({ roomName: call.room_name, userId, displayName });

            socket.join(`call_signal_${callId}`);
            io.to(`call_signal_${callId}`).emit('call:accepted', { callId, userId, displayName });

            cb?.({ ok: true, callId, roomName: call.room_name, token, livekitUrl: LIVEKIT_WS_URL });
        } catch (err) {
            console.error('call:accept', err);
            cb?.({ ok: false, error: 'DB_ERROR' });
        }
    });

    // ── Отклонить входящий личный звонок ──
    socket.on('call:decline', async ({ callId }, cb) => {
        try {
            clearRingTimer(callId);
            await db.execute(`UPDATE calls SET status = 'declined', ended_at = NOW() WHERE id = ?`, [callId]);
            io.to(`call_signal_${callId}`).emit('call:declined', { callId, userId });
            cb?.({ ok: true });
        } catch (err) {
            console.error('call:decline', err);
            cb?.({ ok: false, error: 'DB_ERROR' });
        }
    });

    // ── Выйти из звонка (для себя) ──
    socket.on('call:leave', async ({ callId }, cb) => {
        try {
            await leaveCall(callId, userId);
            cb?.({ ok: true });
        } catch (err) {
            console.error('call:leave', err);
            cb?.({ ok: false, error: 'DB_ERROR' });
        }
    });

    async function leaveCall(callId, uid) {
        await db.execute(
            'UPDATE call_participants SET left_at = NOW() WHERE call_id = ? AND user_id = ? AND left_at IS NULL',
            [callId, uid]
        );

        io.to(`call_signal_${callId}`).emit('call:participant_left', { callId, userId: uid });

        const [remaining] = await db.execute(
            'SELECT COUNT(*) AS cnt FROM call_participants WHERE call_id = ? AND left_at IS NULL',
            [callId]
        );

        if (remaining[0].cnt === 0) {
            const [rows] = await db.execute('SELECT room_name FROM calls WHERE id = ?', [callId]);
            await db.execute(`UPDATE calls SET status = 'ended', ended_at = NOW() WHERE id = ?`, [callId]);
            io.to(`call_signal_${callId}`).emit('call:ended', { callId });
            if (rows.length) await closeRoom(rows[0].room_name);
        }

        socket.leave(`call_signal_${callId}`);
    }

    // ── Узнать, идёт ли сейчас активный звонок в группе (показать "Присоединиться") ──
    socket.on('call:group_status', async ({ groupId }, cb) => {
        try {
            const [rows] = await db.execute(
                `SELECT c.id AS callId, c.room_name, c.has_video,
                COUNT(cp.id) AS participant_count
         FROM calls c
         LEFT JOIN call_participants cp ON cp.call_id = c.id AND cp.left_at IS NULL
         WHERE c.group_id = ? AND c.status = 'active'
         GROUP BY c.id`,
                [groupId]
            );
            cb?.({ ok: true, active: rows[0] || null });
        } catch (err) {
            console.error('call:group_status', err);
            cb?.({ ok: false, error: 'DB_ERROR' });
        }
    });

    // ── Если человек резко закрыл вкладку/отвалился по сети посреди звонка ──
    socket.on('disconnect', async () => {
        try {
            const [rows] = await db.execute(
                'SELECT call_id FROM call_participants WHERE user_id = ? AND left_at IS NULL',
                [userId]
            );
            for (const row of rows) {
                await leaveCall(row.call_id, userId);
            }
        } catch (err) {
            console.error('call disconnect cleanup', err);
        }
    });
};
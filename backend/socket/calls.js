/**
 * Звонки: личные, групповые и голосовые каналы.
 *
 * Медиа идёт через LiveKit напрямую из браузера — бэкенд только заводит
 * сессию в call_sessions и выдаёт токен. Благодаря общей таблице и общему
 * имени комнаты звонок с сайта приходит на ПК и на телефон обычным
 * входящим: они опрашивают ту же call_sessions.
 *
 * ВАЖНО ПРО КОМНАТУ И IDENTITY — см. utils/livekit.js. Имя комнаты
 * "call_<id сессии>", identity — id пользователя строкой. Разойдись хоть
 * одно, звонок «идёт», но участники не видят друг друга.
 */
const calls = require('../data/calls');
const { toWire } = require('../utils/wire');
const social = require('../data/social');
const livekit = require('../utils/livekit');

function reply(cb, promise, label) {
    if (typeof cb !== 'function') return promise.catch(() => {});
    return promise
        // toWire: наружу не должен уйти ни один буфер — в браузере он
        // становится ArrayBuffer и роняет отрисовку. См. utils/wire.js.
        .then((data) => cb({ ok: true, ...toWire(data || {}) }))
        .catch((err) => {
            console.error(`[сокет:${label}]`, err.message);
            cb({ ok: false, error: err.message || 'Ошибка' });
        });
}

module.exports = function registerCalls(io, socket) {
    const me = socket.userId;

    /** Токен на комнату звонка — выдаётся только участнику сессии. */
    async function tokenForSession(sessionId) {
        const info = await calls.sessionInfo(sessionId);
        if (!info) throw new Error('Звонок не найден');

        const allowed = info.callerId === me
            || info.calleeId === me
            || (info.groupId !== null && await social.isGroupMember(info.groupId, me));
        if (!allowed) throw new Error('Вы не участник этого звонка');

        const room = livekit.roomForCall(sessionId);
        return {
            callId: sessionId,
            room,
            url: livekit.url,
            token: livekit.createToken(room, me, socket.userName),
            hasVideo: info.hasVideo,
        };
    }

    // ── Исходящий вызов ───────────────────────────────────────────────

    socket.on('call:invite', ({ calleeId, groupId, hasVideo } = {}, cb) => reply(cb, (async () => {
        if (!livekit.isConfigured()) throw new Error('Звонки не настроены');

        const isGroup = groupId !== undefined && groupId !== null && groupId >= 0;
        if (!isGroup && !calleeId) throw new Error('Не указан собеседник');

        if (isGroup && !(await social.isGroupMember(groupId, me))) {
            throw new Error('Вы не участник группы');
        }

        // Уже идущий звонок переиспользуем, а не заводим второй: иначе на
        // той стороне звонит дважды, а комнаты получаются разные.
        let callId = isGroup
            ? await calls.activeInGroup(groupId)
            : await calls.activeWith(me, calleeId);

        if (callId <= 0) {
            callId = await calls.createCall(me, isGroup ? 0 : calleeId, isGroup ? groupId : -1, hasVideo);
            if (!callId) throw new Error('Не удалось начать звонок');
        }

        await calls.join(callId, me);

        const payload = {
            callId,
            callerId: me,
            callerName: socket.userName,
            groupId: isGroup ? groupId : null,
            hasVideo: Boolean(hasVideo),
        };
        if (isGroup) {
            const members = await social.groupMembers(groupId);
            for (const m of members) {
                if (m.userId !== me) io.to(`user_${m.userId}`).emit('call:incoming', payload);
            }
        } else {
            io.to(`user_${calleeId}`).emit('call:incoming', payload);
        }

        return tokenForSession(callId);
    })(), 'call:invite'));

    // ── Приём и отказ ─────────────────────────────────────────────────

    socket.on('call:accept', ({ callId } = {}, cb) => reply(cb, (async () => {
        const info = await calls.sessionInfo(callId);
        if (!info) throw new Error('Звонок не найден');
        if (info.status === 'ended' || info.status === 'rejected') {
            throw new Error('Звонок уже завершён');
        }
        await calls.accept(callId);
        await calls.join(callId, me);

        io.to(`user_${info.callerId}`).emit('call:accepted', {
            callId, userId: me, userName: socket.userName,
        });
        return tokenForSession(callId);
    })(), 'call:accept'));

    socket.on('call:decline', ({ callId } = {}, cb) => reply(cb, (async () => {
        const info = await calls.sessionInfo(callId);
        await calls.reject(callId);
        if (info) {
            io.to(`user_${info.callerId}`).emit('call:declined', { callId, userId: me });
        }
        return {};
    })(), 'call:decline'));

    socket.on('call:leave', ({ callId } = {}, cb) => reply(cb, (async () => {
        await calls.leave(callId, me);
        const left = await calls.participantCount(callId);
        const info = await calls.sessionInfo(callId);

        // Последний вышел — закрываем сессию, иначе она вечно висит
        // «активной» и следующий вызов переиспользует мёртвую комнату.
        if (left <= 0) {
            await calls.end(callId);
            if (info) {
                const targets = [info.callerId, info.calleeId].filter(Boolean);
                for (const uid of targets) io.to(`user_${uid}`).emit('call:ended', { callId });
                if (info.groupId !== null) {
                    io.to(`group_${info.groupId}`).emit('call:ended', { callId });
                }
            }
        } else if (info) {
            const targets = [info.callerId, info.calleeId].filter(Boolean);
            for (const uid of targets) {
                io.to(`user_${uid}`).emit('call:participant_left', { callId, userId: me });
            }
        }
        return {};
    })(), 'call:leave'));

    socket.on('call:end', ({ callId } = {}, cb) => reply(cb, (async () => {
        const info = await calls.sessionInfo(callId);
        if (!info) return {};
        if (info.callerId !== me && info.calleeId !== me) {
            throw new Error('Вы не участник этого звонка');
        }
        await calls.end(callId);
        const targets = [info.callerId, info.calleeId].filter(Boolean);
        for (const uid of targets) io.to(`user_${uid}`).emit('call:ended', { callId });
        if (info.groupId !== null) io.to(`group_${info.groupId}`).emit('call:ended', { callId });
        return {};
    })(), 'call:end'));

    /**
     * Опрос входящих — тот же запрос, которым живут ПК и Android.
     *
     * Нужен вдобавок к событию call:incoming: позвонить могут с телефона,
     * а телефон о нашем сокете ничего не знает — он просто пишет строку в
     * call_sessions. Без опроса такой вызов на сайте не появился бы вовсе.
     */
    socket.on('call:poll', (_p, cb) => reply(cb, (async () => ({
        calls: await calls.incomingCalls(me),
    }))(), 'call:poll'));

    socket.on('call:status', ({ callId } = {}, cb) => reply(cb, (async () => ({
        status: await calls.status(callId),
    }))(), 'call:status'));

    /** Перевыпуск токена — на случай, если звонок пережил его TTL. */
    socket.on('call:token', ({ callId } = {}, cb) => reply(cb, tokenForSession(callId), 'call:token'));
};

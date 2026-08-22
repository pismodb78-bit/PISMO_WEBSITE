/**
 * Живая доставка — опрос базы на стороне сайта.
 *
 * ЗАЧЕМ ЭТО НУЖНО, ХОТЯ ЕСТЬ СОКЕТ. События сокета возникают только тогда,
 * когда пишут ЧЕРЕЗ САЙТ. ПК-клиент и Android пишут напрямую в MySQL — про
 * наш сокет они не знают вовсе, — поэтому их сообщения на сайте не
 * появлялись до перезагрузки страницы. Выглядело это как «вебсокет не
 * работает», хотя сокет исправен: ему просто нечего было слать.
 *
 * Единственный общий для всех клиентов источник правды — сама база.
 * Поэтому здесь тот же приём, что в PollingService на Android и в опросе
 * на ПК: раз в 2.5 секунды смотрим, не появилось ли строк новее известных,
 * и раскладываем их по комнатам сокета.
 *
 * ЦЕНА ВОПРОСА. Опрос ОДИН на весь сайт, а не по одному на пользователя:
 * три запроса за такт независимо от того, десять человек онлайн или сто.
 * Каждый клиент ПК делает столько же запросов сам по себе, так что нагрузка
 * не растёт — наоборот, десять вкладок сайта дешевле десяти ПК-клиентов.
 *
 * Отметки (последние известные id) держим в памяти и инициализируем
 * максимумами при старте: иначе первый же проход вывалил бы в эфир всю
 * историю переписки.
 */
const db = require('./db');
const { dec } = require('./utils/crypto');
const { describeMessage, withSender } = require('./utils/format');
const { SCOPE } = require('./data/scopes');
const { toWire } = require('./utils/wire');

/** Такт опроса — тот же, что у ПК-клиента. */
const POLL_MS = Number(process.env.LIVE_POLL_MS) || 2500;

/**
 * Потолок на один проход. Если сайт постоял выключенным, в базе успевает
 * накопиться много: без предела первый же тик собрал бы всё разом и
 * попытался разослать. Лишнее подтянется следующими тиками.
 */
const BATCH = 200;

const state = {
    dmId: 0,
    groupId: 0,
    serverId: 0,
    started: false,
    hasReplyCol: null,
};

/** Кто сейчас на сайте: id → есть ли хоть один живой сокет. */
function onlineUsers(io) {
    const ids = new Set();
    for (const room of io.sockets.adapter.rooms.keys()) {
        if (room.startsWith('user_')) {
            const id = parseInt(room.slice(5), 10);
            if (Number.isFinite(id)) ids.add(id);
        }
    }
    return ids;
}

function mapRow(row, scope) {
    return {
        id: row.id,
        senderId: row.sender_id,
        senderName: String(row.sender_name || '').trim() || row.login || '',
        text: dec(row.text),
        createdAtMs: Number(row.created_ts) * 1000,
        replyToId: Number(row.reply_to_id) || 0,
        isDeleted: Number(row.is_deleted) === 1,
        isEdited: row.edited_at !== null && row.edited_at !== undefined,
        hasImage: Number(row.has_img) === 1,
        hasAudio: Number(row.has_audio) === 1,
        hasVideo: Number(row.has_video) === 1,
        hasFile: Number(row.has_file) === 1,
        fileName: row.file_name ?? null,
        scope,
        isRead: row.is_read === undefined ? true : Number(row.is_read) === 1,
        reactions: [],
        isPinned: false,
    };
}

const MEDIA_FLAGS = `
    (%s.image_data IS NOT NULL) AS has_img,
    (%s.audio_data IS NOT NULL) AS has_audio,
    (%s.video_data IS NOT NULL) AS has_video,
    (%s.file_data  IS NOT NULL) AS has_file`;

function flagsFor(alias) {
    return MEDIA_FLAGS.split('%s').join(alias);
}

// ── Личные сообщения ───────────────────────────────────────────────────

async function pollDirect(io, online) {
    const rows = await db.query(
        `SELECT m.id, m.sender_id, m.receiver_id, m.text, m.file_name, m.reply_to_id,
                m.is_deleted, m.edited_at, m.is_read,
                UNIX_TIMESTAMP(m.created_at) AS created_ts,
                TRIM(CONCAT(u.Name,' ',u.Surname)) AS sender_name, u.login,
                ${flagsFor('m')}
         FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.id > ? ORDER BY m.id LIMIT ${BATCH}`,
        [state.dmId],
    );
    if (rows.length === 0) return;
    state.dmId = rows[rows.length - 1].id;

    for (const row of rows) {
        const msg = mapRow(row, SCOPE.DM);
        const preview = withSender(msg.senderName, describeMessage(msg));

        // Получателю — как сообщение от отправителя; отправителю (другое
        // его устройство или вторая вкладка) — как сообщение в тот же диалог.
        if (online.has(row.receiver_id)) {
            io.to(`user_${row.receiver_id}`).emit('message:new', toWire({
                scope: SCOPE.DM, peerId: row.sender_id, message: msg,
            }));
            io.to(`user_${row.receiver_id}`).emit('chat:list_update', {
                partnerId: row.sender_id, preview,
            });
        }
        if (online.has(row.sender_id)) {
            io.to(`user_${row.sender_id}`).emit('message:new', toWire({
                scope: SCOPE.DM, peerId: row.receiver_id, message: msg,
            }));
        }
    }
}

// ── Группы ─────────────────────────────────────────────────────────────

async function pollGroups(io, online) {
    const rows = await db.query(
        `SELECT gm.id, gm.group_id, gm.sender_id, gm.text, gm.file_name, gm.reply_to_id,
                gm.is_deleted, gm.edited_at,
                UNIX_TIMESTAMP(gm.created_at) AS created_ts,
                TRIM(CONCAT(u.Name,' ',u.Surname)) AS sender_name, u.login,
                ${flagsFor('gm')}
         FROM group_messages gm JOIN users u ON u.id = gm.sender_id
         WHERE gm.id > ? ORDER BY gm.id LIMIT ${BATCH}`,
        [state.groupId],
    );
    if (rows.length === 0) return;
    state.groupId = rows[rows.length - 1].id;

    // Состав групп спрашиваем один раз на проход, а не на каждое сообщение.
    const groupIds = [...new Set(rows.map((r) => r.group_id))];
    const members = new Map();
    if (groupIds.length) {
        const list = groupIds.map((n) => parseInt(n, 10)).filter(Number.isFinite).join(',');
        const memberRows = await db.query(
            `SELECT group_id, user_id FROM group_members WHERE group_id IN (${list})`,
        ).catch(() => []);
        for (const m of memberRows) {
            if (!members.has(m.group_id)) members.set(m.group_id, []);
            members.get(m.group_id).push(m.user_id);
        }
    }

    for (const row of rows) {
        const msg = mapRow(row, SCOPE.GROUP);
        const preview = withSender(msg.senderName, describeMessage(msg));

        io.to(`group_${row.group_id}`).emit('message:new', toWire({
            scope: SCOPE.GROUP, peerId: row.group_id, message: msg,
        }));

        for (const uid of members.get(row.group_id) || []) {
            if (uid === row.sender_id || !online.has(uid)) continue;
            io.to(`user_${uid}`).emit('group:list_update', { groupId: row.group_id, preview });
        }
    }
}

// ── Каналы серверов ────────────────────────────────────────────────────

async function pollChannels(io, online) {
    if (state.hasReplyCol === null) {
        state.hasReplyCol = await db.columnExists('server_messages', 'reply_to_id').catch(() => false);
    }
    const replyCol = state.hasReplyCol ? 'sm.reply_to_id,' : '0 AS reply_to_id,';

    const rows = await db.query(
        `SELECT sm.id, sm.channel_id, sm.sender_id, sm.text, sm.file_name, ${replyCol}
                UNIX_TIMESTAMP(sm.created_at) AS created_ts,
                TRIM(CONCAT(u.Name,' ',u.Surname)) AS sender_name, u.login,
                sc.server_id, sc.name AS channel_name,
                ${flagsFor('sm')}
         FROM server_messages sm
         JOIN users u ON u.id = sm.sender_id
         JOIN server_channels sc ON sc.id = sm.channel_id
         WHERE sm.id > ? ORDER BY sm.id LIMIT ${BATCH}`,
        [state.serverId],
    );
    if (rows.length === 0) return;
    state.serverId = rows[rows.length - 1].id;

    // Кто получит уведомление: участники сервера, не заглушившие его.
    const serverIds = [...new Set(rows.map((r) => r.server_id))];
    const audience = new Map();
    if (serverIds.length) {
        const list = serverIds.map((n) => parseInt(n, 10)).filter(Number.isFinite).join(',');
        const memberRows = await db.query(
            `SELECT server_id, user_id, muted_notifs FROM server_members WHERE server_id IN (${list})`,
        ).catch(() => []);
        for (const m of memberRows) {
            if (!audience.has(m.server_id)) audience.set(m.server_id, []);
            audience.get(m.server_id).push({ userId: m.user_id, muted: Number(m.muted_notifs) === 1 });
        }
    }

    // Кого упомянули — берём из server_mentions одним запросом на проход.
    const mentioned = new Map();
    if (await db.tableExists('server_mentions').catch(() => false)) {
        const ids = rows.map((r) => parseInt(r.id, 10)).filter(Number.isFinite).join(',');
        const rowsM = await db.query(
            `SELECT message_id, user_id FROM server_mentions WHERE message_id IN (${ids})`,
        ).catch(() => []);
        for (const m of rowsM) {
            if (!mentioned.has(m.message_id)) mentioned.set(m.message_id, new Set());
            mentioned.get(m.message_id).add(m.user_id);
        }
    }

    for (const row of rows) {
        const msg = mapRow(row, SCOPE.SERVER);
        const preview = withSender(msg.senderName, describeMessage(msg));

        io.to(`channel_${row.channel_id}`).emit('message:new', toWire({
            scope: SCOPE.SERVER, peerId: row.channel_id, message: msg,
        }));
        io.to(`server_${row.server_id}`).emit('badges:changed', {
            serverId: row.server_id, channelId: row.channel_id,
        });

        const forMe = mentioned.get(row.id);
        for (const member of audience.get(row.server_id) || []) {
            if (member.userId === row.sender_id || !online.has(member.userId)) continue;
            // Заглушённый сервер молчит — как на ПК и Android.
            if (member.muted) continue;
            io.to(`user_${member.userId}`).emit('channel:activity', {
                serverId: row.server_id,
                channelId: row.channel_id,
                channelName: row.channel_name || 'Канал',
                preview,
                mention: Boolean(forMe && forMe.has(member.userId)),
            });
        }
    }
}

// ── Входящие звонки ────────────────────────────────────────────────────

/** Какие звонки кому уже отдавали — чтобы не звенеть каждые 2.5 секунды. */
const announcedCalls = new Map();

async function pollCalls(io, online) {
    if (online.size === 0) return;
    const list = [...online].join(',');

    const rows = await db.query(
        `SELECT cs.id, cs.caller_id, cs.callee_id, cs.group_id, cs.has_video,
                TRIM(CONCAT(u.Name,' ',u.Surname)) AS caller_name, u.login,
                gm.user_id AS group_member
         FROM call_sessions cs
         JOIN users u ON u.id = cs.caller_id
         LEFT JOIN group_members gm ON gm.group_id = cs.group_id AND gm.user_id IN (${list})
         WHERE cs.status = 'ringing'
           AND (cs.callee_id IN (${list}) OR gm.user_id IS NOT NULL)`,
    ).catch(() => []);

    const stillRinging = new Set();

    for (const row of rows) {
        const target = row.callee_id && online.has(row.callee_id) ? row.callee_id : row.group_member;
        if (!target || target === row.caller_id) continue;

        const key = `${row.id}:${target}`;
        stillRinging.add(key);
        if (announcedCalls.has(key)) continue;
        announcedCalls.set(key, Date.now());

        io.to(`user_${target}`).emit('call:incoming', {
            callId: row.id,
            callerId: row.caller_id,
            callerName: String(row.caller_name || '').trim() || row.login || '',
            groupId: row.group_id ?? null,
            hasVideo: Number(row.has_video) === 1,
        });
    }

    // Звонок отзвонил — снимаем отметку и говорим клиенту убрать плашку.
    for (const key of [...announcedCalls.keys()]) {
        if (stillRinging.has(key)) continue;
        announcedCalls.delete(key);
        const [callId, userId] = key.split(':');
        io.to(`user_${userId}`).emit('call:ended', { callId: Number(callId) });
    }
}

// ── Цикл ───────────────────────────────────────────────────────────────

async function tick(io) {
    const online = onlineUsers(io);
    // Никого нет — базу не трогаем вовсе.
    if (online.size === 0) return;

    await pollDirect(io, online);
    await pollGroups(io, online);
    await pollChannels(io, online);
    await pollCalls(io, online);
}

/** Стартовые отметки — текущие максимумы, иначе первый тик вывалит всю историю. */
async function initBaseline() {
    state.dmId = await db.scalarInt('SELECT MAX(id) FROM messages', [], 0).catch(() => 0);
    state.groupId = await db.scalarInt('SELECT MAX(id) FROM group_messages', [], 0).catch(() => 0);
    state.serverId = await db.scalarInt('SELECT MAX(id) FROM server_messages', [], 0).catch(() => 0);
}

/**
 * Запускает опрос. Базу может не быть видно в момент старта — тогда
 * отметки останутся нулевыми, и мы попробуем взять их снова на первом
 * удачном такте, а не вывалим всю переписку разом.
 */
function start(io) {
    if (state.started) return;
    state.started = true;

    let baselineReady = false;
    const ensureBaseline = async () => {
        if (baselineReady) return true;
        try {
            await initBaseline();
            baselineReady = true;
            console.log(
                `[живая доставка] опрос каждые ${POLL_MS} мс; отметки: `
                + `лс=${state.dmId}, группы=${state.groupId}, каналы=${state.serverId}`,
            );
            return true;
        } catch (_) {
            return false;
        }
    };

    let running = false;
    setInterval(async () => {
        // Проход длиннее такта не должен наслаиваться сам на себя.
        if (running) return;
        running = true;
        try {
            if (await ensureBaseline()) await tick(io);
        } catch (err) {
            console.warn('[живая доставка]', err.message);
        } finally {
            running = false;
        }
    }, POLL_MS).unref();
}

module.exports = {
    start,
    POLL_MS,
    // Для тестов: один проход без таймера и доступ к отметкам.
    _tick: tick,
    _state: state,
};

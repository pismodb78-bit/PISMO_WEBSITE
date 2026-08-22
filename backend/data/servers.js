/**
 * Серверы, каналы, роли, баны и сообщения каналов — порт
 * ServerRepository.kt (он же ServersForm.cs и ServerReads.cs на ПК).
 *
 * Схема необязательных колонок (reply_to_id, is_deleted, can_channels,
 * user_limit) проверяется в рантайме: на части баз миграции не применены —
 * у учётной записи приложения нет прав на ALTER, — и жёсткая ссылка на
 * отсутствующую колонку роняла бы весь запрос. На ПК это ровно так и
 * ломалось.
 */
const db = require('../db');
const { enc, dec } = require('../utils/crypto');
const { mentionTokens, ALL_TOKENS, describeMessage, withSender } = require('../utils/format');
const { SCOPE } = require('./scopes');
const { uploadFileData } = require('./messages');

/** Право на управление каналами хранится отдельно от общего управления. */
let channelsColumnOk = true;

// ════════════════════════════════════════════════════════════════════
//  СЕРВЕРЫ
// ════════════════════════════════════════════════════════════════════

async function myServers(me) {
    const rows = await db.query(
        'SELECT s.id, s.name, s.owner_id FROM servers s '
        + 'JOIN server_members m ON m.server_id=s.id WHERE m.user_id=? ORDER BY s.id',
        [me],
    );
    return rows.map((r) => ({
        id: r.id, name: r.name || '', ownerId: r.owner_id, unread: 0, mentions: 0,
    }));
}

/** Создаёт сервер с каналами по умолчанию — теми же, что на ПК. */
async function createServer(me, name) {
    const serverId = await db.insert('INSERT INTO servers (name, owner_id) VALUES (?,?)', [name, me]);
    if (serverId <= 0) return 0;
    await db.exec('INSERT INTO server_members (server_id, user_id) VALUES (?,?)', [serverId, me]);
    await db.exec(
        "INSERT INTO server_channels (server_id,name,type,position) "
        + "VALUES (?,'основной','text',0),(?,'Общий','voice',1)",
        [serverId, serverId],
    );
    return serverId;
}

/** Возвращает {status:'ok'|'banned'|'not_found', name}. */
async function joinServer(me, serverId) {
    const banned = await db.exists(
        'SELECT 1 FROM server_bans WHERE server_id=? AND user_id=?', [serverId, me],
    ).catch(() => false);
    if (banned) return { status: 'banned' };

    const name = await db.scalar('SELECT name FROM servers WHERE id=?', [serverId], null);
    if (name === null) return { status: 'not_found' };

    await db.exec('INSERT IGNORE INTO server_members (server_id,user_id) VALUES (?,?)', [serverId, me]);
    return { status: 'ok', name };
}

async function leaveServer(me, serverId) {
    await db.exec('DELETE FROM server_members WHERE server_id=? AND user_id=?', [serverId, me]);
}

async function serverInfo(serverId) {
    const row = await db.queryFirst('SELECT name, owner_id FROM servers WHERE id=?', [serverId]);
    return row ? { name: row.name || '', ownerId: row.owner_id } : null;
}

async function renameServer(serverId, name) {
    await db.exec('UPDATE servers SET name=? WHERE id=?', [String(name).trim(), serverId]).catch(() => {});
}

async function deleteServer(serverId) {
    const swallow = () => {};
    await db.exec(
        'DELETE FROM server_messages WHERE channel_id IN '
        + '(SELECT id FROM server_channels WHERE server_id=?)', [serverId],
    ).catch(swallow);
    await db.exec('DELETE FROM server_channels WHERE server_id=?', [serverId]).catch(swallow);
    await db.exec('DELETE FROM server_members WHERE server_id=?', [serverId]).catch(swallow);
    await db.exec('DELETE FROM server_roles WHERE server_id=?', [serverId]).catch(swallow);
    await db.exec('DELETE FROM server_bans WHERE server_id=?', [serverId]).catch(swallow);
    await db.exec('DELETE FROM servers WHERE id=?', [serverId]);
}

// ════════════════════════════════════════════════════════════════════
//  ПРАВА
// ════════════════════════════════════════════════════════════════════

/**
 * Права текущего пользователя на сервере.
 *
 * Колонка can_channels появилась позже (миграция 16). На базе, где её ещё
 * нет, запрос с ней падает целиком — и человек остаётся ВООБЩЕ без прав.
 * Поэтому первая попытка с колонкой, вторая без; тот же приём, что на ПК.
 */
async function permissions(me, serverId) {
    const ownerId = await db.scalarInt('SELECT owner_id FROM servers WHERE id=?', [serverId], -1);
    const isOwner = ownerId === me;

    for (let attempt = 0; attempt < 2; attempt += 1) {
        const withChan = channelsColumnOk;
        try {
            // eslint-disable-next-line no-await-in-loop
            const row = await db.queryFirst(
                'SELECT m.muted_notifs, r.name AS rname, r.can_ban, r.can_kick, '
                + 'r.can_mute, r.can_manage'
                + (withChan ? ', r.can_channels' : '') + ' '
                + 'FROM server_members m LEFT JOIN server_roles r ON r.id=m.role_id '
                + 'WHERE m.server_id=? AND m.user_id=?',
                [serverId, me],
            );
            if (!row) {
                // Не участник: владельцу всё равно всё можно.
                return {
                    isOwner, canBan: isOwner, canKick: isOwner, canMute: isOwner,
                    canManage: isOwner, canChannels: isOwner, mutedNotifications: false,
                    isMember: false,
                };
            }
            const manage = isOwner || Number(row.can_manage) === 1;
            return {
                isOwner,
                // Владелец может всё, независимо от роли.
                canBan: isOwner || Number(row.can_ban) === 1,
                canKick: isOwner || Number(row.can_kick) === 1,
                canMute: isOwner || Number(row.can_mute) === 1,
                canManage: manage,
                // Пока колонки нет, поведение прежнее: каналы у тех, кто
                // управляет сервером, — праву негде храниться.
                canChannels: withChan ? (isOwner || Number(row.can_channels) === 1) : manage,
                mutedNotifications: Number(row.muted_notifs) === 1,
                roleName: row.rname || '',
                isMember: true,
            };
        } catch (err) {
            if (!withChan) break;
            channelsColumnOk = false;   // старая база — читаем без нового права
        }
    }
    return {
        isOwner, canBan: isOwner, canKick: isOwner, canMute: isOwner,
        canManage: isOwner, canChannels: isOwner, mutedNotifications: false, isMember: false,
    };
}

/** Состоит ли в сервере — проверка перед любой операцией с его каналами. */
async function isMember(me, serverId) {
    return db.exists(
        'SELECT 1 FROM server_members WHERE server_id=? AND user_id=? LIMIT 1',
        [serverId, me],
    ).catch(() => false);
}

/** Сервер, которому принадлежит канал. Нужен для проверки доступа. */
async function serverOfChannel(channelId) {
    return db.scalarInt('SELECT server_id FROM server_channels WHERE id=?', [channelId], 0);
}

/** Может ли этот человек вообще читать этот канал. */
async function canAccessChannel(me, channelId) {
    const serverId = await serverOfChannel(channelId);
    if (!serverId) return false;
    return isMember(me, serverId);
}

// ════════════════════════════════════════════════════════════════════
//  КАНАЛЫ
// ════════════════════════════════════════════════════════════════════

function mapChannel(row, serverId, withLimit) {
    return {
        id: row.id,
        serverId,
        name: row.name || '',
        type: String(row.type || '').toLowerCase() === 'voice' ? 'voice' : 'text',
        userLimit: withLimit ? Number(row.user_limit) || 0 : 0,
        unread: 0,
        mentions: 0,
    };
}

/** user_limit добавлен миграцией 14 — на старых базах его может не быть. */
async function channels(serverId) {
    try {
        const rows = await db.query(
            'SELECT id,name,type,user_limit FROM server_channels WHERE server_id=? ORDER BY position,id',
            [serverId],
        );
        return rows.map((r) => mapChannel(r, serverId, true));
    } catch (_) {
        const rows = await db.query(
            'SELECT id,name,type FROM server_channels WHERE server_id=? ORDER BY position,id',
            [serverId],
        );
        return rows.map((r) => mapChannel(r, serverId, false));
    }
}

async function createChannel(serverId, name, type) {
    return db.insert(
        'INSERT INTO server_channels (server_id,name,type,position) VALUES (?,?,?,99)',
        [serverId, name, type === 'voice' ? 'voice' : 'text'],
    );
}

async function renameChannel(channelId, name) {
    await db.exec('UPDATE server_channels SET name=? WHERE id=?', [name, channelId]);
}

async function deleteChannel(channelId) {
    await db.exec('DELETE FROM server_messages WHERE channel_id=?', [channelId]).catch(() => {});
    await db.exec('DELETE FROM server_channels WHERE id=?', [channelId]);
}

/** 0 — без ограничения вместимости. */
async function setChannelUserLimit(channelId, limit) {
    await db.exec('UPDATE server_channels SET user_limit=? WHERE id=?', [limit, channelId]);
}

// ════════════════════════════════════════════════════════════════════
//  СООБЩЕНИЯ КАНАЛА
// ════════════════════════════════════════════════════════════════════

let hasReplyCol = null;
let hasDeletedCol = null;
let hasMentionsTbl = null;

async function ensureSchemaFlags() {
    if (hasReplyCol === null) hasReplyCol = await db.columnExists('server_messages', 'reply_to_id');
    if (hasDeletedCol === null) hasDeletedCol = await db.columnExists('server_messages', 'is_deleted');
    if (hasMentionsTbl === null) hasMentionsTbl = await db.tableExists('server_mentions');
}

/**
 * Страница сообщений канала.
 *
 * Размер вложения здесь НЕ считаем: OCTET_LENGTH по LONGBLOB заставляет
 * сервер поднять вложение с диска целиком, а лента перечитывается часто —
 * на большой переписке это и были полки нагрузки на диск.
 */
async function channelMessages(channelId, limit = 40, beforeId = 0) {
    await ensureSchemaFlags();
    const take = Math.max(1, Math.min(500, parseInt(limit, 10) || 40));
    const before = parseInt(beforeId, 10) || 0;
    const replyCol = hasReplyCol ? 'sm.reply_to_id,' : '0 AS reply_to_id,';
    const cursor = before > 0 ? `AND sm.id < ${before} ` : '';

    const inner = `
        SELECT sm.id, sm.sender_id, sm.text, ${replyCol}
               sm.file_name,
               UNIX_TIMESTAMP(sm.created_at) AS created_ts,
               TRIM(CONCAT(u.Name,' ',u.Surname)) AS sender_name, u.login,
               (sm.image_data IS NOT NULL) AS has_img,
               (sm.audio_data IS NOT NULL) AS has_audio,
               (sm.video_data IS NOT NULL) AS has_video,
               (sm.file_data  IS NOT NULL) AS has_file
        FROM server_messages sm
        JOIN users u ON u.id = sm.sender_id
        WHERE sm.channel_id=? ${cursor}
        ORDER BY sm.id DESC LIMIT ${take}
    `;
    const rows = await db.query(`SELECT * FROM (${inner}) sub ORDER BY id ASC`, [channelId]);
    return rows.map((r) => ({
        id: r.id,
        senderId: r.sender_id,
        senderName: String(r.sender_name || '').trim() || r.login || '',
        text: dec(r.text),
        createdAtMs: Number(r.created_ts) * 1000,
        replyToId: Number(r.reply_to_id) || 0,
        isDeleted: false,
        isEdited: false,
        hasImage: Number(r.has_img) === 1,
        hasAudio: Number(r.has_audio) === 1,
        hasVideo: Number(r.has_video) === 1,
        hasFile: Number(r.has_file) === 1,
        fileName: r.file_name ?? null,
        scope: SCOPE.SERVER,
        isRead: true,
        reactions: [],
        isPinned: false,
    }));
}

/**
 * Записывает адресатов «@…» в server_mentions.
 *
 * Считать упоминания запросом LIKE по server_messages.text НЕЛЬЗЯ: текст
 * хранится зашифрованным, и «@логин» там не встретится никогда. Поэтому
 * адресаты вычисляются здесь, пока текст ещё открытый.
 */
async function recordMentions(messageId, channelId, authorId, plainText) {
    if (!messageId || messageId <= 0) return;
    const tokens = mentionTokens(plainText);
    if (tokens.size === 0) return;
    if (!(await db.tableExists('server_mentions'))) return;

    try {
        const serverId = await serverOfChannel(channelId);
        if (!serverId) return;

        const everyone = [...tokens].some((t) => ALL_TOKENS.has(t));
        let targets;

        if (everyone) {
            targets = await db.query(
                'SELECT user_id FROM server_members WHERE server_id=? AND user_id<>?',
                [serverId, authorId],
            );
        } else {
            const plain = [...tokens];
            const marks = plain.map(() => '?').join(',');
            // Адресат — либо логин участника, либо название роли на этом
            // сервере: @роль пингует всех, у кого она стоит.
            targets = await db.query(
                'SELECT DISTINCT m.user_id FROM server_members m '
                + 'JOIN users u ON u.id = m.user_id '
                + 'LEFT JOIN server_roles r ON r.id = m.role_id '
                + `WHERE m.server_id=? AND m.user_id<>? AND (LOWER(u.login) IN (${marks}) `
                + `   OR LOWER(r.name) IN (${marks}))`,
                [serverId, authorId, ...plain, ...plain],
            );
        }

        const ids = targets.map((r) => r.user_id).filter((id) => id && id !== authorId);
        if (ids.length === 0) return;

        const values = ids.map(() => '(?,?,?)').join(',');
        const params = [];
        for (const id of ids) params.push(messageId, channelId, id);
        await db.exec(
            `INSERT IGNORE INTO server_mentions (message_id, channel_id, user_id) VALUES ${values}`,
            params,
        );
    } catch (err) {
        // Упоминания — не повод терять само сообщение.
        console.warn('[упоминания] не записаны:', err.message);
    }
}

async function sendChannelMessage({
    me, channelId, text = '', replyToId = 0,
    image = null, audio = null, video = null, file = null, fileName = null,
}) {
    await ensureSchemaFlags();
    const encText = enc(text ?? '');
    const hasMedia = Boolean(image || audio || video || file);
    let newId = 0;

    if (hasMedia) {
        const cols = 'channel_id, sender_id, text, image_data, audio_data, video_data, '
            + 'file_data, file_name' + (hasReplyCol ? ', reply_to_id' : '');
        const vals = '?,?,?,?,?,?,NULL,?' + (hasReplyCol ? ',?' : '');
        const params = [channelId, me, encText, image, audio, video, fileName];
        if (hasReplyCol) params.push(replyToId > 0 ? replyToId : null);
        newId = await db.insert(`INSERT INTO server_messages (${cols}) VALUES (${vals})`, params);

        if (file && file.length > 0 && newId > 0) {
            // Тем же дозаписывающим путём, что и личные чаты.
            await uploadFileData('server_messages', newId, file).catch(() => {});
        }
    } else if (hasReplyCol && replyToId > 0) {
        newId = await db.insert(
            'INSERT INTO server_messages (channel_id, sender_id, text, reply_to_id) VALUES (?,?,?,?)',
            [channelId, me, encText, replyToId],
        );
    } else {
        newId = await db.insert(
            'INSERT INTO server_messages (channel_id, sender_id, text) VALUES (?,?,?)',
            [channelId, me, encText],
        );
    }

    // Адресатов вычисляем здесь, пока текст открытый: в БД он ляжет
    // зашифрованным, и после этого разобрать упоминания уже невозможно.
    await recordMentions(newId, channelId, me, text ?? '');
    return newId;
}

async function editChannelMessage(msgId, newText) {
    await db.exec('UPDATE server_messages SET text=? WHERE id=?', [enc(newText), msgId]);
}

/** Своё сообщение может удалить автор; чужое — только модератор. */
async function deleteChannelMessage(me, msgId, asModerator) {
    if (asModerator) {
        await db.exec('DELETE FROM server_messages WHERE id=?', [msgId]);
    } else {
        await db.exec('DELETE FROM server_messages WHERE id=? AND sender_id=?', [msgId, me]);
    }
    await db.exec('DELETE FROM server_mentions WHERE message_id=?', [msgId]).catch(() => {});
}

async function channelMessageAuthor(msgId) {
    return db.scalarInt('SELECT sender_id FROM server_messages WHERE id=?', [msgId], -1);
}

// ════════════════════════════════════════════════════════════════════
//  УЧАСТНИКИ, РОЛИ, БАНЫ
// ════════════════════════════════════════════════════════════════════

async function members(serverId) {
    const rows = await db.query(
        "SELECT m.user_id, m.role_id, TRIM(CONCAT(u.Name,' ',u.Surname)) AS nm, u.login, "
        + 's.owner_id, r.name AS rname, r.color AS rcolor '
        + 'FROM server_members m JOIN users u ON u.id=m.user_id '
        + 'JOIN servers s ON s.id=m.server_id '
        + 'LEFT JOIN server_roles r ON r.id=m.role_id '
        + 'WHERE m.server_id=? ORDER BY (m.user_id=s.owner_id) DESC, u.login',
        [serverId],
    );
    return rows.map((r) => ({
        userId: r.user_id,
        name: String(r.nm || '').trim() || r.login || '',
        login: r.login || '',
        roleId: r.role_id ?? null,
        roleName: r.rname || '',
        roleColor: r.rcolor || '',
        isOwner: r.owner_id === r.user_id,
    }));
}

/** Как и в permissions(): на базе без миграции список ролей пропал бы вовсе. */
async function roles(serverId) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
        const withChan = channelsColumnOk;
        try {
            // eslint-disable-next-line no-await-in-loop
            const rows = await db.query(
                'SELECT id, name, color, can_ban, can_kick, can_mute, can_manage'
                + (withChan ? ', can_channels' : '') + ', position '
                + 'FROM server_roles WHERE server_id=? ORDER BY position,id',
                [serverId],
            );
            return rows.map((r) => {
                const manage = Number(r.can_manage) === 1;
                return {
                    id: r.id,
                    name: r.name || '',
                    colorHex: r.color || '#FFFFFF',
                    canBan: Number(r.can_ban) === 1,
                    canKick: Number(r.can_kick) === 1,
                    canMute: Number(r.can_mute) === 1,
                    canManage: manage,
                    canChannels: withChan ? Number(r.can_channels) === 1 : manage,
                    position: Number(r.position) || 0,
                };
            });
        } catch (_) {
            if (!withChan) break;
            channelsColumnOk = false;
        }
    }
    return [];
}

async function createRole(serverId, role) {
    const b = (v) => (v ? 1 : 0);
    if (channelsColumnOk) {
        try {
            return await db.insert(
                'INSERT INTO server_roles '
                + '(server_id,name,color,can_ban,can_kick,can_mute,can_manage,can_channels,position) '
                + 'VALUES (?,?,?,?,?,?,?,?,?)',
                [serverId, role.name, role.colorHex, b(role.canBan), b(role.canKick),
                    b(role.canMute), b(role.canManage), b(role.canChannels), role.position || 0],
            );
        } catch (_) {
            channelsColumnOk = false;
        }
    }
    return db.insert(
        'INSERT INTO server_roles (server_id,name,color,can_ban,can_kick,can_mute,can_manage,position) '
        + 'VALUES (?,?,?,?,?,?,?,?)',
        [serverId, role.name, role.colorHex, b(role.canBan), b(role.canKick),
            b(role.canMute), b(role.canManage), role.position || 0],
    );
}

async function updateRole(role) {
    const b = (v) => (v ? 1 : 0);
    if (channelsColumnOk) {
        try {
            await db.exec(
                'UPDATE server_roles SET name=?,color=?,can_ban=?,can_kick=?,can_mute=?,'
                + 'can_manage=?,can_channels=? WHERE id=?',
                [role.name, role.colorHex, b(role.canBan), b(role.canKick), b(role.canMute),
                    b(role.canManage), b(role.canChannels), role.id],
            );
            return;
        } catch (_) {
            channelsColumnOk = false;
        }
    }
    await db.exec(
        'UPDATE server_roles SET name=?,color=?,can_ban=?,can_kick=?,can_mute=?,can_manage=? WHERE id=?',
        [role.name, role.colorHex, b(role.canBan), b(role.canKick), b(role.canMute),
            b(role.canManage), role.id],
    );
}

async function deleteRole(roleId) {
    await db.exec('UPDATE server_members SET role_id=NULL WHERE role_id=?', [roleId]);
    await db.exec('DELETE FROM server_roles WHERE id=?', [roleId]);
}

async function assignRole(serverId, userId, roleId) {
    await db.exec(
        'UPDATE server_members SET role_id=? WHERE server_id=? AND user_id=?',
        [roleId ?? null, serverId, userId],
    );
}

/** Заглушить уведомления сервера — только для текущего пользователя. */
async function setMutedNotifications(me, serverId, muted) {
    await db.exec(
        'UPDATE server_members SET muted_notifs=? WHERE server_id=? AND user_id=?',
        [muted ? 1 : 0, serverId, me],
    );
}

async function kickMember(serverId, userId, alsoBan) {
    await db.exec('DELETE FROM server_members WHERE server_id=? AND user_id=?', [serverId, userId]);
    if (alsoBan) {
        await db.exec(
            'INSERT IGNORE INTO server_bans (server_id,user_id) VALUES (?,?)',
            [serverId, userId],
        ).catch(() => {});
    }
}

async function unban(serverId, userId) {
    await db.exec(
        'DELETE FROM server_bans WHERE server_id=? AND user_id=?', [serverId, userId],
    ).catch(() => {});
}

async function bannedUsers(serverId) {
    try {
        const rows = await db.query(
            "SELECT b.user_id, TRIM(CONCAT(u.Name,' ',u.Surname)) AS nm, u.login "
            + 'FROM server_bans b JOIN users u ON u.id=b.user_id WHERE b.server_id=? ORDER BY u.login',
            [serverId],
        );
        return rows.map((r) => ({
            userId: r.user_id,
            name: String(r.nm || '').trim() || r.login || '',
            login: r.login || '',
        }));
    } catch (_) {
        return [];
    }
}

// ════════════════════════════════════════════════════════════════════
//  ПРОЧИТАННОЕ И БЕЙДЖИ (порт ServerReads.cs)
// ════════════════════════════════════════════════════════════════════

async function markChannelRead(me, channelId) {
    await db.exec(
        'INSERT INTO server_reads (user_id, channel_id, last_read_id) '
        + 'SELECT ?, ?, COALESCE(MAX(id),0) FROM server_messages WHERE channel_id=? '
        + 'ON DUPLICATE KEY UPDATE last_read_id=VALUES(last_read_id)',
        [me, channelId, channelId],
    ).catch(() => {});
}

async function markServerRead(me, serverId) {
    await db.exec(
        'INSERT INTO server_reads (user_id, channel_id, last_read_id) '
        + 'SELECT ?, ch.id, COALESCE((SELECT MAX(sm.id) FROM server_messages sm '
        + 'WHERE sm.channel_id=ch.id),0) FROM server_channels ch WHERE ch.server_id=? '
        + 'ON DUPLICATE KEY UPDATE last_read_id=VALUES(last_read_id)',
        [me, serverId],
    ).catch(() => {});
}

/**
 * Непрочитанные и упоминания по каждому каналу — одним запросом.
 *
 * Упоминание = запись в server_mentions (миграция 15) либо ответ на моё
 * сообщение. Прежний вариант искал «@логин» через LIKE по sm.text — а текст
 * зашифрован, символа «@» там нет вовсе, и условие не выполнялось никогда.
 */
async function badges(me) {
    await ensureSchemaFlags();

    const mentionParts = [];
    if (hasReplyCol) {
        mentionParts.push(
            'EXISTS(SELECT 1 FROM server_messages p WHERE p.id = sm.reply_to_id AND p.sender_id = ?)',
        );
    }
    if (hasMentionsTbl) {
        mentionParts.push(
            'EXISTS(SELECT 1 FROM server_mentions mn WHERE mn.message_id = sm.id AND mn.user_id = ?)',
        );
    }
    // Нет ни таблицы, ни колонки ответов — считать нечего, но SQL обязан
    // остаться валидным.
    const mentionExpr = mentionParts.length === 0 ? '0=1 ' : `${mentionParts.join(' OR ')} `;
    const notDeleted = hasDeletedCol ? 'AND sm.is_deleted = 0 ' : '';

    const sql = 'SELECT sc.server_id, sm.channel_id, mm.muted_notifs, COUNT(*) AS unread, '
        + `SUM(CASE WHEN ${mentionExpr}THEN 1 ELSE 0 END) AS mentions `
        + 'FROM server_messages sm '
        + 'JOIN server_channels sc ON sc.id = sm.channel_id '
        + 'JOIN server_members mm ON mm.server_id = sc.server_id AND mm.user_id = ? '
        + 'LEFT JOIN server_reads r ON r.user_id = ? AND r.channel_id = sm.channel_id '
        + `WHERE sm.sender_id <> ? ${notDeleted}`
        + '  AND sm.id > COALESCE(r.last_read_id, 0) '
        + 'GROUP BY sc.server_id, sm.channel_id, mm.muted_notifs';

    // Порядок подстановок: сначала параметры выражения упоминаний, затем
    // три @me из JOIN и WHERE.
    const params = [];
    for (let i = 0; i < mentionParts.length; i += 1) params.push(me);
    params.push(me, me, me);

    try {
        const rows = await db.query(sql, params);
        return rows.map((r) => ({
            serverId: r.server_id,
            channelId: r.channel_id,
            unread: Number(r.unread) || 0,
            mentions: Number(r.mentions) || 0,
            muted: Number(r.muted_notifs) === 1,
        }));
    } catch (err) {
        console.warn('[серверы] бейджи:', err.message);
        return [];
    }
}

/** Описание последнего сообщения канала — для текста уведомления. */
async function previewOfLatestInChannel(channelId) {
    const recent = await channelMessages(channelId, 1).catch(() => []);
    const last = recent[recent.length - 1];
    if (!last) return 'Новое сообщение';
    return withSender(last.senderName, describeMessage(last));
}

/**
 * Поиск по каналу. Текст в БД зашифрован, поэтому LIKE по нему не работает:
 * выбираем страницу и фильтруем уже расшифрованные — как на ПК. Ищем и по
 * тексту, и по автору.
 */
async function searchInChannel(channelId, query, limit = 50) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    const recent = await channelMessages(channelId, 500);
    return recent
        .filter((m) => m.text.toLowerCase().includes(q) || m.senderName.toLowerCase().includes(q))
        .slice(-limit);
}

module.exports = {
    myServers, createServer, joinServer, leaveServer, serverInfo, renameServer, deleteServer,
    permissions, isMember, serverOfChannel, canAccessChannel,
    channels, createChannel, renameChannel, deleteChannel, setChannelUserLimit,
    channelMessages, sendChannelMessage, editChannelMessage, deleteChannelMessage,
    channelMessageAuthor, recordMentions,
    members, roles, createRole, updateRole, deleteRole, assignRole, setMutedNotifications,
    kickMember, unban, bannedUsers,
    markChannelRead, markServerRead, badges, previewOfLatestInChannel, searchInChannel,
};

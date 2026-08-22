/**
 * Личные и групповые сообщения — порт ChatRepository.kt.
 *
 * Запросы перенесены дословно, включая их неочевидные места: на ПК и
 * Android их переписывали по конкретным жалобам на нагрузку, и «упростить»
 * здесь значит вернуть те же полки чтения на боевой базе.
 */
const db = require('../db');
const { enc, dec } = require('../utils/crypto');
const { buildName, describeMessage, withSender } = require('../utils/format');
const { SCOPE, tableOf, normalizeScope } = require('./scopes');
const config = require('../config');

const PAGE_SIZE = 40;

/**
 * Предикат «дружба подтверждена». Колонка status появилась миграцией 1;
 * на базе без неё запрос с ней упал бы целиком, поэтому проверяем.
 */
let hasFriendStatus = null;
async function acceptedPredicate(alias) {
    if (hasFriendStatus === null) {
        hasFriendStatus = await db.columnExists('friends', 'status').catch(() => true);
    }
    return hasFriendStatus ? `${alias}.status=1` : '(1=1)';
}

// ════════════════════════════════════════════════════════════════════
//  СПИСКИ
// ════════════════════════════════════════════════════════════════════

/**
 * Список личных диалогов.
 *
 * ВАЖНО ПРО НАГРУЗКУ. Прежний вариант джойнил messages условием
 * «(sender=я AND receiver=u.id) OR (sender=u.id AND receiver=я)». OR в ON не
 * даёт использовать индекс, поэтому на КАЖДУЮ строку users шло полное
 * сканирование messages — а вложения лежат там же, в LONGBLOB, то есть с
 * диска поднимались и они. Здесь агрегат считается один раз по своим
 * сообщениям: две ветки UNION ALL, каждая ложится на свой индекс, а текст
 * последнего сообщения берётся одной выборкой по первичному ключу.
 * Запрос слово в слово совпадает с ПК и Android.
 */
async function loadConversations(me) {
    const accepted = await acceptedPredicate('f');
    const sql = `
        SELECT u.id, u.Name, u.Surname, u.login,
               UNIX_TIMESTAMP(lm.created_at) AS last_time,
               lm.text AS last_msg,
               IFNULL(ur.unread, 0) AS unread
        FROM users u
        LEFT JOIN (
            SELECT partner_id, MAX(id) AS last_id
            FROM (
                SELECT receiver_id AS partner_id, MAX(id) AS id
                FROM messages WHERE sender_id = ? GROUP BY receiver_id
                UNION ALL
                SELECT sender_id AS partner_id, MAX(id) AS id
                FROM messages WHERE receiver_id = ? GROUP BY sender_id
            ) t
            GROUP BY partner_id
        ) c ON c.partner_id = u.id
        LEFT JOIN messages lm ON lm.id = c.last_id
        LEFT JOIN (
            SELECT sender_id AS partner_id, COUNT(*) AS unread
            FROM messages WHERE receiver_id = ? AND is_read = 0
            GROUP BY sender_id
        ) ur ON ur.partner_id = u.id
        WHERE u.id <> ?
          AND ( c.partner_id IS NOT NULL
             OR EXISTS (SELECT 1 FROM friends f
                        WHERE ${accepted} AND ((f.user_id=? AND f.friend_id=u.id)
                                            OR (f.user_id=u.id AND f.friend_id=?))) )
        ORDER BY last_time DESC, u.Name ASC
    `;
    const rows = await db.query(sql, [me, me, me, me, me, me]);
    return rows.map((r) => ({
        userId: r.id,
        name: buildName(r.Name, r.Surname, r.login),
        login: r.login || '',
        lastMessage: r.last_msg === null ? '' : dec(r.last_msg),
        lastTimeMs: Number(r.last_time) > 0 ? Number(r.last_time) * 1000 : null,
        unread: Number(r.unread) || 0,
    }));
}

/** Колонка с датой создания группы: схемы расходятся между установками. */
let groupCreatedCol;
async function groupCreatedColumn() {
    if (groupCreatedCol !== undefined) return groupCreatedCol;
    for (const candidate of ['created_at', 'created', 'createdAt']) {
        // eslint-disable-next-line no-await-in-loop
        if (await db.columnExists('group_chats', candidate)) {
            groupCreatedCol = candidate;
            return groupCreatedCol;
        }
    }
    groupCreatedCol = null;
    return groupCreatedCol;
}

/**
 * Список групп. У пустой группы даты сообщений нет, и строка выглядела так,
 * будто время потеряли, — показываем дату создания, если схема её хранит.
 */
async function loadGroups(me) {
    const createdCol = await groupCreatedColumn();
    const lastTime = createdCol === null
        ? 'UNIX_TIMESTAMP((SELECT MAX(gm3.created_at) FROM group_messages gm3 '
          + 'WHERE gm3.group_id = gc.id))'
        : 'COALESCE('
          + 'UNIX_TIMESTAMP((SELECT MAX(gm3.created_at) FROM group_messages gm3 '
          + 'WHERE gm3.group_id = gc.id)), '
          + `UNIX_TIMESTAMP(gc.\`${createdCol}\`))`;

    const sql = `
        SELECT gc.id, gc.name, gc.avatar_color,
               (SELECT gm2.text FROM group_messages gm2
                WHERE gm2.group_id = gc.id
                ORDER BY gm2.created_at DESC LIMIT 1) AS last_msg,
               ${lastTime} AS last_time,
               (SELECT COUNT(*) FROM group_members gmem2
                WHERE gmem2.group_id = gc.id) AS member_count
        FROM group_chats gc
        JOIN group_members gmem ON gmem.group_id = gc.id AND gmem.user_id = ?
        ORDER BY last_time DESC, gc.name ASC
    `;
    const rows = await db.query(sql, [me]);
    return rows.map((r) => ({
        id: r.id,
        name: r.name || '',
        lastMessage: r.last_msg === null ? '' : dec(r.last_msg),
        memberCount: Number(r.member_count) || 0,
        avatarColorHex: r.avatar_color || '#5865F2',
        lastTimeMs: Number(r.last_time) > 0 ? Number(r.last_time) * 1000 : null,
    }));
}

// ════════════════════════════════════════════════════════════════════
//  ИСТОРИЯ
// ════════════════════════════════════════════════════════════════════

function mapMessage(row, scope) {
    const senderName = String(row.sender_name || '').trim() || row.login || '';
    return {
        id: row.id,
        senderId: row.sender_id,
        senderName,
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

/**
 * Последние сообщения диалога в хронологическом порядке.
 *
 * СНАЧАЛА ТОЛЬКО НОМЕРА, И ТОЛЬКО СТРАНИЦА. Одно условие «(я→он) OR (он→я)»
 * с ORDER BY id DESC LIMIT ни одним индексом не покрывается: сервер
 * собирает объединением ВСЮ переписку и сортирует её в файле ради сорока
 * строк. Две отдельные ветки ложатся на (sender_id, receiver_id, id) и
 * берут ровно страницу движением к концу индекса.
 *
 * UNION, а не UNION ALL: у переписки с самим собой обе ветки совпадают, и
 * без слияния сообщения задвоились бы.
 */
async function loadDirectMessages(me, partnerId, limit = PAGE_SIZE, beforeId = 0) {
    const take = Math.max(1, Math.min(200, parseInt(limit, 10) || PAGE_SIZE));
    const before = parseInt(beforeId, 10) || 0;
    const cursor = before > 0 ? `AND id < ${before} ` : '';

    const keys = `
        (SELECT id FROM messages
          WHERE sender_id=? AND receiver_id=? ${cursor}
          ORDER BY id DESC LIMIT ${take})
        UNION
        (SELECT id FROM messages
          WHERE sender_id=? AND receiver_id=? ${cursor}
          ORDER BY id DESC LIMIT ${take})
    `;
    const inner = `
        SELECT m.id, m.sender_id, m.text, m.file_name,
               m.reply_to_id, m.is_deleted, m.edited_at, m.is_read,
               UNIX_TIMESTAMP(m.created_at) AS created_ts,
               TRIM(CONCAT(u.Name,' ',u.Surname)) AS sender_name, u.login,
               (m.image_data IS NOT NULL) AS has_img,
               (m.audio_data IS NOT NULL) AS has_audio,
               (m.video_data IS NOT NULL) AS has_video,
               (m.file_data  IS NOT NULL) AS has_file
        FROM (${keys}) k
        JOIN messages m ON m.id = k.id
        JOIN users u ON u.id = m.sender_id
        ORDER BY m.id DESC LIMIT ${take}
    `;
    const rows = await db.query(
        `SELECT * FROM (${inner}) sub ORDER BY id ASC`,
        [me, partnerId, partnerId, me],
    );
    return rows.map((r) => mapMessage(r, SCOPE.DM));
}

async function loadGroupMessages(groupId, limit = PAGE_SIZE, beforeId = 0) {
    const take = Math.max(1, Math.min(200, parseInt(limit, 10) || PAGE_SIZE));
    const before = parseInt(beforeId, 10) || 0;
    const cursor = before > 0 ? `AND gm.id < ${before} ` : '';

    const inner = `
        SELECT gm.id, gm.sender_id, gm.text, gm.file_name,
               gm.reply_to_id, gm.is_deleted, gm.edited_at,
               UNIX_TIMESTAMP(gm.created_at) AS created_ts,
               TRIM(CONCAT(u.Name,' ',u.Surname)) AS sender_name, u.login,
               (gm.image_data IS NOT NULL) AS has_img,
               (gm.audio_data IS NOT NULL) AS has_audio,
               (gm.video_data IS NOT NULL) AS has_video,
               (gm.file_data  IS NOT NULL) AS has_file
        FROM group_messages gm
        JOIN users u ON u.id = gm.sender_id
        WHERE gm.group_id=? ${cursor}
        ORDER BY gm.id DESC LIMIT ${take}
    `;
    const rows = await db.query(`SELECT * FROM (${inner}) sub ORDER BY id ASC`, [groupId]);
    return rows.map((r) => mapMessage(r, SCOPE.GROUP));
}

/** Мини-цитата сообщения, на которое отвечают. */
async function loadReplyQuote(replyToId, scope) {
    if (!replyToId || replyToId <= 0) return null;
    const table = tableOf(scope);
    const row = await db.queryFirst(
        `SELECT m.text, TRIM(CONCAT(u.Name,' ',u.Surname)) AS sname, u.login
         FROM ${table} m JOIN users u ON u.id = m.sender_id WHERE m.id = ?`,
        [replyToId],
    ).catch(() => null);
    if (!row) return null;
    return {
        messageId: replyToId,
        sender: String(row.sname || '').trim() || row.login || '',
        text: dec(row.text),
    };
}

// ════════════════════════════════════════════════════════════════════
//  ОТПРАВКА
// ════════════════════════════════════════════════════════════════════

/**
 * Дозапись файла кусками — порт uploadFileData.
 *
 * Одним пакетом большой файл сервер не примет (max_allowed_packet), поэтому
 * сначала пробуем целиком, а при отказе дописываем по 4 МБ через CONCAT.
 * Ровно так же это делают ПК и Android, и формат в базе получается тот же.
 */
async function uploadFileData(table, msgId, data) {
    // Запись большого blob легко выходит за дефолтные 30 секунд, и сервер
    // рвёт соединение посреди команды.
    await db.exec('SET SESSION net_read_timeout=600, net_write_timeout=600, wait_timeout=600')
        .catch(() => {});

    try {
        await db.exec(`UPDATE ${table} SET file_data=? WHERE id=?`, [data, msgId]);
        return;
    } catch (_) {
        // Пакет великоват — дозапись порциями.
    }

    await db.exec(`UPDATE ${table} SET file_data=NULL WHERE id=?`, [msgId]);
    const chunk = config.chunkBytes;
    for (let off = 0; off < data.length; off += chunk) {
        const part = data.subarray(off, Math.min(off + chunk, data.length));
        // eslint-disable-next-line no-await-in-loop
        await db.exec(
            `UPDATE ${table} SET file_data = CONCAT(IFNULL(file_data, _binary''), ?) WHERE id=?`,
            [part, msgId],
        );
    }
}

/**
 * Отправка личного или группового сообщения.
 *
 * file_data в INSERT всегда NULL, а сам файл дописывается следом
 * uploadFileData — иначе большой файл не пролезает одним пакетом.
 * Порядок колонок совпадает с клиентами.
 */
async function sendMessage({
    me, scope, target, text = '', replyToId = 0,
    image = null, audio = null, video = null, file = null, fileName = null,
}) {
    const sc = normalizeScope(scope);
    const table = tableOf(sc);
    const encText = enc(text ?? '');
    const reply = replyToId > 0 ? replyToId : null;

    const newId = sc === SCOPE.GROUP
        ? await db.insert(
            'INSERT INTO group_messages (group_id, sender_id, text, image_data, audio_data, '
            + 'video_data, file_data, file_name, reply_to_id) VALUES (?,?,?,?,?,?,NULL,?,?)',
            [target, me, encText, image, audio, video, fileName, reply],
        )
        : await db.insert(
            'INSERT INTO messages (sender_id, receiver_id, text, image_data, audio_data, '
            + 'video_data, file_data, file_name, reply_to_id) VALUES (?,?,?,?,?,?,NULL,?,?)',
            [me, target, encText, image, audio, video, fileName, reply],
        );

    if (file && file.length > 0 && newId > 0) {
        await uploadFileData(table, newId, file);
    }
    return newId;
}

/** Правка с сохранением прежнего текста в message_edits. */
async function editMessage(scope, msgId, newText) {
    const sc = normalizeScope(scope);
    const table = tableOf(sc);
    const old = await db.scalar(`SELECT text FROM ${table} WHERE id=?`, [msgId], null);
    if (old !== null) {
        await db.exec(
            'INSERT INTO message_edits (message_id, scope, old_text) VALUES (?,?,?)',
            [msgId, sc, old],
        ).catch(() => {});
    }
    await db.exec(`UPDATE ${table} SET text=?, edited_at=NOW() WHERE id=?`, [enc(newText), msgId]);
}

/** История правок (старый текст сохранён зашифрованным). */
async function editHistory(scope, msgId) {
    const rows = await db.query(
        'SELECT old_text, UNIX_TIMESTAMP(edited_at) AS ts FROM message_edits '
        + 'WHERE message_id=? AND scope=? ORDER BY edited_at DESC',
        [msgId, normalizeScope(scope)],
    ).catch(() => []);
    return rows.map((r) => ({ text: dec(r.old_text), atMs: Number(r.ts) * 1000 }));
}

/**
 * Мягкое удаление — как на ПК: флаг, текст-заглушка и очистка медиа.
 * В канале сервера строка удаляется совсем (там своя модерация).
 */
async function deleteMessage(scope, msgId) {
    const sc = normalizeScope(scope);
    if (sc === SCOPE.SERVER) {
        await db.exec('DELETE FROM server_messages WHERE id=?', [msgId]);
        return;
    }
    await db.exec(
        `UPDATE ${tableOf(sc)} SET is_deleted=1, text=?, `
        + 'image_data=NULL, audio_data=NULL, video_data=NULL WHERE id=?',
        [enc('[сообщение удалено]'), msgId],
    );
}

/** Автор сообщения — чтобы не дать править и удалять чужое. */
async function messageAuthor(scope, msgId) {
    return db.scalarInt(`SELECT sender_id FROM ${tableOf(scope)} WHERE id=?`, [msgId], -1);
}

// ════════════════════════════════════════════════════════════════════
//  ПРОЧИТАННОЕ
// ════════════════════════════════════════════════════════════════════

async function markAsRead(me, partnerId) {
    await db.exec(
        'UPDATE messages SET is_read=1 WHERE sender_id=? AND receiver_id=? AND is_read=0',
        [partnerId, me],
    );
}

async function unreadBySender(me) {
    const rows = await db.query(
        'SELECT sender_id, COUNT(*) AS cnt FROM messages '
        + 'WHERE receiver_id=? AND is_read=0 GROUP BY sender_id',
        [me],
    ).catch(() => []);
    const out = {};
    for (const r of rows) out[r.sender_id] = Number(r.cnt);
    return out;
}

/** Максимальный id в переписке — дешёвая проверка «есть ли новое». */
async function directMaxId(me, partnerId) {
    return db.scalarInt(
        'SELECT MAX(id) FROM ('
        + '(SELECT MAX(id) AS id FROM messages WHERE sender_id=? AND receiver_id=?) '
        + 'UNION ALL '
        + '(SELECT MAX(id) AS id FROM messages WHERE sender_id=? AND receiver_id=?)) t',
        [me, partnerId, partnerId, me],
        0,
    );
}

async function groupMaxId(groupId) {
    return db.scalarInt('SELECT MAX(id) FROM group_messages WHERE group_id=?', [groupId], 0);
}

// ════════════════════════════════════════════════════════════════════
//  ВЛОЖЕНИЯ
// ════════════════════════════════════════════════════════════════════

const BLOB_COLUMNS = {
    img: 'image_data',
    image: 'image_data',
    audio: 'audio_data',
    video: 'video_data',
    file: 'file_data',
};

/** Байты вложения. Колонка выбирается по белому списку, не по вводу. */
async function loadBlob(scope, msgId, kind) {
    const column = BLOB_COLUMNS[String(kind || '').toLowerCase()];
    if (!column) return null;
    const row = await db.queryFirst(
        `SELECT ${column} AS data, file_name FROM ${tableOf(scope)} WHERE id=?`,
        [msgId],
    ).catch(() => null);
    if (!row || !row.data) return null;
    return { data: row.data, fileName: row.file_name ?? null };
}

/** Размер файла — отдельным запросом, только для карточки вложения. */
async function fileSize(scope, msgId) {
    return db.scalarInt(
        `SELECT OCTET_LENGTH(file_data) FROM ${tableOf(scope)} WHERE id=?`,
        [msgId],
        0,
    );
}

// ════════════════════════════════════════════════════════════════════
//  БЛОКИРОВКИ
// ════════════════════════════════════════════════════════════════════

async function isBlocked(blockerId, blockedId) {
    try {
        return await db.exists(
            'SELECT 1 FROM user_blocks WHERE blocker_id=? AND blocked_id=? LIMIT 1',
            [blockerId, blockedId],
        );
    } catch (_) {
        return false;
    }
}

/** [я заблокировал его, он заблокировал меня] */
async function blockState(me, partnerId) {
    return {
        iBlocked: await isBlocked(me, partnerId),
        blockedMe: await isBlocked(partnerId, me),
    };
}

async function block(me, blockedId) {
    await db.exec(
        'INSERT IGNORE INTO user_blocks (blocker_id, blocked_id) VALUES (?, ?)',
        [me, blockedId],
    ).catch(() => {});
}

async function unblock(me, blockedId) {
    await db.exec(
        'DELETE FROM user_blocks WHERE blocker_id=? AND blocked_id=?',
        [me, blockedId],
    ).catch(() => {});
}

/** Короткое описание последнего сообщения — для карточки чата. */
function preview(msg) {
    if (!msg) return '';
    return describeMessage(msg);
}

module.exports = {
    PAGE_SIZE,
    loadConversations,
    loadGroups,
    loadDirectMessages,
    loadGroupMessages,
    loadReplyQuote,
    sendMessage,
    uploadFileData,
    editMessage,
    editHistory,
    deleteMessage,
    messageAuthor,
    markAsRead,
    unreadBySender,
    directMaxId,
    groupMaxId,
    loadBlob,
    fileSize,
    isBlocked,
    blockState,
    block,
    unblock,
    preview,
    withSender,
    mapMessage,
};

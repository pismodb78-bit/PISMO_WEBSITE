const db = require('../db');

function toBase64(msg) {
    if (msg.image_data) msg.image_data = msg.image_data.toString('base64');
    if (msg.audio_data) msg.audio_data = msg.audio_data.toString('base64');
    if (msg.file_data) msg.file_data = msg.file_data.toString('base64');
    return msg;
}

function detectMsgType(msg) {
    if (msg.image_data) return 'image';
    if (msg.audio_data) return 'audio';
    if (msg.file_data) return 'file';
    return 'text';
}

// Для истории чата НЕ включаем тяжёлые BLOB-поля целиком — иначе при большом
// количестве файлов JSON.stringify падает с RangeError: Invalid string length.
// Вместо данных отдаём только флаги наличия; сами данные подгружаются по требованию
// через 'message:file' / 'group:message:file', когда сообщение реально рендерится.
function toHistoryPreview(msg) {
    const hasImage = !!msg.image_data;
    const hasAudio = !!msg.audio_data;
    const hasFile = !!msg.file_data;

    delete msg.image_data;
    delete msg.audio_data;
    delete msg.file_data;

    msg.has_image = hasImage;
    msg.has_audio = hasAudio;
    msg.has_file = hasFile;
    return msg;
}

// Раскладывает входящий base64-файл по нужной колонке (раньше это делал multer)
function splitIncomingFile(file) {
    let image_data = null, audio_data = null, file_data = null, file_name = null, msg_type = 'text';

    if (file && file.data) {
        const buffer = Buffer.from(file.data, 'base64');
        file_name = file.name || null;
        const mime = file.mime || '';
        const lowerName = (file_name || '').toLowerCase();

        if (mime.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp)$/i.test(lowerName)) {
            // Иногда браузер не проставляет mime у файла (file.type === '') — тогда
            // картинка ошибочно уходила как «файл» и рендерилась блоком 📄 с GUID-именем
            // поверх изображения. Подстраховываемся распознаванием по расширению.
            msg_type = 'image';
            image_data = buffer;
        } else if (
            mime.startsWith('audio/') ||
            lowerName.endsWith('.webm') || lowerName.endsWith('.wav') ||
            lowerName.endsWith('.ogg') || lowerName.endsWith('.mp3') || lowerName.endsWith('.m4a')
        ) {
            msg_type = 'audio';
            audio_data = buffer;
        } else {
            msg_type = 'file';
            file_data = buffer;
        }
    }

    return { image_data, audio_data, file_data, file_name, msg_type };
}

module.exports = (io, socket) => {
    const userId = socket.userId;

    // ── Автоприсоединение к личной комнате и всем группам пользователя ──
    socket.join(`user_${userId}`);
    (async () => {
        try {
            const [rows] = await db.execute('SELECT group_id FROM group_members WHERE user_id = ?', [userId]);
            rows.forEach(r => socket.join(`group_${r.group_id}`));
        } catch (err) {
            console.error('Ошибка авто-присоединения к группам:', err);
        }
    })();

    // ════════════════ СПРАВОЧНИКИ ════════════════

    socket.on('users:list', async (_payload, cb) => {
        try {
            const [users] = await db.execute('SELECT id, login, Name, Surname, role FROM users');
            cb?.({ ok: true, data: users });
        } catch (err) {
            console.error('users:list', err);
            cb?.({ ok: false, error: 'DB_ERROR' });
        }
    });

    // ════════════════ ЛИЧНЫЕ ЧАТЫ ════════════════

    socket.on('conversations:list', async (_payload, cb) => {
        try {
            const query = `
        SELECT
          partner_id,
          lm.text AS lastMessage, lm.msg_type AS lastMsgType,
          lm.image_data IS NOT NULL AS lastHasImage,
          lm.audio_data IS NOT NULL AS lastHasAudio,
          lm.file_data IS NOT NULL AS lastHasFile,
          lm.created_at AS lastMessageAt,
          u.unreadCount
        FROM (
          SELECT CASE WHEN sender_id = ? THEN receiver_id ELSE sender_id END AS partner_id
          FROM messages WHERE sender_id = ? OR receiver_id = ? GROUP BY partner_id
        ) p
        JOIN (
          SELECT x.partner_id, x.text, x.msg_type, x.image_data, x.audio_data, x.file_data, x.created_at
          FROM (
            SELECT
              CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END AS partner_id,
              m.text, m.msg_type, m.image_data, m.audio_data, m.file_data, m.created_at,
              ROW_NUMBER() OVER (PARTITION BY (CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END) ORDER BY m.created_at DESC) AS rn
            FROM messages m WHERE (m.sender_id = ? OR m.receiver_id = ?)
          ) x WHERE x.rn = 1
        ) lm ON lm.partner_id = p.partner_id
        LEFT JOIN (
          SELECT sender_id AS partner_id, COUNT(*) AS unreadCount
          FROM messages WHERE receiver_id = ? AND is_read = 0 GROUP BY sender_id
        ) u ON u.partner_id = p.partner_id
        ORDER BY lm.created_at DESC
      `;
            const params = [userId, userId, userId, userId, userId, userId, userId, userId];
            const [rows] = await db.execute(query, params);

            const result = rows.map(r => {
                let preview = r.lastMessage || '';
                let type = r.lastMsgType;
                if (r.lastHasImage) type = 'image';
                else if (r.lastHasAudio) type = 'audio';
                else if (r.lastHasFile) type = 'file';
                if (type === 'image') preview = '🖼️ Фотография';
                if (type === 'audio') preview = '🎙️ Голосовое сообщение';
                if (type === 'file') preview = '📄 Файл';
                return {
                    id: r.partner_id,
                    lastMessage: preview,
                    lastMessageAt: r.lastMessageAt,
                    unreadCount: r.unreadCount
                };
            });
            cb?.({ ok: true, data: result });
        } catch (err) {
            console.error('conversations:list', err);
            cb?.({ ok: false, error: 'DB_ERROR' });
        }
    });

    socket.on('chat:join', async ({ partnerId }, cb) => {
        try {
            socket.join(`chat_${partnerId}`);

            const [rows] = await db.execute(
                `SELECT id, sender_id, receiver_id, text, image_data, audio_data, file_data, file_name, msg_type, created_at, is_read
         FROM messages
         WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
         ORDER BY created_at ASC`,
                [userId, partnerId, partnerId, userId]
            );

            const history = rows.map(m => {
                const detected = detectMsgType(m);
                m.msg_type = detected !== 'text' ? detected : (m.msg_type || 'text');
                return toHistoryPreview(m);
            });

            await db.execute(
                'UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0',
                [partnerId, userId]
            );
            socket.to(`chat_${userId}`).emit('messages:marked_read', { chatId: userId, userId });

            cb?.({ ok: true, history });
        } catch (err) {
            console.error('chat:join', err);
            cb?.({ ok: false, error: 'DB_ERROR' });
        }
    });

    socket.on('chat:leave', ({ partnerId }) => {
        socket.leave(`chat_${partnerId}`);
    });

    // Подгрузка файла конкретного личного сообщения по требованию
    socket.on('message:file', async ({ msgId }, cb) => {
        try {
            const [rows] = await db.execute(
                'SELECT image_data, audio_data, file_data, file_name FROM messages WHERE id = ?',
                [msgId]
            );
            if (!rows.length) return cb?.({ ok: false, error: 'NOT_FOUND' });
            cb?.({ ok: true, ...toBase64(rows[0]) });
        } catch (err) {
            console.error('message:file', err);
            cb?.({ ok: false, error: 'DB_ERROR' });
        }
    });

    socket.on('chat:send', async ({ receiverId, text, file }, cb) => {
        try {
            const { image_data, audio_data, file_data, file_name, msg_type } = splitIncomingFile(file);

            const [result] = await db.execute(
                `INSERT INTO messages (sender_id, receiver_id, text, image_data, audio_data, file_data, file_name, msg_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [userId, receiverId, text || null, image_data, audio_data, file_data, file_name, msg_type]
            );

            const [rows] = await db.execute('SELECT * FROM messages WHERE id = ?', [result.insertId]);
            // Диагностика голосовых: получено vs реально в БД. Если "в БД" меньше —
            // колонку audio_data режет обычный BLOB (64 КБ), нужен LONGBLOB.
            if (msg_type === 'audio') {
                console.log(`[Голосовое] id=${rows[0].id} ${userId}→${receiverId}: получено ${audio_data ? audio_data.length : 0} Б, в БД ${rows[0].audio_data ? rows[0].audio_data.length : 0} Б`);
            }
            const saved = toBase64(rows[0]);

            io.to(`chat_${receiverId}`).to(`chat_${userId}`).emit('message:new', saved);

            let preview = saved.text || '';
            if (msg_type === 'image') preview = '🖼️ Фотография';
            if (msg_type === 'audio') preview = '🎙️ Голосовое сообщение';
            if (msg_type === 'file') preview = '📄 Файл';

            io.to(`user_${receiverId}`).emit('chat:list_update', {
                chatId: userId,
                partnerId: userId,
                messageId: saved.id,
                lastMessage: preview,
                senderId: userId,
                timestamp: saved.created_at,
                unread: true
            });

            cb?.({ ok: true, message: saved });
        } catch (err) {
            console.error('chat:send', err);
            cb?.({ ok: false, error: 'DB_ERROR' });
        }
    });

    socket.on('chat:edit', async ({ chatId, msgId, text }, cb) => {
        try {
            const [result] = await db.execute(
                'UPDATE messages SET text = ? WHERE id = ? AND sender_id = ?',
                [text, msgId, userId]
            );
            if (result.affectedRows === 0) return cb?.({ ok: false, error: 'NOT_FOUND_OR_FORBIDDEN' });

            io.to(`chat_${chatId}`).to(`chat_${userId}`).emit('message:edit', { id: msgId, text });
            cb?.({ ok: true });
        } catch (err) {
            console.error('chat:edit', err);
            cb?.({ ok: false, error: 'DB_ERROR' });
        }
    });

    socket.on('chat:delete', async ({ chatId, msgId }, cb) => {
        try {
            const [result] = await db.execute(
                'DELETE FROM messages WHERE id = ? AND sender_id = ?',
                [msgId, userId]
            );
            if (result.affectedRows === 0) return cb?.({ ok: false, error: 'NOT_FOUND_OR_FORBIDDEN' });

            io.to(`chat_${chatId}`).to(`chat_${userId}`).emit('message:delete', { id: msgId });
            cb?.({ ok: true });
        } catch (err) {
            console.error('chat:delete', err);
            cb?.({ ok: false, error: 'DB_ERROR' });
        }
    });

    socket.on('typing:start', ({ chatId }) => {
        socket.to(`chat_${chatId}`).emit('typing', { userId, typing: true });
    });

    socket.on('typing:stop', ({ chatId }) => {
        socket.to(`chat_${chatId}`).emit('typing', { userId, typing: false });
    });

    // ════════════════ ГРУППОВЫЕ ЧАТЫ ════════════════

    socket.on('groups:list', async (_payload, cb) => {
        try {
            // Одним проходом: последнее НЕудалённое сообщение по каждой группе через
            // ROW_NUMBER() (как в conversations:list) + число участников отдельным агрегатом.
            // Раньше на каждую группу было 5 коррелированных подзапросов — отсюда тормоза.
            const query = `
        SELECT gc.id, gc.name, gc.avatar_color,
               lm.text AS last_text,
               lm.has_image AS last_has_image,
               lm.has_audio AS last_has_audio,
               lm.has_file  AS last_has_file,
               lm.created_at AS last_time,
               COALESCE(mc.member_count, 0) AS member_count
        FROM group_chats gc
        JOIN group_members gmem ON gmem.group_id = gc.id AND gmem.user_id = ?
        LEFT JOIN (
          SELECT x.group_id, x.text, x.has_image, x.has_audio, x.has_file, x.created_at
          FROM (
            SELECT gm.group_id, gm.text,
                   (gm.image_data IS NOT NULL) AS has_image,
                   (gm.audio_data IS NOT NULL) AS has_audio,
                   (gm.file_data  IS NOT NULL) AS has_file,
                   gm.created_at,
                   ROW_NUMBER() OVER (PARTITION BY gm.group_id ORDER BY gm.created_at DESC) AS rn
            FROM group_messages gm
            WHERE gm.is_deleted = 0
          ) x WHERE x.rn = 1
        ) lm ON lm.group_id = gc.id
        LEFT JOIN (
          SELECT group_id, COUNT(*) AS member_count FROM group_members GROUP BY group_id
        ) mc ON mc.group_id = gc.id
        ORDER BY lm.created_at DESC, gc.name ASC
      `;
            const [rows] = await db.execute(query, [userId]);

            const groups = rows.map(g => {
                let preview = g.last_text || '';
                if (g.last_has_image) preview = '🖼️ Фотография';
                else if (g.last_has_audio) preview = '🎙️ Голосовое сообщение';
                else if (g.last_has_file) preview = '📄 Файл';

                return {
                    id: g.id,
                    name: g.name,
                    isGroup: true,
                    avatarColor: g.avatar_color || '#5865F2',
                    lastMessage: preview,
                    lastMessageAt: g.last_time,
                    memberCount: g.member_count
                };
            });
            cb?.({ ok: true, data: groups });
        } catch (err) {
            console.error('groups:list', err);
            cb?.({ ok: false, error: 'DB_ERROR' });
        }
    });

    socket.on('groups:create', async ({ name, memberIds }, cb) => {
        try {
            if (!name || !name.trim()) return cb?.({ ok: false, error: 'NAME_REQUIRED' });

            const [result] = await db.execute(
                'INSERT INTO group_chats (name, created_by) VALUES (?, ?)',
                [name.trim(), userId]
            );
            const groupId = result.insertId;

            await db.execute(
                'INSERT INTO group_members (group_id, user_id, is_admin) VALUES (?, ?, 1)',
                [groupId, userId]
            );

            const ids = Array.isArray(memberIds) ? memberIds.filter(id => Number(id) !== Number(userId)) : [];
            for (const uid of ids) {
                await db.execute(
                    'INSERT INTO group_members (group_id, user_id, is_admin) VALUES (?, ?, 0)',
                    [groupId, uid]
                );
                io.in(`user_${uid}`).socketsJoin(`group_${groupId}`);
            }
            socket.join(`group_${groupId}`);

            io.to(`group_${groupId}`).emit('group:created', { id: groupId, name: name.trim() });
            cb?.({ ok: true, id: groupId, name: name.trim() });
        } catch (err) {
            console.error('groups:create', err);
            cb?.({ ok: false, error: 'DB_ERROR' });
        }
    });

    socket.on('group:members', async ({ groupId }, cb) => {
        try {
            const [rows] = await db.execute(
                `SELECT u.id, u.login, u.Name, u.Surname, gmem.is_admin
         FROM group_members gmem JOIN users u ON u.id = gmem.user_id
         WHERE gmem.group_id = ? ORDER BY gmem.is_admin DESC, u.Name ASC`,
                [groupId]
            );
            cb?.({ ok: true, members: rows });
        } catch (err) {
            console.error('group:members', err);
            cb?.({ ok: false, error: 'DB_ERROR' });
        }
    });

    socket.on('group:leave_membership', async ({ groupId }, cb) => {
        try {
            await db.execute('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId]);
            socket.leave(`group_${groupId}`);
            io.to(`group_${groupId}`).emit('group:member_left', { groupId, userId });
            cb?.({ ok: true });
        } catch (err) {
            console.error('group:leave_membership', err);
            cb?.({ ok: false, error: 'DB_ERROR' });
        }
    });

    socket.on('group:join', async ({ groupId }, cb) => {
        try {
            socket.join(`group_${groupId}`);

            const [rows] = await db.execute(
                `SELECT gm.id, gm.group_id, gm.sender_id, gm.text, gm.image_data, gm.audio_data,
                gm.file_data, gm.file_name, gm.created_at,
                u.login AS sender_login, u.Name AS sender_name
         FROM group_messages gm
         JOIN users u ON u.id = gm.sender_id
         WHERE gm.group_id = ?
         ORDER BY gm.created_at ASC`,
                [groupId]
            );

            const history = rows.map(m => {
                m.msg_type = detectMsgType(m);
                return toHistoryPreview(m);
            });

            cb?.({ ok: true, history });
        } catch (err) {
            console.error('group:join', err);
            cb?.({ ok: false, error: 'DB_ERROR' });
        }
    });

    // Подгрузка файла конкретного группового сообщения по требованию
    socket.on('group:message:file', async ({ msgId }, cb) => {
        try {
            const [rows] = await db.execute(
                'SELECT image_data, audio_data, file_data, file_name FROM group_messages WHERE id = ?',
                [msgId]
            );
            if (!rows.length) return cb?.({ ok: false, error: 'NOT_FOUND' });
            cb?.({ ok: true, ...toBase64(rows[0]) });
        } catch (err) {
            console.error('group:message:file', err);
            cb?.({ ok: false, error: 'DB_ERROR' });
        }
    });

    socket.on('group:send', async ({ groupId, text, file }, cb) => {
        try {
            const { image_data, audio_data, file_data, file_name, msg_type } = splitIncomingFile(file);

            const [result] = await db.execute(
                `INSERT INTO group_messages (group_id, sender_id, text, image_data, audio_data, file_data, file_name)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [groupId, userId, text || '', image_data, audio_data, file_data, file_name]
            );

            const [rows] = await db.execute('SELECT * FROM group_messages WHERE id = ?', [result.insertId]);
            if (msg_type === 'audio') {
                console.log(`[Голосовое-группа] id=${rows[0].id} группа=${groupId} от=${userId}: получено ${audio_data ? audio_data.length : 0} Б, в БД ${rows[0].audio_data ? rows[0].audio_data.length : 0} Б`);
            }
            const saved = toBase64(rows[0]);
            saved.msg_type = msg_type;

            io.to(`group_${groupId}`).emit('group:message:new', saved);

            let preview = saved.text || '';
            if (msg_type === 'image') preview = '🖼️ Фотография';
            if (msg_type === 'audio') preview = '🎙️ Голосовое сообщение';
            if (msg_type === 'file') preview = '📄 Файл';

            const [members] = await db.execute(
                'SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?',
                [groupId, userId]
            );
            members.forEach(m => {
                io.to(`user_${m.user_id}`).emit('group:list_update', {
                    groupId: Number(groupId),
                    messageId: saved.id,
                    lastMessage: preview,
                    senderId: userId,
                    timestamp: saved.created_at,
                    unread: true
                });
            });

            cb?.({ ok: true, message: saved });
        } catch (err) {
            console.error('group:send', err);
            cb?.({ ok: false, error: 'DB_ERROR' });
        }
    });

    socket.on('group:edit', async ({ groupId, msgId, text }, cb) => {
        try {
            const [result] = await db.execute(
                'UPDATE group_messages SET text = ? WHERE id = ? AND sender_id = ?',
                [text, msgId, userId]
            );
            if (result.affectedRows === 0) return cb?.({ ok: false, error: 'NOT_FOUND_OR_FORBIDDEN' });

            io.to(`group_${groupId}`).emit('group:message:updated', { msgId, text });
            cb?.({ ok: true });
        } catch (err) {
            console.error('group:edit', err);
            cb?.({ ok: false, error: 'DB_ERROR' });
        }
    });

    socket.on('group:delete', async ({ groupId, msgId }, cb) => {
        try {
            const [result] = await db.execute(
                'DELETE FROM group_messages WHERE id = ? AND sender_id = ?',
                [msgId, userId]
            );
            if (result.affectedRows === 0) return cb?.({ ok: false, error: 'NOT_FOUND_OR_FORBIDDEN' });

            io.to(`group_${groupId}`).emit('group:message:deleted', { msgId });
            cb?.({ ok: true });
        } catch (err) {
            console.error('group:delete', err);
            cb?.({ ok: false, error: 'DB_ERROR' });
        }
    });
};
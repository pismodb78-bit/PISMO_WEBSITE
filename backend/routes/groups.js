const express = require('express');
const router = express.Router();
const multer = require('multer');
const db = require('../db');
const authMiddleware = require('../middleware/auth');

const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 50 * 1024 * 1024 }
});

// ============================================================
// СХЕМА (как в десктопном клиенте, не менять имена таблиц/колонок):
//   group_chats(id, name, created_by, avatar_color)
//   group_members(group_id, user_id, is_admin)
//   group_messages(id, group_id, sender_id, text, image_data, audio_data,
//                   video_data, file_data, file_name, created_at,
//                   reply_to_id, is_deleted, edited_at)
// Десктоп НЕ пишет msg_type — тип сообщения определяем по наличию BLOB-данных,
// так же, как мы уже делаем в routes/messages.js для личных сообщений.
// ============================================================

// 1. СПИСОК ГРУПП ПОЛЬЗОВАТЕЛЯ (с превью последнего сообщения и числом участников)
router.get('/', authMiddleware, async (req, res) => {
  try {
    const myId = req.user.id;

    const query = `
      SELECT gc.id, gc.name, gc.avatar_color,
             (SELECT gm2.text FROM group_messages gm2
               WHERE gm2.group_id = gc.id AND gm2.is_deleted = 0
               ORDER BY gm2.created_at DESC LIMIT 1) AS last_text,
             (SELECT gm2.image_data IS NOT NULL FROM group_messages gm2
               WHERE gm2.group_id = gc.id AND gm2.is_deleted = 0
               ORDER BY gm2.created_at DESC LIMIT 1) AS last_has_image,
             (SELECT gm2.audio_data IS NOT NULL FROM group_messages gm2
               WHERE gm2.group_id = gc.id AND gm2.is_deleted = 0
               ORDER BY gm2.created_at DESC LIMIT 1) AS last_has_audio,
             (SELECT gm2.file_data IS NOT NULL FROM group_messages gm2
               WHERE gm2.group_id = gc.id AND gm2.is_deleted = 0
               ORDER BY gm2.created_at DESC LIMIT 1) AS last_has_file,
             (SELECT MAX(gm3.created_at) FROM group_messages gm3
               WHERE gm3.group_id = gc.id) AS last_time,
             (SELECT COUNT(*) FROM group_members gmem2 WHERE gmem2.group_id = gc.id) AS member_count
      FROM group_chats gc
      JOIN group_members gmem ON gmem.group_id = gc.id AND gmem.user_id = ?
      ORDER BY last_time DESC, gc.name ASC
    `;

    const [rows] = await db.execute(query, [myId]);

    const groups = rows.map(g => {
      let preview = g.last_text || '';
      if (g.last_has_image) preview = '🖼️ Фотография';
      else if (g.last_has_audio) preview = '🎙️ Голосовое сообщение';
      else if (g.last_has_file) preview = '📄 Файл';

      return {
        id: g.id,
        name: g.name,
        avatarColor: g.avatar_color || '#5865F2',
        lastMessage: preview,
        lastMessageAt: g.last_time,
        memberCount: g.member_count
      };
    });

    return res.json(groups);
  } catch (error) {
    console.error('Ошибка загрузки списка групп:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// 2. СОЗДАНИЕ ГРУППЫ
// body: { name: string, memberIds: number[] }  — создатель добавляется автоматически как admin
router.post('/', authMiddleware, async (req, res) => {
  try {
    const myId = req.user.id;
    const { name, memberIds } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Название группы обязательно' });
    }

    const [result] = await db.execute(
      'INSERT INTO group_chats (name, created_by) VALUES (?, ?)',
      [name.trim(), myId]
    );
    const groupId = result.insertId;

    // создатель — всегда админ группы
    await db.execute(
      'INSERT INTO group_members (group_id, user_id, is_admin) VALUES (?, ?, 1)',
      [groupId, myId]
    );

    const ids = Array.isArray(memberIds) ? memberIds.filter(id => Number(id) !== Number(myId)) : [];
    for (const uid of ids) {
      await db.execute(
        'INSERT INTO group_members (group_id, user_id, is_admin) VALUES (?, ?, 0)',
        [groupId, uid]
      );
    }

    return res.json({ id: groupId, name: name.trim() });
  } catch (error) {
    console.error('Ошибка создания группы:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// 3. УЧАСТНИКИ ГРУППЫ
router.get('/:groupId/members', authMiddleware, async (req, res) => {
  try {
    const { groupId } = req.params;

    const [rows] = await db.execute(
      `SELECT u.id, u.login, u.Name, u.Surname, gmem.is_admin
       FROM group_members gmem
       JOIN users u ON u.id = gmem.user_id
       WHERE gmem.group_id = ?
       ORDER BY gmem.is_admin DESC, u.Name ASC`,
      [groupId]
    );

    return res.json(rows);
  } catch (error) {
    console.error('Ошибка загрузки участников группы:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// 4. ВЫХОД ИЗ ГРУППЫ
router.post('/:groupId/leave', authMiddleware, async (req, res) => {
  try {
    const { groupId } = req.params;
    const myId = req.user.id;

    await db.execute(
      'DELETE FROM group_members WHERE group_id = ? AND user_id = ?',
      [groupId, myId]
    );

    return res.json({ success: true });
  } catch (error) {
    console.error('Ошибка при выходе из группы:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// 5. ОТПРАВКА СООБЩЕНИЯ В ГРУППУ
router.post('/:groupId/messages', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const sender_id = req.user.id;
    const { groupId } = req.params;
    const { text } = req.body;

    let image_data = null;
    let audio_data = null;
    let file_data = null;
    let file_name = null;
    let msg_type = 'text';

    if (req.file) {
      file_name = req.file.originalname;
      const mimeType = req.file.mimetype;
      const lowerName = file_name.toLowerCase();

      if (mimeType.startsWith('image/')) {
        msg_type = 'image';
        image_data = req.file.buffer;
      } else if (
        mimeType.startsWith('audio/') ||
        lowerName.endsWith('.webm') || lowerName.endsWith('.ogg') ||
        lowerName.endsWith('.wav') || lowerName.endsWith('.mp3') || lowerName.endsWith('.m4a')
      ) {
        msg_type = 'audio';
        audio_data = req.file.buffer;
      } else {
        msg_type = 'file';
        file_data = req.file.buffer;
      }
    }

    const [result] = await db.execute(
      `INSERT INTO group_messages (group_id, sender_id, text, image_data, audio_data, file_data, file_name)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [groupId, sender_id, text || '', image_data, audio_data, file_data, file_name]
    );

    const [rows] = await db.execute('SELECT * FROM group_messages WHERE id = ?', [result.insertId]);
    const saved = rows[0];

    // Тип сообщения для фронта — определяем по наличию данных, как и при чтении истории
    saved.msg_type = msg_type;
    if (saved.image_data) saved.image_data = saved.image_data.toString('base64');
    if (saved.audio_data) saved.audio_data = saved.audio_data.toString('base64');
    if (saved.file_data) saved.file_data = saved.file_data.toString('base64');

    // Real-time: рассылаем всем, кто сейчас в комнате этой группы
    if (global.io) {
      global.io.to(`group_${groupId}`).emit('group:message:new', saved);

      // Превью для сайдбара — отправляем персонально каждому участнику группы,
      // КРОМЕ отправителя (ему обновление списка не нужно, он и так видит свежее сообщение)
      let previewText = saved.text || '';
      if (msg_type === 'image') previewText = '🖼️ Фотография';
      if (msg_type === 'audio') previewText = '🎙️ Голосовое сообщение';
      if (msg_type === 'file') previewText = '📄 Файл';

      const [members] = await db.execute(
        'SELECT user_id FROM group_members WHERE group_id = ? AND user_id != ?',
        [groupId, sender_id]
      );
      members.forEach(m => {
        global.io.to(`user_${m.user_id}`).emit('group:list_update', {
          groupId: Number(groupId),
          messageId: saved.id,
          lastMessage: previewText,
          senderId: sender_id,
          timestamp: saved.created_at,
          unread: true
        });
      });
    }

    return res.json(saved);
  } catch (error) {
    console.error('Ошибка отправки группового сообщения:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// 6. ИСТОРИЯ СООБЩЕНИЙ ГРУППЫ
router.get('/:groupId/messages', authMiddleware, async (req, res) => {
  try {
    const { groupId } = req.params;

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

    const processed = rows.map(msg => {
      // Десктоп не пишет msg_type — определяем тип по наличию BLOB-данных
      if (msg.image_data) msg.msg_type = 'image';
      else if (msg.audio_data) msg.msg_type = 'audio';
      else if (msg.file_data) msg.msg_type = 'file';
      else msg.msg_type = 'text';

      if (msg.image_data) msg.image_data = msg.image_data.toString('base64');
      if (msg.audio_data) msg.audio_data = msg.audio_data.toString('base64');
      if (msg.file_data) msg.file_data = msg.file_data.toString('base64');
      return msg;
    });

    return res.json(processed);
  } catch (error) {
    console.error('Ошибка загрузки истории группы:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// 7. УДАЛЕНИЕ ГРУППОВОГО СООБЩЕНИЯ (только своё)
router.delete('/messages/:messageId', authMiddleware, async (req, res) => {
  try {
    const { messageId } = req.params;
    const userId = req.user.id;

    const [result] = await db.execute(
      'DELETE FROM group_messages WHERE id = ? AND sender_id = ?',
      [messageId, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Сообщение не найдено или нет прав доступа' });
    }

    res.status(200).json({ message: 'Удалено' });
  } catch (err) {
    console.error('Ошибка при удалении группового сообщения:', err);
    res.status(500).json({ message: err.message });
  }
});

// 8. РЕДАКТИРОВАНИЕ ГРУППОВОГО СООБЩЕНИЯ (только своё)
router.put('/messages/:messageId', authMiddleware, async (req, res) => {
  try {
    const { messageId } = req.params;
    const { text } = req.body;
    const userId = req.user.id;

    const [result] = await db.execute(
      'UPDATE group_messages SET text = ? WHERE id = ? AND sender_id = ?',
      [text, messageId, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'Сообщение не найдено или нет прав доступа' });
    }

    res.status(200).json({ message: 'Обновлено' });
  } catch (err) {
    console.error('Ошибка при обновлении группового сообщения:', err);
    res.status(500).json({ message: err.message });
  }
});

module.exports = router;
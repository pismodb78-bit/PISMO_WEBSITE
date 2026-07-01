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

// 1. ОТПРАВКА СООБЩЕНИЯ
router.post('/', authMiddleware, upload.single('file'), async (req, res) => {
  try {
    const sender_id = req.user.id; 
    const { receiverId, text } = req.body;
    
    let msg_type = 'text';
    let image_data = null;
    let audio_data = null;
    let file_data = null;
    let file_name = null;

    if (req.file) {
      file_name = req.file.originalname;
      const mimeType = req.file.mimetype;

      if (mimeType.startsWith('image/')) {
        msg_type = 'image';
        image_data = req.file.buffer;
      } else if (mimeType.startsWith('audio/') || /\.(webm|ogg|wav|mp3|m4a)$/i.test(file_name)) {
        msg_type = 'audio';
        audio_data = req.file.buffer;
      } else {
        msg_type = 'file';
        file_data = req.file.buffer;
      }
    }

    const query = `
      INSERT INTO messages (sender_id, receiver_id, text, image_data, audio_data, file_data, file_name, msg_type) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;
    
    const [result] = await db.execute(query, [
      sender_id, 
      receiverId, 
      text || null, 
      image_data, 
      audio_data,
      file_data, 
      file_name, 
      msg_type
    ]);

    const [newMessageRows] = await db.execute('SELECT * FROM messages WHERE id = ?', [result.insertId]);
    const savedMessage = newMessageRows[0];

    // Диагностика голосовых: сравниваем размер полученного буфера и того, что реально
    // легло в БД. Если "в БД" заметно меньше "получено" — колонку audio_data режет тип
    // (обычный BLOB = 64 КБ); тогда нужно ALTER TABLE ... MODIFY audio_data LONGBLOB.
    if (msg_type === 'audio') {
      console.log(`[Голосовое] id=${savedMessage.id} ${sender_id}→${receiverId}: получено ${audio_data ? audio_data.length : 0} Б, в БД ${savedMessage.audio_data ? savedMessage.audio_data.length : 0} Б (mime=${req.file && req.file.mimetype}, file=${file_name})`);
    }

    if (savedMessage.image_data) savedMessage.image_data = savedMessage.image_data.toString('base64');
    if (savedMessage.audio_data) savedMessage.audio_data = savedMessage.audio_data.toString('base64');
    if (savedMessage.file_data) savedMessage.file_data = savedMessage.file_data.toString('base64');

    // Интеграция WebSockets реального времени
    if (global.io) {
      // 1. Отправляем новое сообщение в комнаты чатов (чтобы оно мгновенно появилось в окне чата на фронте)
      global.io.to(`chat_${savedMessage.receiver_id}`).to(`chat_${savedMessage.sender_id}`).emit('message:new', savedMessage);

      // 2. Формируем превью для сайдбара получателя
      let previewText = savedMessage.text || '';
      if (savedMessage.msg_type === 'image') previewText = '🖼️ Фотография';
      if (savedMessage.msg_type === 'audio') previewText = '🎙️ Голосовое сообщение';
      if (savedMessage.msg_type === 'file') previewText = '📄 Файл';

      // 3. Отправляем триггер для поднятия чата наверх в сайдбаре и инкремента счетчика непрочитанных
      global.io.to(`user_${savedMessage.receiver_id}`).emit('chat:list_update', {
          chatId: savedMessage.sender_id,
          partnerId: savedMessage.sender_id,
          messageId: savedMessage.id,
          lastMessage: previewText,
          senderId: savedMessage.sender_id,
          timestamp: savedMessage.created_at,
          unread: true
      });
    }

    // Обязательно возвращаем ответ клиенту, который делал HTTP-запрос
    return res.json(savedMessage);

  } catch (error) {
    console.error('Ошибка бэкенда при отправке сообщения:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// 2. СПИСОК ДИАЛОГОВ (последнее сообщение + счётчик непрочитанных по каждому собеседнику)
// ВАЖНО: этот роут должен стоять ВЫШЕ '/:chatId', иначе Express примет
// 'conversations' за параметр chatId и роут ниже его перехватит.
router.get('/conversations', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;

    // Для каждого собеседника берём ПОСЛЕДНЕЕ сообщение в диалоге.
    // Помимо текста и msg_type, забираем флаги "не NULL ли BLOB-колонка" —
    // это нужно, чтобы корректно показать превью для сообщений с десктопа,
    // у которых msg_type в БД не заполнен (десктоп никогда не писал это поле).
    const query = `
      SELECT
        partner_id,
        lm.text AS lastMessage,
        lm.msg_type AS lastMsgType,
        lm.image_data IS NOT NULL AS lastHasImage,
        lm.audio_data IS NOT NULL AS lastHasAudio,
        lm.file_data IS NOT NULL AS lastHasFile,
        lm.created_at AS lastMessageAt,
        u.unreadCount
      FROM (
        SELECT
          CASE
            WHEN sender_id = ? THEN receiver_id
            ELSE sender_id
          END AS partner_id
        FROM messages
        WHERE sender_id = ? OR receiver_id = ?
        GROUP BY partner_id
      ) p
      JOIN (
        /* Последнее сообщение по каждому партнёру */
        SELECT x.partner_id, x.text, x.msg_type, x.image_data, x.audio_data, x.file_data, x.created_at
        FROM (
          SELECT
            CASE
              WHEN m.sender_id = ? THEN m.receiver_id
              ELSE m.sender_id
            END AS partner_id,
            m.text,
            m.msg_type,
            m.image_data,
            m.audio_data,
            m.file_data,
            m.created_at,
            ROW_NUMBER() OVER (PARTITION BY (CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END) ORDER BY m.created_at DESC) AS rn
          FROM messages m
          WHERE (m.sender_id = ? OR m.receiver_id = ?)
        ) x
        WHERE x.rn = 1
      ) lm ON lm.partner_id = p.partner_id
      LEFT JOIN (
        /* Непрочитанные для текущего пользователя по каждому партнёру */
        SELECT
          m.sender_id AS partner_id,
          COUNT(*) AS unreadCount
        FROM messages m
        WHERE m.receiver_id = ? AND m.is_read = 0
        GROUP BY m.sender_id
      ) u ON u.partner_id = p.partner_id
      ORDER BY lm.created_at DESC
    `;

    const params = [
      userId, userId, userId,
      userId, userId, userId, userId,
      userId
    ];
    const [rows] = await db.execute(query, params);

    // Превращаем тип медиа в превью-текст. Не доверяем lastMsgType целиком —
    // десктоп его не заполняет, поэтому сначала смотрим на реальное наличие BLOB-данных.
    const result = rows.map(r => {
      let preview = r.lastMessage || '';
      let effectiveType = r.lastMsgType;
      if (r.lastHasImage) effectiveType = 'image';
      else if (r.lastHasAudio) effectiveType = 'audio';
      else if (r.lastHasFile) effectiveType = 'file';

      if (effectiveType === 'image') preview = '🖼️ Фотография';
      if (effectiveType === 'audio') preview = '🎙️ Голосовое сообщение';
      if (effectiveType === 'file') preview = '📄 Файл';
      return {
        id: r.partner_id,
        lastMessage: preview,
        lastMessageAt: r.lastMessageAt,
        unreadCount: r.unreadCount
      };
    });

    return res.json(result);
  } catch (error) {
    console.error('Ошибка бэкенда при загрузке списка диалогов:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// 3. ПОМЕТКА СООБЩЕНИЙ ОТ СОБЕСЕДНИКА КАК ПРОЧИТАННЫХ (вызывается при открытии чата)
router.patch('/read/:partnerId', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const { partnerId } = req.params;

    await db.execute(
      'UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ? AND is_read = 0',
      [partnerId, userId]
    );

    // Сообщаем отправителю (если он онлайн), что его сообщения прочитаны —
    // используется, например, для галочек "прочитано" в его окне чата
    if (global.io) {
      global.io.to(`chat_${partnerId}`).emit('messages:marked_read', { chatId: userId, userId });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Ошибка при пометке сообщений как прочитанных:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// 4. ПОЛУЧЕНИЕ ИСТОРИИ
router.get('/:chatId', authMiddleware, async (req, res) => {
  try {
    const userId = req.user.id;
    const chatId = req.params.chatId;

    const query = `
      SELECT id, sender_id, receiver_id, text, image_data, audio_data, file_data, file_name, msg_type, created_at 
      FROM messages 
      WHERE (sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?)
      ORDER BY created_at ASC
    `;

    const [rows] = await db.execute(query, [userId, chatId, chatId, userId]);

    const processedMessages = rows.map(msg => {
      // ВАЖНО: десктопный клиент (WinForms) никогда не писал поле msg_type —
      // он определяет тип сообщения по тому, какая BLOB-колонка не NULL.
      // Поэтому здесь мы делаем то же самое, не доверяя значению msg_type из БД,
      // чтобы голосовые/фото/файлы, отправленные с десктопа, тоже отображались.
      if (msg.image_data) {
        msg.msg_type = 'image';
      } else if (msg.audio_data) {
        msg.msg_type = 'audio';
      } else if (msg.file_data) {
        msg.msg_type = 'file';
      } else if (!msg.msg_type) {
        msg.msg_type = 'text';
      }

      if (msg.image_data) msg.image_data = msg.image_data.toString('base64');
      if (msg.audio_data) msg.audio_data = msg.audio_data.toString('base64');
      if (msg.file_data) msg.file_data = msg.file_data.toString('base64');
      return msg;
    });

    return res.json(processedMessages);
  } catch (error) {
    console.error('Ошибка бэкенда при загрузке истории:', error);
    return res.status(500).json({ error: 'Внутренняя ошибка сервера' });
  }
});

// 5. УДАЛЕНИЕ СООБЩЕНИЯ
router.delete('/:messageId', authMiddleware, async (req, res) => {
    try {
        const { messageId } = req.params;
        const userId = req.user.id;
        
        // Удаляем только если сообщение принадлежит текущему пользователю
        const [result] = await db.execute('DELETE FROM messages WHERE id = ? AND sender_id = ?', [messageId, userId]);
        
        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Сообщение не найдено или нет прав доступа' });
        }
        
        res.status(200).json({ message: 'Удалено' });
    } catch (err) {
        console.error('Ошибка при удалении:', err);
        res.status(500).json({ message: err.message });
    }
});

// 6. РЕДАКТИРОВАНИЕ СООБЩЕНИЯ
router.put('/:messageId', authMiddleware, async (req, res) => {
    try {
        const { messageId } = req.params;
        const { text } = req.body;
        const userId = req.user.id;

        // Обновляем только если сообщение принадлежит текущему пользователю
        const [result] = await db.execute(
            'UPDATE messages SET text = ? WHERE id = ? AND sender_id = ?', 
            [text, messageId, userId]
        );

        if (result.affectedRows === 0) {
            return res.status(404).json({ message: 'Сообщение не найдено или нет прав доступа' });
        }

        res.status(200).json({ message: 'Обновлено' });
    } catch (err) {
        console.error('Ошибка при обновлении:', err);
        res.status(500).json({ message: err.message });
    }
});

module.exports = router;
module.exports = (io, socket) => {
  const db = require('../db');

  // 0. Авторизация пользователя в сокетах.
  // Это ЕДИНСТВЕННОЕ место, где обрабатывается 'join' — в server.js его больше нет.
  socket.on('join', async (userId) => {
    if (!userId) return;

    socket.userId = userId; // запоминаем на самом сокете, пригодится для logging/debug
    socket.join(`user_${userId}`);

    // Подключаемся к комнатам ВСЕХ групп, в которых состоит пользователь,
    // чтобы групповые сообщения долетали в реальном времени даже когда
    // конкретное окно группы не открыто (нужно для бейджей в сайдбаре)
    try {
      const [rows] = await db.execute(
        'SELECT group_id FROM group_members WHERE user_id = ?',
        [userId]
      );
      rows.forEach(r => socket.join(`group_${r.group_id}`));
    } catch (err) {
      console.error('Ошибка подключения к комнатам групп:', err);
    }

    console.log(`[Socket] Пользователь ${userId} добавлен в персональную комнату user_${userId}`);
  });

  // 1. Пользователь открывает конкретный чат (окно чата на фронте)
  socket.on('chat:join', ({ chatId, userId }) => {
    socket.join(`chat_${chatId}`);
    console.log(`[Socket] Пользователь ${userId} открыл комнату чата chat_${chatId}`);

    socket.to(`chat_${chatId}`).emit('messages:marked_read', { chatId, userId });
  });

  // 2. Пользователь уходит из чата
  socket.on('chat:leave', ({ chatId, userId }) => {
    socket.leave(`chat_${chatId}`);
    console.log(`[Socket] Пользователь ${userId} покинул комнату чата chat_${chatId}`);
  });

  // 3. Сигнал о новом сообщении (вызывается веб-клиентом при отправке)
  // Важно: сообщения в веб-клиенте отправляются через HTTP `/api/messages`.
  // Поэтому `chat:list_update` должен генерироваться только там (backend/routes/messages.js),
  // чтобы не было дублей/расхождения по payload.
  // Этот обработчик оставляем только если где-то в клиенте всё же шлют `message:new` по socket.
  socket.on('message:new', (newMessage) => {
    try {
      io.to(`chat_${newMessage.receiver_id}`).to(`chat_${newMessage.sender_id}`).emit('message:new', newMessage);
    } catch (error) {
      console.error('Ошибка распределения сокет-события сообщения:', error);
    }
  });

  // 4. Синхронизация редактирования сообщения в реальном времени
  socket.on('message:edit', ({ chatId, msgId, text }) => {
    io.to(`chat_${chatId}`).emit('message:edit', { id: msgId, text });
    io.to(`chat_${chatId}`).emit('message:updated', { msgId, text });
  });

  // 5. Синхронизация удаления сообщения в реальном времени
  socket.on('message:delete', ({ chatId, msgId }) => {
    io.to(`chat_${chatId}`).emit('message:delete', { id: msgId });
    io.to(`chat_${chatId}`).emit('message:deleted', { msgId });
  });

  // 6. Индикатор "печатает..." (опционально, но раз уж делаем real-time по полной)
  socket.on('typing:start', ({ chatId, userId }) => {
    socket.to(`chat_${chatId}`).emit('typing', { userId, typing: true });
  });

  socket.on('typing:stop', ({ chatId, userId }) => {
    socket.to(`chat_${chatId}`).emit('typing', { userId, typing: false });
  });

  // ════════════════════════════════════════════════════════
  //  ГРУППОВЫЕ ЧАТЫ
  //  Отправка сообщения идёт через HTTP (POST /api/groups/:id/messages),
  //  сервер сам рассылает 'group:message:new' через global.io — здесь только
  //  присоединение к комнате группы при открытии окна чата и edit/delete.
  // ════════════════════════════════════════════════════════

  // 7. Пользователь открыл окно конкретной группы
  socket.on('group:join', ({ groupId, userId }) => {
    socket.join(`group_${groupId}`);
    console.log(`[Socket] Пользователь ${userId} открыл группу group_${groupId}`);
  });

  // 8. Пользователь закрыл окно группы (комнату не покидаем полностью —
  // пользователь должен продолжать получать новые сообщения для бейджа в сайдбаре;
  // group_${groupId} комната уже была выдана при 'join' по всем группам пользователя)

  // 9. Синхронизация редактирования группового сообщения
  socket.on('group:message:edit', ({ groupId, msgId, text }) => {
    io.to(`group_${groupId}`).emit('group:message:updated', { msgId, text });
  });

  // 10. Синхронизация удаления группового сообщения
  socket.on('group:message:delete', ({ groupId, msgId }) => {
    io.to(`group_${groupId}`).emit('group:message:deleted', { msgId });
  });
};
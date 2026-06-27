
const express = require('express');
const router = express.Router();

// POST /api/notify-message
// Body: { receiverId, senderId, senderName, text }
// Emits only to socket room for receiver: user_${receiverId}
router.post('/notify-message', async (req, res) => {
  try {
    const { receiverId, senderId, senderName, text } = req.body || {}; 


    if (!receiverId) {
      return res.status(400).json({ error: 'receiverId is required' });
    }

    // io instance is stored in global.io (see backend/server.js)
    if (!global.io) {
      return res.status(503).json({ error: 'Socket.IO is not initialized' });
    }

    const payload = {
      receiverId: Number(receiverId),
      senderId: senderId != null ? Number(senderId) : null,
      senderName: senderName || 'Пользователь',
      text: text || '',
      createdAt: new Date().toISOString()
    };


    // Only send to конкретному получателю
    global.io.to(`user_${receiverId}`).emit('new_message', payload);

    return res.json({ ok: true });
  } catch (e) {
    console.error('notify-message error:', e);
    return res.status(500).json({ error: 'Internal error' });
  }
});

module.exports = router;


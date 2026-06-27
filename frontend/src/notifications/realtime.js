import { socket } from '../socket';

function getSound() {
  return new Audio('/notification.mp3');
}

function canRequestNotificationPermission() {
  return typeof Notification !== 'undefined' && Notification.permission === 'default';
}

function notifyBrowser(payload) {
  try {
    if (typeof Notification === 'undefined') return;

    if (Notification.permission === 'granted') {
      new Notification('PISMO — новое сообщение', {
        body: `${payload.senderName || 'Пользователь'}: ${payload.text || ''}`
      });
      return;
    }

    if (canRequestNotificationPermission()) {
      Notification.requestPermission().then((perm) => {
        if (perm === 'granted') {
          new Notification('PISMO — новое сообщение', {
            body: `${payload.senderName || 'Пользователь'}: ${payload.text || ''}`
          });
        }
      }).catch(() => {});
    }
  } catch (_) {}
}

export function initRealtimeNotifications({ userId, activeChatIdProvider }) {
  if (!socket) return;

  const audio = getSound();
  audio.volume = 0.5;

  const shouldNotify = (payload) => {
    const activePartnerId = activeChatIdProvider?.() ?? null; // partnerId личного чата

    // Если сейчас открыт личный чат с этим отправителем — не уведомляем.
    // Для этого backend должен послать senderId (id отправителя).
    const senderId = payload.senderId ?? null;

    if (activePartnerId && senderId && Number(activePartnerId) === Number(senderId)) {
      return false;
    }

    return true;
  };


  socket.on('new_message', (payload) => {
    if (!payload || payload.receiverId !== userId) return;
    if (payload.senderId != null && Number(payload.senderId) === Number(userId)) return;

    if (!shouldNotify(payload)) return;

    audio.play().catch(() => {});
    notifyBrowser(payload);
  });
}


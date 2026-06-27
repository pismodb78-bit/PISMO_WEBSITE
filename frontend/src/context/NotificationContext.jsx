import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { socket } from '../socket';

const NotificationContext = createContext(null);

export function useNotifications() {
  return useContext(NotificationContext);
}

// userId — текущий залогиненный пользователь (нужен, чтобы не считать свои же сообщения)
// activeChatId — id чата, который открыт ПРЯМО СЕЙЧАС (передаётся из App.jsx)
export function NotificationProvider({ userId, activeChatId, children }) {
  // { [partnerId]: count }
  const [unreadCounts, setUnreadCounts] = useState({});
  const audioRef = useRef(null);

  // подгружаем звук уведомления один раз
  useEffect(() => {
    audioRef.current = new Audio('/notification.mp3');
    audioRef.current.volume = 0.5;
  }, []);

  const playSound = useCallback(() => {
    // play() может быть заблокирован браузером до первого взаимодействия пользователя со страницей —
    // это нормально, ошибку просто проглатываем
    audioRef.current?.play().catch(() => {});
  }, []);

  useEffect(() => {
    if (!userId) return;

    function handleListUpdate(data) {


      // data: { partnerId, ... }
      // partnerId — тот собеседник, чей чат должен увеличить unread.
      const partnerId = data.partnerId ?? data.senderId;

      // Игнорируем сообщения, отправленные самим себе с другого устройства
      if (Number(partnerId) === Number(userId)) return;

      // В десктопе было: если sid == _currentChatPartnerId — не уведомлять.
      const isChatOpen = Number(partnerId) === Number(activeChatId);
      if (isChatOpen) return;

      setUnreadCounts(prev => ({
        ...prev,
        [partnerId]: (prev[partnerId] || 0) + 1
      }));

      // Звук/уведомления не должны срабатывать массово.
      // browser может заблокировать play() без жеста пользователя — catch у нас уже есть.
      playSound();

      // (опционально) нативное уведомление браузера, как аналог tray balloon
      try {
        if (document.visibilityState !== 'visible' && Notification.permission === 'granted') {
          // senderName нам не передают — показываем id.
          // можно позже обогатить данными через карточки пользователей.
          new Notification('PISMO — новое сообщение', {
            body: `Сообщение от ${partnerId}`
          });
        }
      } catch (e) {}
    }

    socket.on('chat:list_update', handleListUpdate);
    return () => socket.off('chat:list_update', handleListUpdate);
  }, [userId, activeChatId, playSound]);

  // когда юзер открывает чат — сбрасываем бейдж для этого собеседника
  useEffect(() => {
    if (!activeChatId) return;
    setUnreadCounts(prev => {
      if (!prev[activeChatId]) return prev;
      const next = { ...prev };
      delete next[activeChatId];
      return next;
    });
  }, [activeChatId]);

  // заголовок вкладки с общим счётчиком — "(3) PISMO"
  useEffect(() => {
    const total = Object.values(unreadCounts).reduce((a, b) => a + b, 0);
    document.title = total > 0 ? `(${total}) PISMO` : 'PISMO';
  }, [unreadCounts]);

  const getUnreadCount = useCallback(
    (partnerId) => unreadCounts[partnerId] || 0,
    [unreadCounts]
  );

  const clearUnread = useCallback((partnerId) => {
    setUnreadCounts(prev => {
      if (!prev[partnerId]) return prev;
      const next = { ...prev };
      delete next[partnerId];
      return next;
    });
  }, []);

  const value = { unreadCounts, getUnreadCount, clearUnread };

  return (
    <NotificationContext.Provider value={value}>
      {children}
    </NotificationContext.Provider>
  );
}

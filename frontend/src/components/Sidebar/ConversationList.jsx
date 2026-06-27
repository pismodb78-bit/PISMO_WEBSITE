import React, { useEffect, useState } from 'react';
import api from '../../api';
import { useNotifications } from '../../context/NotificationContext';
import { socket } from '../../socket';

const ConversationList = ({ activeChat, onSelectChat }) => {
  const [conversations, setConversations] = useState([]);
  const { getUnreadCount } = useNotifications();

  const fetchConversations = async () => {
    try {
      const response = await api.get('/messages/conversations');
      setConversations(response.data);
    } catch (err) {
      console.error('Ошибка загрузки списка диалогов:', err);
    }
  };

  useEffect(() => {
    fetchConversations();
  }, []);

  // обновляем превью последнего сообщения и порядок диалогов в реальном времени
  useEffect(() => {
    function handleListUpdate(data) {
      setConversations(prev => {
        const existing = prev.find(c => Number(c.id) === Number(data.chatId));
        const updated = {
          ...(existing || { id: data.chatId }),
          lastMessage: data.lastMessage,
          lastMessageAt: data.timestamp
        };
        const rest = prev.filter(c => Number(c.id) !== Number(data.chatId));
        // поднимаем диалог с новым сообщением наверх списка
        return [updated, ...rest];
      });
    }

    socket.on('chat:list_update', handleListUpdate);
    return () => socket.off('chat:list_update', handleListUpdate);
  }, []);

  const styles = {
    list: { flex: 1, overflowY: 'auto', padding: '8px' },
    item: (isActive) => ({
      display: 'flex',
      alignItems: 'center',
      padding: '10px 12px',
      borderRadius: '8px',
      cursor: 'pointer',
      backgroundColor: isActive ? 'var(--bg-modifier-selected, #393c43)' : 'transparent',
      marginBottom: '4px',
      position: 'relative'
    }),
    avatar: { width: '36px', height: '36px', borderRadius: '50%', backgroundColor: '#5865F2', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 'bold', marginRight: '12px', flexShrink: 0 },
    info: { flex: 1, overflow: 'hidden' },
    name: { color: '#fff', fontSize: '14px', fontWeight: '500', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
    preview: { color: 'var(--text-muted)', fontSize: '12px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' },
    badge: { backgroundColor: '#ed4245', color: '#fff', borderRadius: '10px', minWidth: '20px', height: '20px', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '11px', fontWeight: 'bold', padding: '0 6px', marginLeft: '8px', flexShrink: 0 }
  };

  return (
    <div style={styles.list}>
      {conversations.map((chat) => {
        const isActive = activeChat && Number(activeChat.id) === Number(chat.id);
        const unread = getUnreadCount(chat.id);
        const displayName = chat.Name || chat.login || `Пользователь ${chat.id}`;

        return (
          <div
            key={chat.id}
            style={styles.item(isActive)}
            onClick={() => onSelectChat(chat)}
          >
            <div style={styles.avatar}>{(displayName[0] || '?').toUpperCase()}</div>
            <div style={styles.info}>
              <div style={styles.name}>{displayName}</div>
              {chat.lastMessage && <div style={styles.preview}>{chat.lastMessage}</div>}
            </div>
            {unread > 0 && <div style={styles.badge}>{unread > 99 ? '99+' : unread}</div>}
          </div>
        );
      })}
    </div>
  );
};

export default ConversationList;

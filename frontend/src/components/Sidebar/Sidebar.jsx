import React, { useState, useEffect } from 'react';
import api from '../../api';
import CreateGroupModal from '../Groups/CreateGroupModal';
import SettingsMenu from '../Settings/SettingsMenu';

const Sidebar = ({ user, onLogout, activeChat, onSelectChat, socket }) => {
  const [usersList, setUsersList] = useState([]);
  const [loading, setLoading] = useState(true);

  const [chatMeta, setChatMeta] = useState({});

  const [groupsList, setGroupsList] = useState([]);
  const [groupMeta, setGroupMeta] = useState({});
  const [showCreateGroup, setShowCreateGroup] = useState(false);

  const fetchGroups = async () => {
    try {
      const response = await api.get('/groups');
      setGroupsList(response.data);
    } catch (err) {
      console.error('Ошибка при загрузке групп:', err);
    }
  };

  useEffect(() => {
    fetchGroups();
  }, [user.id]);

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const response = await api.get('/auth/users');
        const filtered = response.data.filter(u => u.id !== user.id);
        setUsersList(filtered);
      } catch (err) {
        console.error('Ошибка при загрузке пользователей:', err);
      } finally {
        setLoading(false);
      }
    };

    fetchUsers();
  }, [user.id]);

  useEffect(() => {
    if (!socket) return;

    const handleChatListUpdate = ({ chatId, partnerId, lastMessage }) => {
      // Счётчики и ключи должны соответствовать тому же partnerId,
      // что использует NotificationContext.
      const targetId = partnerId ?? chatId;

      const isCurrentActive = activeChat && Number(activeChat.id) === Number(targetId);

      setChatMeta((prev) => {
        const currentMeta = prev[targetId] || { unreadCount: 0, lastMessage: '' };
        return {
          ...prev,
          [targetId]: {
            lastMessage: lastMessage,
            unreadCount: isCurrentActive ? 0 : currentMeta.unreadCount + 1
          }
        };
      });

      setUsersList((prevList) => {
        const targetUser = prevList.find(u => Number(u.id) === Number(targetId));
        if (!targetUser) return prevList;
        const filtered = prevList.filter(u => Number(u.id) !== Number(targetId));
        return [targetUser, ...filtered];
      });
    };

    socket.on('chat:list_update', handleChatListUpdate);

    const handleGroupListUpdate = ({ groupId, lastMessage }) => {
      const isCurrentActive = activeChat && activeChat.isGroup && Number(activeChat.id) === Number(groupId);

      setGroupMeta((prev) => {
        const currentMeta = prev[groupId] || { unreadCount: 0, lastMessage: '' };
        return {
          ...prev,
          [groupId]: {
            lastMessage: lastMessage,
            unreadCount: isCurrentActive ? 0 : currentMeta.unreadCount + 1
          }
        };
      });

      // поднимаем группу с новым сообщением наверх списка групп
      setGroupsList((prevList) => {
        const target = prevList.find(g => Number(g.id) === Number(groupId));
        if (!target) return prevList;
        const filtered = prevList.filter(g => Number(g.id) !== Number(groupId));
        return [target, ...filtered];
      });
    };

    socket.on('group:list_update', handleGroupListUpdate);

    return () => {
      socket.off('chat:list_update', handleChatListUpdate);
      socket.off('group:list_update', handleGroupListUpdate);
    };
  }, [socket, activeChat]);

  const handleUserClick = (selectedUser) => {
    setChatMeta((prev) => ({
      ...prev,
      [selectedUser.id]: {
        ...prev[selectedUser.id],
        unreadCount: 0
      }
    }));
    onSelectChat({ ...selectedUser, isGroup: false });
  };

  const handleGroupClick = (group) => {
    setGroupMeta((prev) => ({
      ...prev,
      [group.id]: {
        ...prev[group.id],
        unreadCount: 0
      }
    }));
    // isGroup: true позволяет ChatWindow и остальным компонентам отличать
    // групповой чат от личного, сохраняя единый формат activeChat
    onSelectChat({ id: group.id, Name: group.name, isGroup: true, avatarColor: group.avatarColor });
  };

  const handleGroupCreated = (newGroup) => {
    setShowCreateGroup(false);
    fetchGroups(); // подгружаем актуальный список с сервера (с member_count и т.д.)
  };

  const styles = {
    sidebar: { width: '260px', backgroundColor: 'var(--bg-secondary)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', borderRight: '1px solid rgba(0,0,0,0.2)', userSelect: 'none' },
    header: { padding: '20px', borderBottom: '1px solid rgba(0,0,0,0.1)' },
    title: { color: '#fff', margin: 0, fontSize: '18px', fontWeight: 'bold' },
    list: { padding: '10px', flex: 1, overflowY: 'auto' },
    sectionTitle: { color: 'var(--text-muted)', fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', marginBottom: '8px', paddingLeft: '8px' },
    userItem: { display: 'flex', alignItems: 'center', padding: '8px', borderRadius: '4px', cursor: 'pointer', marginBottom: '4px', color: 'var(--text-muted)', transition: 'background 0.2s, color 0.2s', position: 'relative' },
    avatar: { width: '32px', height: '32px', borderRadius: '50%', backgroundColor: 'var(--accent)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 'bold', marginRight: '10px', fontSize: '14px', flexShrink: 0 },
    footer: { padding: '10px', backgroundColor: 'var(--bg-tertiary)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' },
    userName: { fontWeight: 'bold', color: '#fff', fontSize: '14px', maxWidth: '120px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
    userRole: { fontSize: '12px', color: 'var(--text-muted)' },
    logoutBtn: { backgroundColor: 'var(--danger)', color: '#fff', border: 'none', padding: '6px 12px', borderRadius: '4px', cursor: 'pointer', fontSize: '12px', fontWeight: 'bold' },
    badge: { backgroundColor: '#f04747', color: '#fff', borderRadius: '10px', padding: '2px 6px', fontSize: '11px', fontWeight: 'bold', marginLeft: 'auto', flexShrink: 0 }
  };

  return (
    <div style={styles.sidebar}>
      <div style={styles.header}>
        <h3 style={styles.title}>PISMO</h3>
      </div>

      <div style={styles.list}>
        <div style={styles.sectionTitle}>Личные сообщения</div>
        
        {loading ? (
          <div style={{ color: 'var(--text-muted)', padding: '8px', fontSize: '14px' }}>Загрузка...</div>
        ) : usersList.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', padding: '8px', fontSize: '14px' }}>Нет доступных пользователей</div>
        ) : (
          usersList.map((u) => {
            const isActive = !activeChat?.isGroup && activeChat?.id === u.id;
            const meta = chatMeta[u.id] || { unreadCount: 0, lastMessage: '' };

            return (
              <div 
                key={u.id} 
                onClick={() => handleUserClick(u)}
                style={{
                  ...styles.userItem,
                  backgroundColor: isActive ? 'var(--bg-modifier-selected)' : 'transparent',
                  color: isActive ? 'var(--text-primary)' : 'var(--text-muted)'
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.backgroundColor = 'var(--bg-modifier-hover)';
                    e.currentTarget.style.color = 'var(--text-primary)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    e.currentTarget.style.color = 'var(--text-muted)';
                  }
                }}
              >
                <div style={styles.avatar}>
                  {u.Name ? u.Name[0].toUpperCase() : u.login[0].toUpperCase()}
                </div>
                <div style={{ overflow: 'hidden', flex: 1, paddingRight: '8px' }}>
                  <div style={{ fontSize: '14px', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {u.Name ? `${u.Name} ${u.Surname || ''}` : u.login}
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {meta.lastMessage ? meta.lastMessage : `@${u.login}`}
                  </div>
                </div>
                {meta.unreadCount > 0 && (
                  <span style={styles.badge}>{meta.unreadCount}</span>
                )}
              </div>
            );
          })
        )}

        <div style={{ ...styles.sectionTitle, marginTop: '20px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingRight: '8px' }}>
          <span>Группы</span>
          <button
            onClick={() => setShowCreateGroup(true)}
            title="Создать группу"
            style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '16px', fontWeight: 'bold', padding: 0, lineHeight: 1 }}
          >
            +
          </button>
        </div>

        {groupsList.length === 0 ? (
          <div style={{ color: 'var(--text-muted)', padding: '8px', fontSize: '14px' }}>Нет групп</div>
        ) : (
          groupsList.map((g) => {
            const isActive = activeChat?.isGroup && Number(activeChat.id) === Number(g.id);
            const meta = groupMeta[g.id] || { unreadCount: 0, lastMessage: g.lastMessage || '' };

            return (
              <div
                key={`group_${g.id}`}
                onClick={() => handleGroupClick(g)}
                style={{
                  ...styles.userItem,
                  backgroundColor: isActive ? 'var(--bg-modifier-selected)' : 'transparent',
                  color: isActive ? 'var(--text-primary)' : 'var(--text-muted)'
                }}
                onMouseEnter={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.backgroundColor = 'var(--bg-modifier-hover)';
                    e.currentTarget.style.color = 'var(--text-primary)';
                  }
                }}
                onMouseLeave={(e) => {
                  if (!isActive) {
                    e.currentTarget.style.backgroundColor = 'transparent';
                    e.currentTarget.style.color = 'var(--text-muted)';
                  }
                }}
              >
                <div style={{ ...styles.avatar, backgroundColor: g.avatarColor || '#5865F2', borderRadius: '12px' }}>
                  👥
                </div>
                <div style={{ overflow: 'hidden', flex: 1, paddingRight: '8px' }}>
                  <div style={{ fontSize: '14px', fontWeight: '500', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {g.name}
                  </div>
                  <div style={{ fontSize: '12px', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {meta.lastMessage || `${g.memberCount} участников`}
                  </div>
                </div>
                {meta.unreadCount > 0 && (
                  <span style={styles.badge}>{meta.unreadCount}</span>
                )}
              </div>
            );
          })
        )}
      </div>

      <div style={styles.footer}>
        <div>
          <div style={styles.userName} title={user.name || user.login}>
            {user.name || user.login}
          </div>
          <div style={styles.userRole}>#{user.role || 'user'}</div>
        </div>
        <SettingsMenu onLogout={onLogout} />
      </div>

      {showCreateGroup && (
        <CreateGroupModal
          currentUserId={user.id}
          onClose={() => setShowCreateGroup(false)}
          onCreated={handleGroupCreated}
        />
      )}
    </div>
  );
};

export default Sidebar;
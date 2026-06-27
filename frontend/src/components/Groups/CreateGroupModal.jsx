import React, { useState, useEffect } from 'react';
import api from '../../api';

const CreateGroupModal = ({ currentUserId, onClose, onCreated }) => {
  const [name, setName] = useState('');
  const [usersList, setUsersList] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    const fetchUsers = async () => {
      try {
        const response = await api.get('/auth/users');
        setUsersList(response.data.filter(u => u.id !== currentUserId));
      } catch (err) {
        console.error('Ошибка загрузки пользователей:', err);
      } finally {
        setLoading(false);
      }
    };
    fetchUsers();
  }, [currentUserId]);

  const toggleUser = (id) => {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  };

  const handleCreate = async () => {
    if (!name.trim()) {
      setError('Введите название группы');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const response = await api.post('/groups', { name: name.trim(), memberIds: selectedIds });
      onCreated(response.data);
    } catch (err) {
      console.error('Ошибка создания группы:', err);
      setError('Не удалось создать группу');
    } finally {
      setSubmitting(false);
    }
  };

  const styles = {
    overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
    modal: { width: '420px', maxHeight: '80vh', backgroundColor: 'var(--bg-primary)', borderRadius: '8px', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
    header: { padding: '20px', borderBottom: '1px solid rgba(0,0,0,0.3)' },
    title: { color: '#fff', fontSize: '18px', fontWeight: '700', margin: 0 },
    body: { padding: '20px', flex: 1, overflowY: 'auto' },
    label: { color: 'var(--text-muted)', fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', marginBottom: '8px', display: 'block' },
    input: { width: '100%', backgroundColor: 'var(--bg-tertiary)', border: 'none', borderRadius: '4px', padding: '10px 12px', color: '#fff', fontSize: '14px', marginBottom: '20px', boxSizing: 'border-box' },
    userRow: { display: 'flex', alignItems: 'center', padding: '8px', borderRadius: '4px', cursor: 'pointer', marginBottom: '4px' },
    avatar: { width: '32px', height: '32px', borderRadius: '50%', backgroundColor: '#5865F2', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 'bold', marginRight: '10px', fontSize: '14px', flexShrink: 0 },
    checkbox: { marginLeft: 'auto', width: '18px', height: '18px' },
    footer: { padding: '16px 20px', display: 'flex', justifyContent: 'flex-end', gap: '8px', borderTop: '1px solid rgba(0,0,0,0.3)' },
    btnCancel: { backgroundColor: 'transparent', color: 'var(--text-muted)', border: 'none', padding: '10px 16px', borderRadius: '4px', cursor: 'pointer', fontSize: '14px' },
    btnCreate: { backgroundColor: '#5865F2', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: '4px', cursor: 'pointer', fontSize: '14px', fontWeight: '600' },
    error: { color: '#ed4245', fontSize: '13px', marginBottom: '12px' }
  };

  return (
    <div style={styles.overlay} onClick={onClose}>
      <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div style={styles.header}>
          <h3 style={styles.title}>Создать группу</h3>
        </div>
        <div style={styles.body}>
          <label style={styles.label}>Название группы</label>
          <input
            style={styles.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Например: Команда проекта"
            autoFocus
          />

          {error && <div style={styles.error}>{error}</div>}

          <label style={styles.label}>Участники ({selectedIds.length} выбрано)</label>
          {loading ? (
            <div style={{ color: 'var(--text-muted)' }}>Загрузка пользователей...</div>
          ) : (
            usersList.map(u => {
              const displayName = u.Name ? `${u.Name} ${u.Surname || ''}`.trim() : u.login;
              const isChecked = selectedIds.includes(u.id);
              return (
                <div
                  key={u.id}
                  style={{ ...styles.userRow, backgroundColor: isChecked ? 'var(--bg-modifier-selected, #393c43)' : 'transparent' }}
                  onClick={() => toggleUser(u.id)}
                >
                  <div style={styles.avatar}>{(u.Name || u.login)[0].toUpperCase()}</div>
                  <span style={{ color: '#fff', fontSize: '14px' }}>{displayName}</span>
                  <input
                    type="checkbox"
                    checked={isChecked}
                    onChange={() => toggleUser(u.id)}
                    style={styles.checkbox}
                    onClick={(e) => e.stopPropagation()}
                  />
                </div>
              );
            })
          )}
        </div>
        <div style={styles.footer}>
          <button style={styles.btnCancel} onClick={onClose}>Отмена</button>
          <button style={styles.btnCreate} onClick={handleCreate} disabled={submitting}>
            {submitting ? 'Создание...' : 'Создать группу'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default CreateGroupModal;

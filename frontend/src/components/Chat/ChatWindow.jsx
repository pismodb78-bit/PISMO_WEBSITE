import React, { useState, useEffect, useRef } from 'react';
import api from '../../api';
import { useNotifications } from '../../context/NotificationContext';

// Определяет MIME-тип аудио по сигнатуре байт (magic bytes), а не по имени файла —
// десктопный клиент (NAudio WaveFileWriter) всегда пишет WAV и никогда не указывает file_name,
// поэтому угадывание по расширению для него не работает.
function detectAudioMime(base64Data) {
  if (!base64Data || base64Data.length < 16) return 'audio/wav';

  try {
    // Декодируем чуть больше байт и берём кратное 4 количество символов,
    // чтобы atob() не упал на невалидной длине base64-блока
    const safeSlice = base64Data.slice(0, 24);
    const headerBytes = atob(safeSlice);

    // WAV: байты 0-3 "RIFF"
    if (headerBytes.slice(0, 4) === 'RIFF') return 'audio/wav';

    // WebM (используется MediaRecorder в браузере): EBML-заголовок 0x1A45DFA3
    if (
      headerBytes.charCodeAt(0) === 0x1a &&
      headerBytes.charCodeAt(1) === 0x45 &&
      headerBytes.charCodeAt(2) === 0xdf &&
      headerBytes.charCodeAt(3) === 0xa3
    ) {
      return 'audio/webm';
    }

    // Ogg: начинается с "OggS"
    if (headerBytes.slice(0, 4) === 'OggS') return 'audio/ogg';

    // MP3: ID3-тег или фрейм-синхронизация
    if (headerBytes.slice(0, 3) === 'ID3') return 'audio/mpeg';
    const b0 = headerBytes.charCodeAt(0);
    const b1 = headerBytes.charCodeAt(1);
    if (b0 === 0xff && (b1 === 0xfb || b1 === 0xf3 || b1 === 0xf2)) return 'audio/mpeg';

    return 'audio/webm';
  } catch (err) {
    // Если base64-срез оказался невалидным (например, сообщение ещё грузится) —
    // НЕ роняем рендер всего сообщения, просто берём безопасный дефолт.
    console.warn('detectAudioMime: не удалось декодировать заголовок аудио', err);
    return 'audio/wav';
  }
}

const ChatWindow = ({ activeChat, user, socket }) => {
  if (!activeChat) {
    return (
      <div style={{ flex: 1, backgroundColor: 'var(--bg-primary)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' }}>
        Выберите чат для начала общения
      </div>
    );
  }

  const { clearUnread } = useNotifications();

  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState('');
  const [selectedFile, setSelectedFile] = useState(null);
  const [isRecording, setIsRecording] = useState(false);
  const [editingMsgId, setEditingMsgId] = useState(null);
  const [editText, setEditText] = useState('');

  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  const fetchMessages = async () => {
    try {
      const url = activeChat.isGroup
        ? `/groups/${activeChat.id}/messages`
        : `/messages/${activeChat.id}`;
      const response = await api.get(url);
      setMessages(response.data);
    } catch (err) {
      console.error('Ошибка при загрузке истории:', err);
      setMessages([]); 
    }
  };

  useEffect(() => {
    fetchMessages();
    setSelectedFile(null);
    clearUnread(activeChat.id); // открыли чат — бейдж этого собеседника/группы сбрасывается

    if (socket && activeChat.id) {
      if (activeChat.isGroup) {
        socket.emit('group:join', { groupId: activeChat.id, userId: user.id });
      } else {
        // Присоединяемся ТОЛЬКО к комнате активного чата.
        // Лишний join с chatId: user.id создавал мусорную комнату и ломал логику прочитанности/бейджей.
        socket.emit('chat:join', { chatId: activeChat.id, userId: user.id });
      }
    }

    return () => {
      if (socket && activeChat.id && !activeChat.isGroup) {
        socket.emit('chat:leave', { chatId: activeChat.id, userId: user.id });
      }
      // группу при закрытии окна не покидаем — пользователь должен продолжать
      // получать новые сообщения группы для бейджа в сайдбаре
    };
  }, [activeChat.id, activeChat.isGroup, socket, user.id]);

  useEffect(() => {
    if (!socket) return;

    const handleNewMessage = (newMessage) => {
      if (activeChat.isGroup) return; // личные сообщения не относятся к открытой группе
      if (
        (Number(newMessage.sender_id) === Number(activeChat.id) && Number(newMessage.receiver_id) === Number(user.id)) ||
        (Number(newMessage.sender_id) === Number(user.id) && Number(newMessage.receiver_id) === Number(activeChat.id))
      ) {
        setMessages((prev) => {
          if (prev.some(m => m.id === newMessage.id)) return prev;
          return [...prev, newMessage];
        });
      }
    };

    const handleMessageUpdated = ({ msgId, text }) => {
      if (activeChat.isGroup) return;
      setMessages((prev) => prev.map(m => m.id === msgId ? { ...m, text: text } : m));
    };

    const handleMessageDeleted = ({ msgId }) => {
      if (activeChat.isGroup) return;
      setMessages((prev) => prev.filter(m => m.id !== msgId));
    };

    const handleMarkedRead = ({ chatId }) => {
      if (activeChat.isGroup) return;
      if (Number(chatId) === Number(activeChat.id)) {
        setMessages((prev) => prev.map(m => ({ ...m, isRead: true })));
      }
    };

    // Групповые события — фильтруем по group_id, а не sender/receiver
    const handleGroupNewMessage = (newMessage) => {
      if (!activeChat.isGroup) return;
      if (Number(newMessage.group_id) !== Number(activeChat.id)) return;
      setMessages((prev) => {
        if (prev.some(m => m.id === newMessage.id)) return prev;
        return [...prev, newMessage];
      });
    };

    const handleGroupMessageUpdated = ({ msgId, text }) => {
      if (!activeChat.isGroup) return;
      setMessages((prev) => prev.map(m => m.id === msgId ? { ...m, text } : m));
    };

    const handleGroupMessageDeleted = ({ msgId }) => {
      if (!activeChat.isGroup) return;
      setMessages((prev) => prev.filter(m => m.id !== msgId));
    };

    socket.on('message:new', handleNewMessage);
    socket.on('message:edit', handleMessageUpdated);
    socket.on('message:delete', handleMessageDeleted);
    socket.on('messages:marked_read', handleMarkedRead);
    socket.on('group:message:new', handleGroupNewMessage);
    socket.on('group:message:updated', handleGroupMessageUpdated);
    socket.on('group:message:deleted', handleGroupMessageDeleted);

    return () => {
      socket.off('message:new', handleNewMessage);
      socket.off('message:edit', handleMessageUpdated);
      socket.off('message:delete', handleMessageDeleted);
      socket.off('messages:marked_read', handleMarkedRead);
      socket.off('group:message:new', handleGroupNewMessage);
      socket.off('group:message:updated', handleGroupMessageUpdated);
      socket.off('group:message:deleted', handleGroupMessageDeleted);
    };
  }, [socket, activeChat.id, activeChat.isGroup, user.id]);

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  // "Очистить кеш медиа" из меню настроек шлёт это событие — у нас нет файлового
  // кеша, как на десктопе, поэтому веб-эквивалент: форсируем чистую перезагрузку
  // истории текущего чата прямо из БД, минуя любые устаревшие данные в state.
  useEffect(() => {
    const handleClearCache = () => {
      fetchMessages();
    };
    window.addEventListener('pismo:clear-media-cache', handleClearCache);
    return () => window.removeEventListener('pismo:clear-media-cache', handleClearCache);
  }, [activeChat.id, activeChat.isGroup]);

  const deleteMessage = async (msgId) => {
    try {
      if (activeChat.isGroup) {
        await api.delete(`/groups/messages/${msgId}`);
        setMessages((prev) => prev.filter(m => m.id !== msgId));
        if (socket) {
          socket.emit('group:message:delete', { groupId: activeChat.id, msgId });
        }
      } else {
        await api.delete(`/messages/${msgId}`);
        setMessages((prev) => prev.filter(m => m.id !== msgId));
        if (socket) {
          socket.emit('message:delete', { chatId: activeChat.id, msgId });
        }
      }
    } catch (err) {
      console.error("Ошибка при удалении:", err);
      alert('Не удалось удалить сообщение');
    }
  };

  const updateMessage = async (msgId) => {
    try {
      if (activeChat.isGroup) {
        await api.put(`/groups/messages/${msgId}`, { text: editText });
        setMessages((prev) => prev.map(m => m.id === msgId ? { ...m, text: editText } : m));
        if (socket) {
          socket.emit('group:message:edit', { groupId: activeChat.id, msgId, text: editText });
        }
      } else {
        await api.put(`/messages/${msgId}`, { text: editText });
        setMessages((prev) => prev.map(m => m.id === msgId ? { ...m, text: editText } : m));
        if (socket) {
          socket.emit('message:edit', { chatId: activeChat.id, msgId, text: editText });
        }
      }
      setEditingMsgId(null);
      setEditText('');
    } catch (err) {
      console.error("Ошибка обновления:", err);
      alert('Не удалось сохранить изменения');
    }
  };

  const handleAttachmentClick = () => fileInputRef.current.click();
  const handleFileChange = (e) => { if (e.target.files && e.target.files[0]) setSelectedFile(e.target.files[0]); };
  const handleCancelFile = () => { setSelectedFile(null); fileInputRef.current.value = ''; };

  const startRecording = async () => {
    if (!navigator.mediaDevices || typeof navigator.mediaDevices.getUserMedia !== 'function') return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorderRef.current = new window.MediaRecorder(stream);
      audioChunksRef.current = [];
      mediaRecorderRef.current.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mediaRecorderRef.current.onstop = async () => {
        const audioFile = new File([new Blob(audioChunksRef.current)], 'voice_msg.webm', { type: 'audio/webm' });
        const formData = new FormData();
        formData.append('file', audioFile);

        const url = activeChat.isGroup
          ? `/groups/${activeChat.id}/messages`
          : '/messages';
        if (!activeChat.isGroup) formData.append('receiverId', activeChat.id);

        const response = await api.post(url, formData);

        setMessages((prev) => prev.some(m => m.id === response.data.id) ? prev : [...prev, response.data]);
        // Не шлём socket.emit('message:new', ...) здесь — сервер уже
        // рассылает событие всем участникам через global.io сразу после записи в БД.
        // Повторная отправка с фронта создавала бы дубликат у получателя.
        stream.getTracks().forEach(track => track.stop());
      };
      mediaRecorderRef.current.start();
      setIsRecording(true);
    } catch (err) { alert('Ошибка микрофона: ' + err.message); }
  };

  const stopRecording = () => { mediaRecorderRef.current?.stop(); setIsRecording(false); };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!inputText.trim() && !selectedFile) return;
    const formData = new FormData();
    formData.append('text', inputText.trim());
    if (selectedFile) formData.append('file', selectedFile);

    const url = activeChat.isGroup
      ? `/groups/${activeChat.id}/messages`
      : '/messages';
    if (!activeChat.isGroup) formData.append('receiverId', activeChat.id);

    try {
      const response = await api.post(url, formData);
      setMessages((prev) => [...prev, response.data]);
      // Сервер сам разошлёт событие нового сообщения через global.io — не дублируем здесь.

      setInputText('');
      setSelectedFile(null);
    } catch (err) { console.error(err); }
  };

  const downloadFile = (base64Data, filename) => {
    const link = document.createElement('a');
    link.href = `data:application/octet-stream;base64,${base64Data}`;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const styles = {
    container: { flex: 1, backgroundColor: 'var(--bg-primary)', display: 'flex', flexDirection: 'column', height: '100vh' },
    header: { height: '60px', backgroundColor: 'var(--bg-primary)', display: 'flex', alignItems: 'center', padding: '0 20px', borderBottom: '1px solid rgba(0,0,0,0.3)' },
    headerTitle: { color: '#fff', fontSize: '16px', fontWeight: '600' },
    messagesArea: { flex: 1, padding: '20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px' },
    emptyState: { margin: 'auto', color: 'var(--text-muted)', fontSize: '15px', textAlign: 'center', maxWidth: '360px', lineHeight: '1.5' },
    messageRow: { display: 'flex', alignItems: 'flex-start' },
    avatar: { width: '40px', height: '40px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 'bold', marginRight: '16px', flexShrink: 0 },
    msgContent: { display: 'flex', flexDirection: 'column', maxWidth: '70%' },
    msgHeader: { display: 'flex', alignItems: 'center', marginBottom: '4px' },
    senderName: { color: '#fff', fontWeight: '500', fontSize: '15px', marginRight: '8px' },
    msgTime: { color: 'var(--text-muted)', fontSize: '12px' },
    msgText: { color: 'var(--text-primary)', fontSize: '15px', lineHeight: '1.4', wordBreak: 'break-word' },
    imagePreview: { maxWidth: '300px', maxHeight: '300px', borderRadius: '8px', marginTop: '8px', cursor: 'pointer' },
    fileBubble: { display: 'flex', alignItems: 'center', backgroundColor: '#2f3136', padding: '10px 14px', borderRadius: '8px', marginTop: '8px' },
    downloadBtn: { backgroundColor: '#5865F2', color: '#fff', border: 'none', borderRadius: '4px', padding: '4px 10px', fontSize: '12px', cursor: 'pointer', marginLeft: '15px' },
    inputArea: { padding: '0 20px 24px 20px', backgroundColor: 'var(--bg-primary)' },
    inputWrapper: { width: '100%', backgroundColor: 'var(--channel-textarea-background)', borderRadius: '8px', display: 'flex', alignItems: 'center', padding: '10px 16px' },
    input: { flex: 1, backgroundColor: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: '15px' },
    attachBtn: { backgroundColor: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: '20px', cursor: 'pointer', marginRight: '12px' },
    micBtn: { backgroundColor: 'transparent', border: 'none', fontSize: '20px', cursor: 'pointer', marginLeft: '12px', display: 'flex', alignItems: 'center' },
    fileBadge: { backgroundColor: '#4f545c', color: '#fff', padding: '4px 8px', borderRadius: '4px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', width: 'fit-content' },
    actionBtn: { background: 'none', border: 'none', cursor: 'pointer', fontSize: '12px', marginLeft: '8px', color: '#b9bbbe' }
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <div style={styles.headerTitle}>
          {activeChat.isGroup ? `👥 ${activeChat.Name}` : (activeChat.Name || activeChat.login)}
        </div>
      </div>
      <div style={styles.messagesArea}>
        {messages.length === 0 && (
          <div style={styles.emptyState}>
            {activeChat.isGroup
              ? `В группе «${activeChat.Name}» пока нет сообщений. Напишите первым!`
              : `Напишите ${activeChat.Name || activeChat.login}, чтобы начать общение`}
          </div>
        )}
        {messages.map((msg) => {
          const isMe = Number(msg.sender_id) === Number(user.id);

let displayName;
let firstLetter;

if (activeChat.isGroup) {
  // Меняем 'Вы' на user.login
  displayName = isMe ? user.login : (msg.sender_name?.trim() || msg.sender_login || '?');
  firstLetter = (displayName[0] || '?');
} else {
  // И здесь тоже меняем 'Вы' на user.login
  displayName = isMe ? user.login : activeChat.login;
  firstLetter = (isMe ? user.login : activeChat.login)[0] || '?';
}

          return (
            <div key={msg.id} style={styles.messageRow}>
              <div style={{ ...styles.avatar, backgroundColor: isMe ? '#5865F2' : '#43b581' }}>{firstLetter.toUpperCase()}</div>
              <div style={styles.msgContent}>
                <div style={styles.msgHeader}>
                  <span style={styles.senderName}>{displayName}</span>
                  {isMe && (
                    <>
                      <button onClick={() => { setEditingMsgId(msg.id); setEditText(msg.text); }} style={styles.actionBtn}>✏️</button>
                      <button onClick={() => deleteMessage(msg.id)} style={styles.actionBtn}>🗑️</button>
                    </>
                  )}
                  <span style={styles.msgTime}>
                    {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                {editingMsgId === msg.id ? (
                  <div>
                    <input value={editText} onChange={(e) => setEditText(e.target.value)} style={{ backgroundColor: '#40444b', border: 'none', padding: '4px', color: '#fff', borderRadius: '4px', marginRight: '8px' }} />
                    <button onClick={() => updateMessage(msg.id)} style={{ backgroundColor: '#43b581', color: '#fff', border: 'none', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', marginRight: '4px' }}>Сохранить</button>
                    <button onClick={() => setEditingMsgId(null)} style={{ backgroundColor: '#72767d', color: '#fff', border: 'none', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer' }}>Отмена</button>
                  </div>
                ) : (
                  <>
                    {msg.text && <div style={styles.msgText}>{msg.text}</div>}
                    {msg.msg_type === 'image' && <img src={`data:image/jpeg;base64,${msg.image_data}`} style={styles.imagePreview} alt="img" />}
                    {msg.msg_type === 'audio' && (() => {
  try {
    // Десктопный клиент всегда пишет WAV (NAudio WaveFileWriter) и НЕ заполняет file_name.
    // Поэтому угадывать формат по имени файла ненадёжно — смотрим на сигнатуру
    // самих данных (magic bytes), это работает одинаково для веба и десктопа.
    const mimeType = detectAudioMime(msg.audio_data);
    return <audio controls src={`data:${mimeType};base64,${msg.audio_data}`} style={{ height: '40px' }} />;
  } catch (err) {
    console.error('Ошибка рендера аудио-сообщения:', err);
    return <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>⚠️ Не удалось загрузить голосовое сообщение</div>;
  }
})()}
                    {msg.msg_type === 'file' && (
                      <div style={styles.fileBubble}>📄 {msg.file_name} <button onClick={() => downloadFile(msg.file_data, msg.file_name)} style={styles.downloadBtn}>Скачать</button></div>
                    )}
                  </>
                )}
              </div>
            </div>
          );
        })}
        <div ref={messagesEndRef} />
      </div>
      <div style={styles.inputArea}>
        {selectedFile && <div style={styles.fileBadge}>📎 {selectedFile.name} <button onClick={handleCancelFile}>×</button></div>}
        <form onSubmit={handleSendMessage}>
          <div style={styles.inputWrapper}>
            <input type="file" ref={fileInputRef} onChange={handleFileChange} style={{ display: 'none' }} />
            <button type="button" onClick={handleAttachmentClick} style={styles.attachBtn}>➕</button>
            <input type="text" value={inputText} onChange={(e) => setInputText(e.target.value)} placeholder="Написать..." style={styles.input} />
            <button type="button" onClick={isRecording ? stopRecording : startRecording} style={{...styles.micBtn, color: isRecording ? '#f04747' : 'var(--text-muted)'}}>
              {isRecording ? '🛑' : '🎙️'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

export default ChatWindow;
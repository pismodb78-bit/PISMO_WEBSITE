import React, { useState, useEffect, useRef } from 'react';
import { emitAsync } from '../../socket';
import { useNotifications } from '../../context/NotificationContext';

function detectAudioMime(base64Data) {
    if (!base64Data || base64Data.length < 16) return 'audio/wav';
    try {
        const safeSlice = base64Data.slice(0, 24);
        const headerBytes = atob(safeSlice);
        if (headerBytes.slice(0, 4) === 'RIFF') return 'audio/wav';
        if (
            headerBytes.charCodeAt(0) === 0x1a &&
            headerBytes.charCodeAt(1) === 0x45 &&
            headerBytes.charCodeAt(2) === 0xdf &&
            headerBytes.charCodeAt(3) === 0xa3
        ) return 'audio/webm';
        if (headerBytes.slice(0, 4) === 'OggS') return 'audio/ogg';
        if (headerBytes.slice(0, 3) === 'ID3') return 'audio/mpeg';
        const b0 = headerBytes.charCodeAt(0);
        const b1 = headerBytes.charCodeAt(1);
        if (b0 === 0xff && (b1 === 0xfb || b1 === 0xf3 || b1 === 0xf2)) return 'audio/mpeg';
        return 'audio/webm';
    } catch {
        return 'audio/wav';
    }
}

function fileToPayload(file) {
    return new Promise((resolve, reject) => {
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.onload = () => {
            const base64 = reader.result.split(',')[1];
            resolve({ name: file.name, mime: file.type || 'application/octet-stream', data: base64 });
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// Подгружает медиа-данные по требованию.
// cacheKey меняется при очистке кеша — принудительно перемонтирует компонент и перезапрашивает.
const LazyMedia = ({ msg, isGroup, cacheKey }) => {
    const hasInlineData = !!(msg.image_data || msg.audio_data || msg.file_data);
    const [fileData, setFileData] = useState(hasInlineData ? msg : null);
    const [loaded, setLoaded] = useState(hasInlineData);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        if (hasInlineData) return;
        let cancelled = false;
        const event = isGroup ? 'group:message:file' : 'message:file';

        emitAsync(event, { msgId: msg.id })
            .then((res) => {
                if (cancelled) return;
                setFileData(res);
                setLoaded(true);
            })
            .catch((err) => {
                console.error('Ошибка загрузки файла:', err);
                if (!cancelled) { setFailed(true); setLoaded(true); }
            });

        return () => { cancelled = true; };
    }, [msg.id, cacheKey]);

    if (!loaded) return <div style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '6px' }}>⏳ Загрузка...</div>;
    if (failed || !fileData) return <div style={{ color: 'var(--text-muted)', fontSize: '13px', marginTop: '6px' }}>⚠️ Не удалось загрузить</div>;

    if (msg.msg_type === 'image') {
        return (
            <img
                src={`data:image/jpeg;base64,${fileData.image_data}`}
                style={{ maxWidth: '300px', maxHeight: '300px', borderRadius: '8px', marginTop: '8px', cursor: 'pointer', display: 'block' }}
                alt="img"
            />
        );
    }

    if (msg.msg_type === 'audio') {
        try {
            const mimeType = detectAudioMime(fileData.audio_data);
            return (
                <audio
                    controls
                    src={`data:${mimeType};base64,${fileData.audio_data}`}
                    style={{ height: '40px', marginTop: '8px', display: 'block' }}
                />
            );
        } catch {
            return <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>⚠️ Не удалось загрузить голосовое</div>;
        }
    }

    if (msg.msg_type === 'file') {
        const download = () => {
            const link = document.createElement('a');
            link.href = `data:application/octet-stream;base64,${fileData.file_data}`;
            link.download = fileData.file_name || 'file';
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        };
        return (
            <div style={{ display: 'flex', alignItems: 'center', backgroundColor: '#2f3136', padding: '10px 14px', borderRadius: '8px', marginTop: '8px' }}>
                📄 {fileData.file_name}
                <button onClick={download} style={{ backgroundColor: '#5865F2', color: '#fff', border: 'none', borderRadius: '4px', padding: '4px 10px', fontSize: '12px', cursor: 'pointer', marginLeft: '15px' }}>
                    Скачать
                </button>
            </div>
        );
    }

    return null;
};

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
    const [loadingHistory, setLoadingHistory] = useState(false);
    // Меняется при очистке кеша — принудительно перемонтирует LazyMedia
    const [cacheKey, setCacheKey] = useState(0);

    const messagesEndRef = useRef(null);
    const fileInputRef = useRef(null);
    const mediaRecorderRef = useRef(null);
    const audioChunksRef = useRef([]);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    const fetchMessages = async () => {
        setLoadingHistory(true);
        try {
            const res = activeChat.isGroup
                ? await emitAsync('group:join', { groupId: activeChat.id })
                : await emitAsync('chat:join', { partnerId: activeChat.id });
            setMessages(res.history || []);
            setCacheKey(k => k + 1); // перемонтировать LazyMedia после перезагрузки
        } catch (err) {
            console.error('Ошибка при загрузке истории:', err);
            setMessages([]);
        } finally {
            setLoadingHistory(false);
        }
    };

    useEffect(() => {
        fetchMessages();
        setSelectedFile(null);
        setEditingMsgId(null);
        clearUnread(activeChat.id);

        return () => {
            if (socket && activeChat.id && !activeChat.isGroup) {
                socket.emit('chat:leave', { partnerId: activeChat.id });
            }
        };
    }, [activeChat.id, activeChat.isGroup]);

    useEffect(() => {
        if (!socket) return;

        const addMsg = (msg) => setMessages(prev => {
            if (prev.some(m => m.id === msg.id)) return prev;
            return [...prev, msg];
        });

        const handleNewMessage = (msg) => {
            if (activeChat.isGroup) return;
            if (
                (Number(msg.sender_id) === Number(activeChat.id) && Number(msg.receiver_id) === Number(user.id)) ||
                (Number(msg.sender_id) === Number(user.id) && Number(msg.receiver_id) === Number(activeChat.id))
            ) addMsg(msg);
        };

        const handleMessageUpdated = ({ msgId, text }) => {
            if (activeChat.isGroup) return;
            setMessages(prev => prev.map(m => m.id === msgId ? { ...m, text } : m));
        };

        const handleMessageDeleted = ({ msgId }) => {
            if (activeChat.isGroup) return;
            setMessages(prev => prev.filter(m => m.id !== msgId));
        };

        const handleMarkedRead = ({ chatId }) => {
            if (activeChat.isGroup) return;
            if (Number(chatId) === Number(activeChat.id)) {
                setMessages(prev => prev.map(m => ({ ...m, isRead: true })));
            }
        };

        const handleGroupNewMessage = (msg) => {
            if (!activeChat.isGroup) return;
            if (Number(msg.group_id) !== Number(activeChat.id)) return;
            addMsg(msg);
        };

        const handleGroupMessageUpdated = ({ msgId, text }) => {
            if (!activeChat.isGroup) return;
            setMessages(prev => prev.map(m => m.id === msgId ? { ...m, text } : m));
        };

        const handleGroupMessageDeleted = ({ msgId }) => {
            if (!activeChat.isGroup) return;
            setMessages(prev => prev.filter(m => m.id !== msgId));
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

    useEffect(() => { scrollToBottom(); }, [messages]);

    useEffect(() => {
        const handleClearCache = () => {
            setCacheBust((c) => c + 1); // форсируем перемонтирование LazyMedia
            fetchMessages();
        };
        window.addEventListener('pismo:clear-media-cache', handleClearCache);
        return () => window.removeEventListener('pismo:clear-media-cache', handleClearCache);
    }, [activeChat.id, activeChat.isGroup]);

    const sendMessage = async (text, file) => {
        const filePayload = await fileToPayload(file);
        const event = activeChat.isGroup ? 'group:send' : 'chat:send';
        const payload = activeChat.isGroup
            ? { groupId: activeChat.id, text: text || '', file: filePayload }
            : { receiverId: activeChat.id, text: text || '', file: filePayload };

        const res = await emitAsync(event, payload);
        // Дедупликация: message:new придёт и по сокету, addMsg не добавит дубль
        setMessages(prev => {
            if (prev.some(m => m.id === res.message.id)) return prev;
            return [...prev, res.message];
        });
        return res;
    };

    const handleSendMessage = async (e) => {
        e.preventDefault();
        if (!inputText.trim() && !selectedFile) return;

        const text = inputText.trim();
        const file = selectedFile;
        setInputText('');
        setSelectedFile(null);

        try {
            await sendMessage(text, file);
        } catch (err) {
            console.error('Ошибка отправки:', err);
            alert('Не удалось отправить сообщение');
            // Возвращаем текст если не отправилось
            if (text) setInputText(text);
        }
    };

    const deleteMessage = async (msgId) => {
        try {
            if (activeChat.isGroup) {
                await emitAsync('group:delete', { groupId: activeChat.id, msgId });
            } else {
                await emitAsync('chat:delete', { chatId: activeChat.id, msgId });
            }
            setMessages(prev => prev.filter(m => m.id !== msgId));
        } catch (err) {
            console.error('Ошибка при удалении:', err);
            alert('Не удалось удалить сообщение');
        }
    };

    const updateMessage = async (msgId) => {
        try {
            if (activeChat.isGroup) {
                await emitAsync('group:edit', { groupId: activeChat.id, msgId, text: editText });
            } else {
                await emitAsync('chat:edit', { chatId: activeChat.id, msgId, text: editText });
            }
            setMessages(prev => prev.map(m => m.id === msgId ? { ...m, text: editText } : m));
            setEditingMsgId(null);
            setEditText('');
        } catch (err) {
            console.error('Ошибка обновления:', err);
            alert('Не удалось сохранить изменения');
        }
    };

    const handleAttachmentClick = () => fileInputRef.current?.click();
    const handleFileChange = (e) => { if (e.target.files?.[0]) setSelectedFile(e.target.files[0]); };
    const handleCancelFile = () => { setSelectedFile(null); if (fileInputRef.current) fileInputRef.current.value = ''; };

    const startRecording = async () => {
        if (!navigator.mediaDevices?.getUserMedia) {
            alert('Ваш браузер не поддерживает запись аудио');
            return;
        }
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

            // Выбираем поддерживаемый браузером формат
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
                ? 'audio/webm;codecs=opus'
                : MediaRecorder.isTypeSupported('audio/webm')
                    ? 'audio/webm'
                    : MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')
                        ? 'audio/ogg;codecs=opus'
                        : '';

            mediaRecorderRef.current = mimeType
                ? new window.MediaRecorder(stream, { mimeType })
                : new window.MediaRecorder(stream);

            audioChunksRef.current = [];
            mediaRecorderRef.current.ondataavailable = (e) => {
                if (e.data.size > 0) audioChunksRef.current.push(e.data);
            };

            mediaRecorderRef.current.onstop = async () => {
                const blob = new Blob(audioChunksRef.current, {
                    type: mediaRecorderRef.current.mimeType || 'audio/webm'
                });
                const ext = blob.type.includes('ogg') ? 'ogg' : 'webm';
                const audioFile = new File([blob], `voice_msg.${ext}`, { type: blob.type });

                try {
                    await sendMessage('', audioFile);
                } catch (err) {
                    console.error('Ошибка отправки голосового:', err);
                    alert('Не удалось отправить голосовое сообщение');
                } finally {
                    stream.getTracks().forEach(t => t.stop());
                }
            };

            mediaRecorderRef.current.start(100); // chunk каждые 100мс
            setIsRecording(true);
        } catch (err) {
            alert('Ошибка микрофона: ' + err.message);
        }
    };

    const stopRecording = () => {
        mediaRecorderRef.current?.stop();
        setIsRecording(false);
    };

    const styles = {
        container: { flex: 1, backgroundColor: 'var(--bg-primary)', display: 'flex', flexDirection: 'column', height: '100vh' },
        header: { height: '60px', backgroundColor: 'var(--bg-primary)', display: 'flex', alignItems: 'center', padding: '0 20px', borderBottom: '1px solid rgba(0,0,0,0.3)', flexShrink: 0 },
        headerTitle: { color: '#fff', fontSize: '16px', fontWeight: '600' },
        messagesArea: { flex: 1, padding: '20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px' },
        emptyChat: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', userSelect: 'none' },
        messageRow: { display: 'flex', alignItems: 'flex-start' },
        avatar: { width: '40px', height: '40px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 'bold', marginRight: '16px', flexShrink: 0 },
        msgContent: { display: 'flex', flexDirection: 'column', maxWidth: '70%' },
        msgHeader: { display: 'flex', alignItems: 'center', marginBottom: '4px' },
        senderName: { color: '#fff', fontWeight: '500', fontSize: '15px', marginRight: '8px' },
        msgTime: { color: 'var(--text-muted)', fontSize: '12px' },
        msgText: { color: 'var(--text-primary)', fontSize: '15px', lineHeight: '1.4', wordBreak: 'break-word' },
        inputArea: { padding: '0 20px 24px 20px', backgroundColor: 'var(--bg-primary)', flexShrink: 0 },
        inputWrapper: { width: '100%', backgroundColor: 'var(--channel-textarea-background)', borderRadius: '8px', display: 'flex', alignItems: 'center', padding: '10px 16px' },
        input: { flex: 1, backgroundColor: 'transparent', border: 'none', outline: 'none', color: 'var(--text-primary)', fontSize: '15px' },
        attachBtn: { backgroundColor: 'transparent', border: 'none', color: 'var(--text-muted)', fontSize: '20px', cursor: 'pointer', marginRight: '12px' },
        micBtn: { backgroundColor: 'transparent', border: 'none', fontSize: '20px', cursor: 'pointer', marginLeft: '12px', display: 'flex', alignItems: 'center' },
        fileBadge: { backgroundColor: '#4f545c', color: '#fff', padding: '4px 8px', borderRadius: '4px', fontSize: '12px', display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px', width: 'fit-content' },
        actionBtn: { background: 'none', border: 'none', cursor: 'pointer', fontSize: '12px', marginLeft: '8px', color: '#b9bbbe' }
    };

    const chatName = activeChat.isGroup
        ? `👥 ${activeChat.Name}`
        : (activeChat.Name ? `${activeChat.Name} ${activeChat.Surname || ''}`.trim() : activeChat.login);

    return (
        <div style={styles.container}>
            <div style={styles.header}>
                <div style={styles.headerTitle}>{chatName}</div>
            </div>

            <div style={styles.messagesArea}>
                {loadingHistory ? (
                    <div style={styles.emptyChat}>
                        <span>Загрузка сообщений...</span>
                    </div>
                ) : messages.length === 0 ? (
                    /* Пустой чат — плашка как в Discord/Telegram */
                    <div style={styles.emptyChat}>
                        <div style={{ fontSize: '48px', marginBottom: '16px' }}>
                            {activeChat.isGroup ? '👥' : '💬'}
                        </div>
                        <div style={{ fontSize: '20px', fontWeight: '700', color: '#fff', marginBottom: '8px' }}>
                            {activeChat.isGroup
                                ? `Добро пожаловать в ${activeChat.Name}!`
                                : `Начало переписки с ${chatName}`}
                        </div>
                        <div style={{ fontSize: '14px', textAlign: 'center', maxWidth: '400px' }}>
                            {activeChat.isGroup
                                ? 'Это начало группового чата. Напишите первое сообщение!'
                                : `Это самое начало вашей переписки с ${chatName}. Напишите что-нибудь!`}
                        </div>
                    </div>
                ) : (
                    messages.map((msg) => {
                        const isMe = Number(msg.sender_id) === Number(user.id);
                        let displayName, firstLetter;

                        if (activeChat.isGroup) {
                            displayName = isMe ? user.login : (msg.sender_name?.trim() || msg.sender_login || '?');
                        } else {
                            displayName = isMe ? user.login : activeChat.login;
                        }
                        firstLetter = (displayName?.[0] || '?').toUpperCase();

                        return (
                            <div key={msg.id} style={styles.messageRow}>
                                <div style={{ ...styles.avatar, backgroundColor: isMe ? '#5865F2' : '#43b581' }}>
                                    {firstLetter}
                                </div>
                                <div style={styles.msgContent}>
                                    <div style={styles.msgHeader}>
                                        <span style={styles.senderName}>{displayName}</span>
                                        {isMe && (
                                            <>
                                                <button
                                                    onClick={() => { setEditingMsgId(msg.id); setEditText(msg.text || ''); }}
                                                    style={styles.actionBtn}
                                                    title="Редактировать"
                                                >✏️</button>
                                                <button
                                                    onClick={() => deleteMessage(msg.id)}
                                                    style={styles.actionBtn}
                                                    title="Удалить"
                                                >🗑️</button>
                                            </>
                                        )}
                                        <span style={styles.msgTime}>
                                            {new Date(msg.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                        </span>
                                    </div>

                                    {editingMsgId === msg.id ? (
                                        <div>
                                            <input
                                                value={editText}
                                                onChange={(e) => setEditText(e.target.value)}
                                                onKeyDown={(e) => { if (e.key === 'Enter') updateMessage(msg.id); if (e.key === 'Escape') setEditingMsgId(null); }}
                                                style={{ backgroundColor: '#40444b', border: 'none', padding: '4px', color: '#fff', borderRadius: '4px', marginRight: '8px', minWidth: '200px' }}
                                                autoFocus
                                            />
                                            <button onClick={() => updateMessage(msg.id)} style={{ backgroundColor: '#43b581', color: '#fff', border: 'none', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer', marginRight: '4px' }}>Сохранить</button>
                                            <button onClick={() => setEditingMsgId(null)} style={{ backgroundColor: '#72767d', color: '#fff', border: 'none', padding: '4px 8px', borderRadius: '4px', cursor: 'pointer' }}>Отмена</button>
                                        </div>
                                    ) : (
                                        <>
                                            {msg.text && <div style={styles.msgText}>{msg.text}</div>}
                                            {msg.msg_type && msg.msg_type !== 'text' && (
                                                <LazyMedia
                                                    key={`${msg.id}_${cacheKey}`}
                                                    msg={msg}
                                                    isGroup={activeChat.isGroup}
                                                    cacheKey={cacheKey}
                                                />
                                            )}
                                        </>
                                    )}
                                </div>
                            </div>
                        );
                    })
                )}
                <div ref={messagesEndRef} />
            </div>

            <div style={styles.inputArea}>
                {selectedFile && (
                    <div style={styles.fileBadge}>
                        📎 {selectedFile.name}
                        <button onClick={handleCancelFile} style={{ background: 'none', border: 'none', color: '#fff', cursor: 'pointer', fontSize: '14px', lineHeight: 1 }}>×</button>
                    </div>
                )}
                {isRecording && (
                    <div style={{ ...styles.fileBadge, backgroundColor: '#f04747', marginBottom: '8px' }}>
                        🔴 Запись... нажмите 🛑 для остановки
                    </div>
                )}
                <form onSubmit={handleSendMessage}>
                    <div style={styles.inputWrapper}>
                        <input type="file" ref={fileInputRef} onChange={handleFileChange} style={{ display: 'none' }} />
                        <button type="button" onClick={handleAttachmentClick} style={styles.attachBtn} title="Прикрепить файл" disabled={isRecording}>
                            ➕
                        </button>
                        <input
                            type="text"
                            value={inputText}
                            onChange={(e) => setInputText(e.target.value)}
                            placeholder={isRecording ? 'Идёт запись...' : 'Написать...'}
                            style={{ ...styles.input, opacity: isRecording ? 0.5 : 1 }}
                            disabled={isRecording}
                        />
                        <button
                            type="button"
                            onClick={isRecording ? stopRecording : startRecording}
                            style={{ ...styles.micBtn, color: isRecording ? '#f04747' : 'var(--text-muted)' }}
                            title={isRecording ? 'Остановить запись' : 'Записать голосовое'}
                            disabled={!!selectedFile}
                        >
                            {isRecording ? '🛑' : '🎙️'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default ChatWindow;
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
        ) {
            return 'audio/webm';
        }

        if (headerBytes.slice(0, 4) === 'OggS') return 'audio/ogg';

        if (headerBytes.slice(0, 3) === 'ID3') return 'audio/mpeg';
        const b0 = headerBytes.charCodeAt(0);
        const b1 = headerBytes.charCodeAt(1);
        if (b0 === 0xff && (b1 === 0xfb || b1 === 0xf3 || b1 === 0xf2)) return 'audio/mpeg';

        return 'audio/webm';
    } catch (err) {
        console.warn('detectAudioMime: не удалось декодировать заголовок аудио', err);
        return 'audio/wav';
    }
}

function fileToPayload(file) {
    return new Promise((resolve, reject) => {
        if (!file) return resolve(null);
        const reader = new FileReader();
        reader.onload = () => {
            const base64 = reader.result.split(',')[1];
            resolve({ name: file.name, mime: file.type, data: base64 });
        };
        reader.onerror = reject;
        reader.readAsDataURL(file);
    });
}

// Подгружает данные файла сообщения по требованию (история не содержит BLOB-данные
// целиком, только флаги has_image/has_audio/has_file — иначе ломается JSON.stringify
// при большом объёме медиа). Сообщения, отправленные в текущей сессии через chat:send/
// group:send, уже приходят с готовыми данными (image_data/audio_data/file_data),
// поэтому повторный запрос для них не делается.
const LazyMedia = ({ msg, isGroup }) => {
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
                console.error('Ошибка загрузки файла сообщения:', err);
                if (!cancelled) {
                    setFailed(true);
                    setLoaded(true);
                }
            });

        return () => { cancelled = true; };
    }, [msg.id]);

    if (!loaded) {
        return <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>Загрузка...</div>;
    }
    if (failed || !fileData) {
        return <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>⚠️ Не удалось загрузить вложение</div>;
    }

    if (msg.msg_type === 'image') {
        return <img src={`data:image/jpeg;base64,${fileData.image_data}`} style={{ maxWidth: '300px', maxHeight: '300px', borderRadius: '8px', marginTop: '8px', cursor: 'pointer' }} alt="img" />;
    }

    if (msg.msg_type === 'audio') {
        try {
            const mimeType = detectAudioMime(fileData.audio_data);
            return <audio controls src={`data:${mimeType};base64,${fileData.audio_data}`} style={{ height: '40px' }} />;
        } catch (err) {
            console.error('Ошибка рендера аудио-сообщения:', err);
            return <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>⚠️ Не удалось загрузить голосовое сообщение</div>;
        }
    }

    if (msg.msg_type === 'file') {
        const downloadFile = () => {
            const link = document.createElement('a');
            link.href = `data:application/octet-stream;base64,${fileData.file_data}`;
            link.download = fileData.file_name;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
        };
        return (
            <div style={{ display: 'flex', alignItems: 'center', backgroundColor: '#2f3136', padding: '10px 14px', borderRadius: '8px', marginTop: '8px' }}>
                📄 {fileData.file_name}
                <button onClick={downloadFile} style={{ backgroundColor: '#5865F2', color: '#fff', border: 'none', borderRadius: '4px', padding: '4px 10px', fontSize: '12px', cursor: 'pointer', marginLeft: '15px' }}>Скачать</button>
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

    const messagesEndRef = useRef(null);
    const fileInputRef = useRef(null);
    const mediaRecorderRef = useRef(null);
    const audioChunksRef = useRef([]);

    const scrollToBottom = () => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    };

    const fetchMessages = async () => {
        try {
            const res = activeChat.isGroup
                ? await emitAsync('group:join', { groupId: activeChat.id })
                : await emitAsync('chat:join', { partnerId: activeChat.id });
            setMessages(res.history || []);
        } catch (err) {
            console.error('Ошибка при загрузке истории:', err);
            setMessages([]);
        }
    };

    useEffect(() => {
        fetchMessages();
        setSelectedFile(null);
        clearUnread(activeChat.id);

        return () => {
            if (socket && activeChat.id && !activeChat.isGroup) {
                socket.emit('chat:leave', { partnerId: activeChat.id });
            }
        };
    }, [activeChat.id, activeChat.isGroup, socket, user.id]);

    useEffect(() => {
        if (!socket) return;

        const handleNewMessage = (newMessage) => {
            if (activeChat.isGroup) return;
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
                await emitAsync('group:delete', { groupId: activeChat.id, msgId });
            } else {
                await emitAsync('chat:delete', { chatId: activeChat.id, msgId });
            }
            setMessages((prev) => prev.filter(m => m.id !== msgId));
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
            setMessages((prev) => prev.map(m => m.id === msgId ? { ...m, text: editText } : m));
            setEditingMsgId(null);
            setEditText('');
        } catch (err) {
            console.error('Ошибка обновления:', err);
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

                try {
                    const filePayload = await fileToPayload(audioFile);
                    const event = activeChat.isGroup ? 'group:send' : 'chat:send';
                    const payload = activeChat.isGroup
                        ? { groupId: activeChat.id, text: '', file: filePayload }
                        : { receiverId: activeChat.id, text: '', file: filePayload };

                    const res = await emitAsync(event, payload);
                    setMessages((prev) => {
                        if (prev.some(m => m.id === res.message.id)) return prev;
                        return [...prev, res.message];
                    });
                } catch (err) {
                    console.error('Ошибка отправки голосового сообщения:', err);
                    alert('Не удалось отправить голосовое сообщение');
                } finally {
                    stream.getTracks().forEach(track => track.stop());
                }
            };
            mediaRecorderRef.current.start();
            setIsRecording(true);
        } catch (err) { alert('Ошибка микрофона: ' + err.message); }
    };

    const stopRecording = () => { mediaRecorderRef.current?.stop(); setIsRecording(false); };

    const handleSendMessage = async (e) => {
        e.preventDefault();
        if (!inputText.trim() && !selectedFile) return;

        try {
            const filePayload = await fileToPayload(selectedFile);
            const event = activeChat.isGroup ? 'group:send' : 'chat:send';
            const payload = activeChat.isGroup
                ? { groupId: activeChat.id, text: inputText.trim(), file: filePayload }
                : { receiverId: activeChat.id, text: inputText.trim(), file: filePayload };

            const res = await emitAsync(event, payload);
            setMessages((prev) => {
                if (prev.some(m => m.id === res.message.id)) return prev;
                return [...prev, res.message];
            });

            setInputText('');
            setSelectedFile(null);
        } catch (err) {
            console.error('Ошибка отправки сообщения:', err);
            alert('Не удалось отправить сообщение');
        }
    };

    const styles = {
        container: { flex: 1, backgroundColor: 'var(--bg-primary)', display: 'flex', flexDirection: 'column', height: '100vh' },
        header: { height: '60px', backgroundColor: 'var(--bg-primary)', display: 'flex', alignItems: 'center', padding: '0 20px', borderBottom: '1px solid rgba(0,0,0,0.3)' },
        headerTitle: { color: '#fff', fontSize: '16px', fontWeight: '600' },
        messagesArea: { flex: 1, padding: '20px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '16px' },
        messageRow: { display: 'flex', alignItems: 'flex-start' },
        avatar: { width: '40px', height: '40px', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 'bold', marginRight: '16px', flexShrink: 0 },
        msgContent: { display: 'flex', flexDirection: 'column', maxWidth: '70%' },
        msgHeader: { display: 'flex', alignItems: 'center', marginBottom: '4px' },
        senderName: { color: '#fff', fontWeight: '500', fontSize: '15px', marginRight: '8px' },
        msgTime: { color: 'var(--text-muted)', fontSize: '12px' },
        msgText: { color: 'var(--text-primary)', fontSize: '15px', lineHeight: '1.4', wordBreak: 'break-word' },
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
                {messages.map((msg) => {
                    const isMe = Number(msg.sender_id) === Number(user.id);

                    let displayName;
                    let firstLetter;

                    if (activeChat.isGroup) {
                        displayName = isMe ? user.login : (msg.sender_name?.trim() || msg.sender_login || '?');
                        firstLetter = (displayName[0] || '?');
                    } else {
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
                                        {msg.msg_type !== 'text' && (
                                            <LazyMedia msg={msg} isGroup={activeChat.isGroup} />
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
                        <button type="button" onClick={isRecording ? stopRecording : startRecording} style={{ ...styles.micBtn, color: isRecording ? '#f04747' : 'var(--text-muted)' }}>
                            {isRecording ? '🛑' : '🎙️'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default ChatWindow;
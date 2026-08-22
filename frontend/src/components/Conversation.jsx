import React from 'react';
import Message from './Message';
import { Empty } from './Common';
import { socket, ask, on } from '../lib/socket';
import { SCOPE, formatDay } from '../lib/format';

/**
 * Окно переписки — одно на все три вида: личный диалог, группа и канал
 * сервера. Различаются они только именами событий и полем адресата,
 * поэтому таблица ниже — единственное место, где эта разница живёт.
 */
const WIRE = {
    [SCOPE.DM]: {
        history: 'chat:history',
        send: 'chat:send',
        target: 'receiverId',
        edit: 'message:edit',
        remove: 'message:delete',
    },
    [SCOPE.GROUP]: {
        history: 'group:history',
        send: 'group:send',
        target: 'groupId',
        edit: 'message:edit',
        remove: 'message:delete',
    },
    [SCOPE.SERVER]: {
        history: 'channel:history',
        send: 'channel:send',
        target: 'channelId',
        edit: 'channel:edit',
        remove: 'channel:delete_message',
    },
};

const idKey = { [SCOPE.DM]: 'partnerId', [SCOPE.GROUP]: 'groupId', [SCOPE.SERVER]: 'channelId' };

export default function Conversation({
    scope, peerId, title, subtitle, meId, myLogin, myRole,
    canModerate = false, headerExtra, onOpenProfile,
}) {
    const [messages, setMessages] = React.useState([]);
    const [pinned, setPinned] = React.useState([]);
    const [quotes, setQuotes] = React.useState({});
    const [loading, setLoading] = React.useState(true);
    const [hasMore, setHasMore] = React.useState(false);
    const [error, setError] = React.useState('');
    const [blocks, setBlocks] = React.useState({ iBlocked: false, blockedMe: false });

    const [text, setText] = React.useState('');
    const [replyTo, setReplyTo] = React.useState(null);
    const [editing, setEditing] = React.useState(null);
    const [attachment, setAttachment] = React.useState(null);
    const [sending, setSending] = React.useState(false);
    const [typers, setTypers] = React.useState([]);
    const [zoom, setZoom] = React.useState(null);

    const feedRef = React.useRef(null);
    const fileRef = React.useRef(null);
    const wire = WIRE[scope];

    // ── Загрузка страницы ─────────────────────────────────────────────

    const load = React.useCallback(async (beforeId = 0) => {
        try {
            const res = await ask(wire.history, { [idKey[scope]]: peerId, beforeId });
            const page = res.messages || [];

            if (beforeId === 0) {
                setMessages(page);
                setPinned(res.pinned || []);
                if (res.blocks) setBlocks(res.blocks);
            } else {
                // Догрузка вверх: сохраняем позицию прокрутки, иначе лента
                // прыгает и человек теряет место, где читал.
                const feed = feedRef.current;
                const before = feed ? feed.scrollHeight - feed.scrollTop : 0;
                setMessages((old) => [...page, ...old]);
                requestAnimationFrame(() => {
                    if (feed) feed.scrollTop = feed.scrollHeight - before;
                });
            }
            setHasMore(page.length >= 40);
            setError('');
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [scope, peerId, wire.history]);

    React.useEffect(() => {
        setLoading(true);
        setMessages([]);
        setPinned([]);
        setReplyTo(null);
        setEditing(null);
        setAttachment(null);
        setText('');
        load(0);

        // Входим в комнату событий и отмечаем прочитанное.
        if (scope === SCOPE.GROUP) ask('group:join_room', { groupId: peerId }).catch(() => {});
        if (scope === SCOPE.SERVER) {
            ask('channel:enter', { channelId: peerId }).catch(() => {});
            ask('channel:read', { channelId: peerId }).catch(() => {});
        }
        if (scope === SCOPE.DM) ask('chat:read', { partnerId: peerId }).catch(() => {});

        return () => {
            if (scope === SCOPE.GROUP) ask('group:leave_room', { groupId: peerId }).catch(() => {});
            if (scope === SCOPE.SERVER) ask('channel:exit', { channelId: peerId }).catch(() => {});
        };
    }, [scope, peerId, load]);

    // ── Живые события ─────────────────────────────────────────────────

    React.useEffect(() => {
        const offs = [
            on('message:new', ({ scope: s, peerId: p, message }) => {
                if (s !== scope) return;
                // В личных событие приходит с peerId = отправитель; своё
                // сообщение уже добавлено ответом на отправку.
                const mine = scope === SCOPE.DM
                    ? (p === peerId || message.senderId === meId)
                    : p === peerId;
                if (!mine) return;
                setMessages((old) => (old.some((m) => m.id === message.id) ? old : [...old, message]));
                if (scope === SCOPE.DM && message.senderId === peerId) {
                    ask('chat:read', { partnerId: peerId }).catch(() => {});
                }
                if (scope === SCOPE.SERVER) ask('channel:read', { channelId: peerId }).catch(() => {});
            }),
            on('message:edited', ({ scope: s, peerId: p, messageId, text: t }) => {
                if (s !== scope || p !== peerId) return;
                setMessages((old) => old.map((m) => (
                    m.id === messageId ? { ...m, text: t, isEdited: true } : m
                )));
            }),
            on('message:deleted', ({ scope: s, peerId: p, messageId }) => {
                if (s !== scope || p !== peerId) return;
                setMessages((old) => (scope === SCOPE.SERVER
                    ? old.filter((m) => m.id !== messageId)
                    : old.map((m) => (m.id === messageId ? { ...m, isDeleted: true, text: '' } : m))));
            }),
            on('reaction:updated', ({ scope: s, peerId: p, messageId, reactions }) => {
                if (s !== scope || p !== peerId) return;
                setMessages((old) => old.map((m) => (m.id === messageId ? { ...m, reactions } : m)));
            }),
            on('pin:updated', ({ scope: s, peerId: p, messageId, pinned: isPinned }) => {
                if (s !== scope || p !== peerId) return;
                setMessages((old) => old.map((m) => (m.id === messageId ? { ...m, isPinned } : m)));
            }),
            on('typing', ({ scope: s, peerId: p, userId, userName, typing }) => {
                if (s !== scope || p !== peerId || userId === meId) return;
                setTypers((old) => {
                    const rest = old.filter((t) => t.userId !== userId);
                    return typing ? [...rest, { userId, userName }] : rest;
                });
            }),
        ];
        return () => offs.forEach((off) => off());
    }, [scope, peerId, meId]);

    // «Печатает…» гаснет само: события «перестал» может и не прийти, если
    // вкладку закрыли на полуслове.
    React.useEffect(() => {
        if (typers.length === 0) return undefined;
        const t = setTimeout(() => setTypers([]), 6000);
        return () => clearTimeout(t);
    }, [typers]);

    // Прокрутка вниз на новых — но только если человек и так внизу, иначе
    // мы утащим его от места, которое он читает.
    const lastId = messages.length ? messages[messages.length - 1].id : 0;
    React.useEffect(() => {
        const feed = feedRef.current;
        if (!feed) return;
        const nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 260;
        if (nearBottom || loading) feed.scrollTop = feed.scrollHeight;
    }, [lastId, loading]);

    // Цитаты для ответов — по одной на каждое упомянутое сообщение.
    React.useEffect(() => {
        const need = messages
            .filter((m) => m.replyToId > 0 && !quotes[m.replyToId])
            .map((m) => m.replyToId);
        if (need.length === 0) return;
        [...new Set(need)].forEach((id) => {
            ask('message:quote', { scope, messageId: id })
                .then((r) => r.quote && setQuotes((q) => ({ ...q, [id]: r.quote })))
                .catch(() => {});
        });
    }, [messages, quotes, scope]);

    // ── Действия ──────────────────────────────────────────────────────

    async function send() {
        const body = text.trim();
        if (!body && !attachment) return;

        if (editing) {
            const id = editing.id;
            setEditing(null);
            setText('');
            try {
                await ask(wire.edit, {
                    scope, messageId: id, text: body, peerId, channelId: peerId,
                });
            } catch (err) { setError(err.message); }
            return;
        }

        setSending(true);
        try {
            const payload = {
                [wire.target]: peerId,
                text: body,
                replyToId: replyTo?.id || 0,
            };
            if (attachment) {
                payload[attachment.kind] = attachment.data;
                payload.fileName = attachment.name;
            }
            const res = await ask(wire.send, payload);
            if (res.message) {
                setMessages((old) => (old.some((m) => m.id === res.message.id) ? old : [...old, res.message]));
            }
            setText('');
            setReplyTo(null);
            setAttachment(null);
            if (fileRef.current) fileRef.current.value = '';
        } catch (err) {
            setError(err.message);
        } finally {
            setSending(false);
        }
    }

    function pickFile(e) {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            // Картинку кладём в image_data, остальное — в file_data: так же
            // раскладывают вложения ПК и Android, иначе на той стороне
            // картинка приедет безымянным файлом.
            const isImage = file.type.startsWith('image/');
            setAttachment({
                kind: isImage ? 'image' : 'file',
                name: file.name,
                data: reader.result,
                preview: isImage ? reader.result : null,
                size: file.size,
            });
        };
        reader.readAsDataURL(file);
    }

    const typingTimer = React.useRef(null);
    function onType(e) {
        setText(e.target.value);
        if (typingTimer.current) return;
        socketTyping(true);
        typingTimer.current = setTimeout(() => {
            typingTimer.current = null;
            socketTyping(false);
        }, 2500);
    }

    function socketTyping(typing) {
        if (scope === SCOPE.SERVER) return;   // в каналах ПК этого не шлёт
        socket.emit('typing', { scope, peerId, typing });
    }

    const react = (msg, emoji) => ask('reaction:toggle', {
        scope, messageId: msg.id, emoji, peerId,
    }).catch((e) => setError(e.message));

    const pin = (msg) => ask('pin:toggle', { scope, messageId: msg.id, peerId })
        .catch((e) => setError(e.message));

    const remove = (msg) => ask(wire.remove, {
        scope, messageId: msg.id, peerId, channelId: peerId,
    }).catch((e) => setError(e.message));

    function startEdit(msg) {
        setEditing(msg);
        setText(msg.text || '');
        setReplyTo(null);
    }

    // ── Отрисовка ─────────────────────────────────────────────────────

    const blocked = blocks.iBlocked || blocks.blockedMe;
    let lastDay = '';

    return (
        <div className="main">
            <div className="main-head">
                <div style={{ minWidth: 0 }}>
                    <div className="main-head-title">{title}</div>
                    {subtitle && <div className="main-head-sub">{subtitle}</div>}
                </div>
                <div className="spacer" />
                {headerExtra}
            </div>

            {pinned.length > 0 && (
                <div className="pinned-bar">
                    📌 <b>{pinned.length}</b> закреплено · {pinned[0].sender}: {pinned[0].text?.slice(0, 90) || 'вложение'}
                </div>
            )}

            {error && <div className="conn-banner">{error}</div>}

            <div className="feed" ref={feedRef}>
                {loading && <div className="empty">Загрузка…</div>}

                {!loading && messages.length === 0 && (
                    <Empty icon="💬" title="Пока пусто" hint="Напишите первое сообщение" />
                )}

                {hasMore && !loading && (
                    <div className="load-more">
                        <button onClick={() => load(messages[0]?.id || 0)}>Показать более ранние</button>
                    </div>
                )}

                {messages.map((m, i) => {
                    const day = formatDay(m.createdAtMs);
                    const showDay = day !== lastDay;
                    lastDay = day;
                    return (
                        <React.Fragment key={m.id}>
                            {showDay && <div className="day-sep">{day}</div>}
                            <Message
                                msg={m}
                                prev={showDay ? null : messages[i - 1]}
                                meId={meId}
                                myLogin={myLogin}
                                myRole={myRole}
                                quote={m.replyToId ? quotes[m.replyToId] : null}
                                canModerate={canModerate}
                                onReply={setReplyTo}
                                onEdit={startEdit}
                                onDelete={remove}
                                onReact={react}
                                onPin={pin}
                                onZoom={setZoom}
                            />
                        </React.Fragment>
                    );
                })}
            </div>

            <div className="composer">
                <div className="typing-line">
                    {typers.length > 0 && `${typers.map((t) => t.userName).join(', ')} печатает…`}
                </div>

                {replyTo && (
                    <div className="composer-reply">
                        <span>↩ Ответ <b>{replyTo.senderName}</b>: {(replyTo.text || 'вложение').slice(0, 60)}</span>
                        <div className="spacer" />
                        <button className="icon-btn" onClick={() => setReplyTo(null)}>✕</button>
                    </div>
                )}

                {editing && (
                    <div className="composer-reply">
                        <span>✎ Изменение сообщения</span>
                        <div className="spacer" />
                        <button className="icon-btn" onClick={() => { setEditing(null); setText(''); }}>✕</button>
                    </div>
                )}

                {attachment && (
                    <div className="attach-preview">
                        {attachment.preview
                            ? <img src={attachment.preview} alt="" />
                            : <span style={{ fontSize: 20 }}>📎</span>}
                        <span>{attachment.name}</span>
                        <div className="spacer" />
                        <button className="icon-btn" onClick={() => { setAttachment(null); if (fileRef.current) fileRef.current.value = ''; }}>✕</button>
                    </div>
                )}

                {blocked ? (
                    <div className="composer-box" style={{ justifyContent: 'center', color: 'var(--text-faint)', padding: 14 }}>
                        {blocks.iBlocked ? 'Вы заблокировали этого пользователя' : 'Пользователь ограничил вам отправку сообщений'}
                    </div>
                ) : (
                    <div className="composer-box">
                        <button className="icon-btn" title="Вложение" onClick={() => fileRef.current?.click()}>＋</button>
                        <input type="file" ref={fileRef} onChange={pickFile} style={{ display: 'none' }} />
                        <textarea
                            rows={1}
                            value={text}
                            placeholder={`Написать${title ? ` — ${title}` : ''}…`}
                            onChange={onType}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
                            }}
                            onInput={(e) => {
                                e.target.style.height = 'auto';
                                e.target.style.height = `${Math.min(e.target.scrollHeight, 180)}px`;
                            }}
                        />
                        <button className="icon-btn" disabled={sending} onClick={send} title="Отправить">
                            {sending ? '…' : '➤'}
                        </button>
                    </div>
                )}
            </div>

            {zoom && (
                <div className="lightbox" onClick={() => setZoom(null)}>
                    <img src={zoom} alt="" />
                </div>
            )}
        </div>
    );
}

import React from 'react';
import './styles/globals.css';

import Auth from './components/Auth';
import Conversation from './components/Conversation';
import IncomingCall from './components/IncomingCall';
import ErrorBoundary from './components/ErrorBoundary';
import ServerSettings from './components/ServerSettings';

// Окно звонка тянет за собой SDK LiveKit — полмегабайта, которые при
// открытии переписки не нужны. Грузим его, только когда звонок начался.
//
// Плашка входящего вызова СЮДА НЕ ВХОДИТ намеренно: ей SDK не нужен, а
// раньше она грузилась отсюда же и роняла всё приложение, пока SDK не
// загрузился или не был установлен. Опрос идёт раз в четыре секунды, так
// что хватало одной строки ringing в call_sessions, чтобы сайт погас
// через несколько секунд после входа.
const Call = React.lazy(() => import('./components/Call'));
import { Avatar, Empty } from './components/Common';
import { ServerRail, ChatList, ChannelList, MembersPanel } from './components/Sidebars';
import { FriendsPanel, SettingsModal, NewGroupModal, NewServerModal } from './components/Panels';

import * as api from './lib/api';
import { socket, ask, on } from './lib/socket';
import { SCOPE, presenceText, describeMessage } from './lib/format';
import { callBlockReason } from './lib/media';
import {
    ensurePermission, notify, sounds, setTitleBadge, windowFocused, canAskPermission,
} from './lib/notify';

export default function App() {
    const [me, setMe] = React.useState(api.getStoredUser());
    const [connected, setConnected] = React.useState(false);
    const [connError, setConnError] = React.useState('');
    const [loadError, setLoadError] = React.useState('');

    /**
     * Сообщение поверх экрана.
     *
     * Отдельно от connError намеренно: тот баннер показывается ТОЛЬКО при
     * оборванной связи, и ошибки звонка, которые складывали туда же,
     * человек не видел вовсе — связь-то в порядке.
     */
    const [notice, setNotice] = React.useState('');

    // Где мы сейчас: 'home' (личные) либо id сервера.
    const [place, setPlace] = React.useState('home');
    const [selected, setSelected] = React.useState(null);

    const [conversations, setConversations] = React.useState([]);
    const [groups, setGroups] = React.useState([]);
    const [presence, setPresence] = React.useState({});
    const [servers, setServers] = React.useState([]);
    const [friendRequests, setFriendRequests] = React.useState(0);

    // Открытый сервер.
    const [serverInfo, setServerInfo] = React.useState(null);
    const [serverPerms, setServerPerms] = React.useState({});
    const [channels, setChannels] = React.useState([]);
    const [voice, setVoice] = React.useState({});
    const [members, setMembers] = React.useState([]);

    const [callSession, setCallSession] = React.useState(null);
    const [incoming, setIncoming] = React.useState([]);
    const [modal, setModal] = React.useState(null);

    /**
     * Почему звонки недоступны (или null). Контекст страницы за время
     * жизни вкладки не меняется, поэтому считаем один раз.
     */
    const callsBlocked = React.useMemo(() => callBlockReason(), []);

    // ── Подключение ───────────────────────────────────────────────────

    React.useEffect(() => {
        if (!me) return undefined;
        socket.connect();

        const offs = [
            on('connect', () => { setConnected(true); setConnError(''); }),
            on('disconnect', () => setConnected(false)),
            on('connect_error', (e) => {
                setConnected(false);
                setConnError(
                    e.message === 'AUTH_INVALID_TOKEN'
                        ? 'Сессия истекла — войдите заново'
                        : 'Нет связи с сервером, пробуем переподключиться…',
                );
            }),
        ];
        return () => {
            offs.forEach((off) => off());
            socket.disconnect();
        };
    }, [me]);

    // ── Загрузка списков ──────────────────────────────────────────────

    /**
     * Ошибку запроса ПОКАЗЫВАЕМ, а не проглатываем.
     *
     * Раньше все загрузки заканчивались на `.catch(() => {})`, и упавший
     * запрос давал пустой экран без единого слова о причине: «зашёл, а
     * содержимого нет». Отличить сломанный запрос от честно пустого списка
     * было невозможно ни человеку, ни по логам.
     */
    const report = React.useCallback((what) => (err) => {
        console.error(`[PISMO] ${what}:`, err);
        setLoadError(`Не удалось загрузить: ${what}. ${err.message || ''}`.trim());
    }, []);

    const loadHome = React.useCallback(() => {
        ask('conversations:list').then((r) => {
            setConversations(r.conversations || []);
            setLoadError('');
            const ids = (r.conversations || []).map((c) => c.userId);
            if (ids.length) {
                // Присутствие — украшение: его падение не повод пугать человека.
                ask('presence:for', { userIds: ids })
                    .then((p) => setPresence(p.presence || {})).catch(() => {});
            }
        }).catch(report('список диалогов'));

        ask('groups:list').then((r) => setGroups(r.groups || []))
            .catch(report('список групп'));
        ask('friends:list').then((r) => setFriendRequests((r.incoming || []).length))
            .catch(report('друзья'));
    }, [report]);

    const loadServers = React.useCallback(() => {
        ask('servers:list').then((r) => setServers(r.servers || []))
            .catch(report('список серверов'));
    }, [report]);

    React.useEffect(() => {
        if (!connected) return;
        loadHome();
        loadServers();
    }, [connected, loadHome, loadServers]);

    // Открытие сервера: сведения, каналы, участники, кто в голосовых.
    const loadServer = React.useCallback((serverId) => {
        ask('server:enter', { serverId }).catch(() => {});
        ask('server:info', { serverId }).then((r) => {
            setServerInfo({ id: serverId, ...r.info });
            setServerPerms(r.perms || {});
            setChannels(r.channels || []);
            setVoice(r.voice || {});
            // Открываем первый текстовый канал, чтобы окно не пустовало.
            const firstText = (r.channels || []).find((c) => c.type !== 'voice');
            if (firstText) setSelected({ kind: 'channel', id: firstText.id, name: firstText.name });
            else setSelected(null);
        }).catch(report('сведения о сервере'));

        ask('server:members', { serverId }).then((r) => {
            setMembers(r.members || []);
            setPresence((old) => ({ ...old, ...(r.presence || {}) }));
        }).catch(report('участники сервера'));
    }, [report]);

    React.useEffect(() => {
        if (!connected) return;
        if (place === 'home') { setSelected(null); setServerInfo(null); }
        else loadServer(place);
    }, [place, connected, loadServer]);

    // ── Живые события списков ─────────────────────────────────────────

    React.useEffect(() => {
        if (!connected) return undefined;
        const offs = [
            on('chat:list_update', loadHome),
            on('group:list_update', loadHome),
            on('group:created', loadHome),
            on('friends:changed', loadHome),
            on('messages:read', loadHome),
            on('badges:changed', () => {
                loadServers();
                if (place !== 'home') {
                    ask('server:info', { serverId: place })
                        .then((r) => setChannels(r.channels || [])).catch(() => {});
                }
            }),
            on('voice:changed', ({ serverId }) => {
                if (serverId === place) {
                    ask('voice:list', { serverId }).then((r) => setVoice(r.voice || {})).catch(() => {});
                }
            }),
            on('channels:changed', ({ serverId }) => { if (serverId === place) loadServer(serverId); }),
            on('roles:changed', ({ serverId }) => { if (serverId === place) loadServer(serverId); }),
            on('members:changed', ({ serverId }) => {
                if (serverId === place) {
                    ask('server:members', { serverId }).then((r) => setMembers(r.members || [])).catch(() => {});
                }
            }),
            on('server:deleted', () => { setPlace('home'); loadServers(); }),
            on('server:kicked', () => { setPlace('home'); loadServers(); }),
        ];
        return () => offs.forEach((off) => off());
    }, [connected, place, loadHome, loadServers, loadServer]);

    // Новое сообщение в неоткрытом чате — обновляем список, чтобы карточка
    // поднялась и загорелся счётчик.
    React.useEffect(() => on('message:new', ({ scope, peerId }) => {
        const openHere = selected
            && ((scope === SCOPE.DM && selected.kind === 'dm' && selected.id === peerId)
                || (scope === SCOPE.GROUP && selected.kind === 'group' && selected.id === peerId)
                || (scope === SCOPE.SERVER && selected.kind === 'channel' && selected.id === peerId));
        if (!openHere) {
            if (scope === SCOPE.SERVER) loadServers();
            else loadHome();
        }
    }), [selected, loadHome, loadServers]);

    // ── Присутствие ───────────────────────────────────────────────────

    React.useEffect(() => {
        if (!connected) return undefined;
        const beat = () => socket.emit('presence:beat', { active: !document.hidden });
        beat();
        // Такт как на ПК; статус «в сети» держится 40 секунд, так что 15 —
        // с запасом даже при пропущенном такте.
        const t = setInterval(beat, 15000);
        return () => clearInterval(t);
    }, [connected]);

    React.useEffect(() => {
        if (!connected) return undefined;
        const refresh = () => {
            const ids = [
                ...conversations.map((c) => c.userId),
                ...members.map((m) => m.userId),
            ];
            if (ids.length === 0) return;
            ask('presence:for', { userIds: [...new Set(ids)] })
                .then((r) => setPresence((old) => ({ ...old, ...(r.presence || {}) })))
                .catch(() => {});
        };
        const t = setInterval(refresh, 20000);
        return () => clearInterval(t);
    }, [connected, conversations, members]);

    // ── Уведомления ───────────────────────────────────────────────────

    /**
     * Что сейчас открыто. Нужно, чтобы не звенеть о сообщении, которое
     * человек и так видит перед собой — ПК и Android ведут себя так же.
     */
    const openRef = React.useRef(null);
    React.useEffect(() => { openRef.current = selected; }, [selected]);

    /**
     * О каких сообщениях уже звенели.
     *
     * Событие message:new приходит дважды, когда пишут через сайт: сразу от
     * обработчика отправки и следом от опроса базы (он видит ту же строку и
     * не знает, что её уже разослали). В ленте дубль отсекается по id, а
     * вот звук и уведомление прозвучали бы оба раза.
     *
     * Держим ограниченное окно последних id: список без предела за сутки
     * работы вырос бы на десятки тысяч записей.
     */
    const notified = React.useRef(new Set());
    const rememberNotified = React.useCallback((key) => {
        if (notified.current.has(key)) return false;
        notified.current.add(key);
        if (notified.current.size > 500) {
            // Set хранит порядок вставки — выбрасываем самые старые.
            const extra = notified.current.size - 400;
            let i = 0;
            for (const k of notified.current) {
                if (i++ >= extra) break;
                notified.current.delete(k);
            }
        }
        return true;
    }, []);

    /** Разрешение спрашиваем один раз, после входа. */
    React.useEffect(() => {
        if (!me) return;
        if (canAskPermission()) ensurePermission().catch(() => {});
    }, [me]);

    /** Счётчик непрочитанных в заголовке вкладки — замена мигания окна на ПК. */
    React.useEffect(() => {
        const dm = conversations.reduce((n, c) => n + (c.unread || 0), 0);
        const gr = groups.reduce((n, g) => n + (g.unread || 0), 0);
        const sv = servers.reduce((n, s) => n + (s.mentions || 0), 0);
        setTitleBadge(dm + gr + sv);
    }, [conversations, groups, servers]);

    /**
     * Уведомление о новом сообщении.
     *
     * Молчим в двух случаях: сообщение своё и чат уже открыт на экране, а
     * вкладка на виду. Во втором случае человек и так его видит, а лишний
     * звон раздражает — то же правило действует на ПК.
     */
    React.useEffect(() => {
        if (!me) return undefined;

        return on('message:new', ({ scope, peerId, message }) => {
            if (!message || message.senderId === me.id) return;

            const open = openRef.current;
            const looking = windowFocused() && open
                && ((scope === SCOPE.DM && open.kind === 'dm' && open.id === peerId)
                    || (scope === SCOPE.GROUP && open.kind === 'group' && open.id === peerId)
                    || (scope === SCOPE.SERVER && open.kind === 'channel' && open.id === peerId));
            if (looking) return;

            // Канал уведомляет отдельным событием (там ещё упоминания и
            // заглушённые серверы), поэтому здесь его пропускаем.
            if (scope === SCOPE.SERVER) return;

            if (!rememberNotified(`m${message.id}`)) return;

            const preview = describeMessage(message);
            sounds.message();
            notify({
                title: scope === SCOPE.GROUP ? `${message.senderName} · группа` : message.senderName,
                body: preview,
                tag: `${scope}:${peerId}`,
                onClick: () => {
                    if (scope === SCOPE.GROUP) setSelected({ kind: 'group', id: peerId, name: '' });
                    else setSelected({ kind: 'dm', id: peerId, name: message.senderName });
                },
            });
        });
    }, [me, rememberNotified]);

    /**
     * Каналы серверов. Отдельно от message:new: бэкенд уже отсеял
     * заглушённые серверы и пометил, упомянули ли меня, — на ПК и Android
     * «упомянули» и «просто новое сообщение» это разные поводы.
     */
    React.useEffect(() => {
        if (!me) return undefined;

        return on('channel:activity', ({ serverId, channelId, channelName, preview, mention }) => {
            const open = openRef.current;
            const looking = windowFocused() && open
                && open.kind === 'channel' && open.id === channelId;
            if (looking) return;

            // Без упоминания звеним только когда вкладка не на виду:
            // иначе каждый живой канал превращается в трещотку.
            if (!mention && windowFocused()) return;
            if (!rememberNotified(`c${channelId}:${preview}`)) return;

            if (mention) sounds.mention(); else sounds.message();
            notify({
                title: mention ? `Вас упомянули в #${channelName}` : `#${channelName}`,
                body: preview,
                tag: `channel:${channelId}`,
                onClick: () => {
                    setPlace(serverId);
                    setSelected({ kind: 'channel', id: channelId, name: channelName });
                },
            });
        });
    }, [me, rememberNotified]);

    /** Заявки в друзья — о них на ПК тоже сообщают. */
    const knownRequests = React.useRef(null);
    React.useEffect(() => {
        if (knownRequests.current === null) { knownRequests.current = friendRequests; return; }
        if (friendRequests > knownRequests.current) {
            sounds.message();
            notify({
                title: 'Заявка в друзья',
                body: friendRequests > 1 ? `Заявок: ${friendRequests}` : 'Новая заявка',
                tag: 'friends',
                onClick: () => { setPlace('home'); setSelected({ kind: 'friends' }); },
            });
        }
        knownRequests.current = friendRequests;
    }, [friendRequests]);

    // ── Звонки ────────────────────────────────────────────────────────

    React.useEffect(() => {
        if (!connected) return undefined;
        const offs = [
            on('call:incoming', (call) => {
                setIncoming((old) => {
                    if (old.some((c) => c.callId === call.callId)) return old;
                    // Звеним и показываем шторку только на действительно
                    // новом вызове, иначе опрос повторял бы это каждый такт.
                    sounds.call();
                    notify({
                        title: `Звонок: ${call.callerName}`,
                        body: call.groupId ? 'Групповой звонок' : 'Входящий вызов',
                        tag: `call:${call.callId}`,
                    });
                    return [...old, call];
                });
            }),
            on('call:ended', ({ callId }) => {
                setIncoming((old) => old.filter((c) => c.callId !== callId));
                setCallSession((s) => (s?.callId === callId ? null : s));
            }),
            on('call:declined', ({ callId }) => {
                setIncoming((old) => old.filter((c) => c.callId !== callId));
            }),
        ];

        /**
         * Подстраховка на случай, если событие потерялось.
         *
         * Основной путь теперь другой: бэкенд сам смотрит в call_sessions и
         * шлёт call:incoming — иначе звонок с ПК или телефона на сайте не
         * появлялся бы, они о нашем сокете не знают. Поэтому здесь редкий
         * такт, а не частый: он нужен только чтобы подобрать вызов, который
         * начался до подключения сокета.
         */
        const poll = () => {
            ask('call:poll').then((r) => {
                for (const c of r.calls || []) {
                    // Через тот же обработчик, что и событие: там звук и
                    // уведомление, и дубли отсекаются по callId.
                    setIncoming((old) => (old.some((x) => x.callId === c.id) ? old : [...old, {
                        callId: c.id,
                        callerId: c.callerId,
                        callerName: c.callerName,
                        groupId: c.groupId,
                        hasVideo: c.hasVideo,
                    }]));
                }
            }).catch(() => {});
        };
        poll();
        const t = setInterval(poll, 15000);

        return () => { offs.forEach((off) => off()); clearInterval(t); };
    }, [connected]);

    async function startCall(withVideo) {
        try {
            const payload = selected.kind === 'group'
                ? { groupId: selected.id, hasVideo: withVideo }
                : { calleeId: selected.id, hasVideo: withVideo };
            const s = await ask('call:invite', payload);
            setCallSession({ ...s, title: selected.name });
        } catch (e) { setNotice(e.message); }
    }

    async function acceptCall(call) {
        setIncoming((old) => old.filter((c) => c.callId !== call.callId));
        try {
            const s = await ask('call:accept', { callId: call.callId });
            setCallSession({ ...s, title: call.callerName });
        } catch (e) { setNotice(e.message); }
    }

    async function declineCall(call) {
        setIncoming((old) => old.filter((c) => c.callId !== call.callId));
        ask('call:decline', { callId: call.callId }).catch(() => {});
    }

    async function joinVoice(channel) {
        // Проверяем до похода на сервер: иначе отметимся в voice_presence,
        // и на ПК будет видно, что человек «в канале», хотя он не слышен.
        if (callsBlocked) {
            setNotice(`${callsBlocked.short}. ${callsBlocked.full}`);
            return;
        }
        try {
            const s = await ask('voice:join', { channelId: channel.id });
            setCallSession({ ...s, channelId: channel.id, title: `🔊 ${channel.name}` });
        } catch (e) { setNotice(e.message); }
    }

    // ── Выход ─────────────────────────────────────────────────────────

    function logout() {
        socket.disconnect();
        api.clearSession();
        setMe(null);
        setPlace('home');
        setSelected(null);
    }

    if (!me) return <Auth onReady={setMe} />;

    // ── Что показываем в середине ─────────────────────────────────────

    let main;
    if (selected?.kind === 'friends') {
        main = (
            <FriendsPanel
                onReload={loadHome}
                onOpenChat={(id, name) => setSelected({ kind: 'dm', id, name })}
            />
        );
    } else if (selected?.kind === 'dm') {
        main = (
            <Conversation
                key={`dm${selected.id}`}
                scope={SCOPE.DM}
                peerId={selected.id}
                title={selected.name}
                subtitle={presenceText(presence[selected.id])}
                meId={me.id}
                myLogin={me.login}
                headerExtra={(
                    <>
                        <button
                            className="icon-btn"
                            title={callsBlocked ? `${callsBlocked.short}. ${callsBlocked.full}` : 'Позвонить'}
                            style={callsBlocked ? { opacity: .4 } : undefined}
                            onClick={() => (callsBlocked ? setNotice(`${callsBlocked.short}. ${callsBlocked.full}`) : startCall(false))}
                        >
                            📞
                        </button>
                        <button
                            className="icon-btn"
                            title={callsBlocked ? `${callsBlocked.short}. ${callsBlocked.full}` : 'Видеозвонок'}
                            style={callsBlocked ? { opacity: .4 } : undefined}
                            onClick={() => (callsBlocked ? setNotice(`${callsBlocked.short}. ${callsBlocked.full}`) : startCall(true))}
                        >
                            📹
                        </button>
                    </>
                )}
            />
        );
    } else if (selected?.kind === 'group') {
        main = (
            <Conversation
                key={`gr${selected.id}`}
                scope={SCOPE.GROUP}
                peerId={selected.id}
                title={selected.name}
                subtitle={selected.memberCount ? `${selected.memberCount} участников` : ''}
                meId={me.id}
                myLogin={me.login}
                headerExtra={(
                    <button
                        className="icon-btn"
                        title={callsBlocked ? `${callsBlocked.short}. ${callsBlocked.full}` : 'Групповой звонок'}
                        style={callsBlocked ? { opacity: .4 } : undefined}
                        onClick={() => (callsBlocked ? setNotice(`${callsBlocked.short}. ${callsBlocked.full}`) : startCall(false))}
                    >
                        📞
                    </button>
                )}
            />
        );
    } else if (selected?.kind === 'channel') {
        main = (
            <Conversation
                key={`ch${selected.id}`}
                scope={SCOPE.SERVER}
                peerId={selected.id}
                title={`# ${selected.name}`}
                subtitle={serverInfo?.name}
                meId={me.id}
                myLogin={me.login}
                myRole={serverPerms.roleName}
                canModerate={Boolean(serverPerms.isOwner || serverPerms.canManage)}
            />
        );
    } else {
        main = (
            <div className="main">
                <div className="main-head"><div className="main-head-title">PISMO</div></div>
                <Empty
                    icon="👋"
                    title={place === 'home' ? 'Выберите диалог слева' : 'Выберите канал'}
                    hint="Переписка общая с приложением на ПК и Android"
                />
            </div>
        );
    }

    return (
        <div className="app">
            <ServerRail
                servers={servers}
                active={place}
                onPick={setPlace}
                onCreate={() => setModal('server')}
            />

            {place === 'home' ? (
                <ChatList
                    conversations={conversations}
                    groups={groups}
                    presence={presence}
                    selected={selected}
                    friendRequests={friendRequests}
                    onSelect={setSelected}
                    onOpenFriends={() => setSelected({ kind: 'friends' })}
                    onNewGroup={() => setModal('group')}
                />
            ) : (
                <ChannelList
                    server={serverInfo}
                    channels={channels}
                    voice={voice}
                    perms={serverPerms}
                    selectedId={selected?.kind === 'channel' ? selected.id : null}
                    activeVoiceChannel={callSession?.channelId}
                    onSelect={(c) => setSelected({ kind: 'channel', id: c.id, name: c.name })}
                    onJoinVoice={joinVoice}
                    onManage={() => setModal('serverSettings')}
                />
            )}

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
                {!connected && <div className="conn-banner">{connError || 'Подключение…'}</div>}
                {notice && (
                    <div className="conn-banner">
                        {notice}
                        <button style={{ marginLeft: 10, fontWeight: 700 }} onClick={() => setNotice('')}>✕</button>
                    </div>
                )}
                {connected && loadError && (
                    <div className="conn-banner">
                        {loadError}
                        <button
                            style={{ marginLeft: 10, textDecoration: 'underline' }}
                            onClick={() => { setLoadError(''); loadHome(); loadServers(); }}
                        >
                            Повторить
                        </button>
                    </div>
                )}
                <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
                    {main}
                    {place !== 'home' && members.length > 0 && (
                        <MembersPanel members={members} presence={presence} />
                    )}
                </div>
            </div>

            {/* Нижняя плашка со своим профилем — как в ПК-версии. */}
            <div style={{
                position: 'fixed', left: 68, bottom: 0, width: 258,
                display: 'flex', alignItems: 'center', gap: 8,
                padding: 8, background: 'var(--bg-rail)', borderTop: '1px solid var(--line)',
            }}>
                <Avatar userId={me.id} name={me.name} size="avatar-sm" hideDot />
                <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="list-item-name" style={{ fontSize: 13 }}>{me.name}</div>
                    <div className="faint" style={{ fontSize: 11 }}>@{me.login}</div>
                </div>
                <button className="icon-btn" title="Настройки" onClick={() => setModal('settings')}>⚙</button>
                <button className="icon-btn" title="Выйти" onClick={logout}>⏻</button>
            </div>

            {/*
              * Звонок — в своей границе и своём Suspense. Если SDK не
              * загрузится, погаснет только окно звонка: переписка, серверы
              * и списки останутся на месте.
              */}
            <ErrorBoundary fallback={null}>
                <React.Suspense fallback={null}>
                    {callSession && (
                        <Call
                            session={callSession}
                            meId={me.id}
                            meName={me.name}
                            onClose={() => setCallSession(null)}
                        />
                    )}
                </React.Suspense>
            </ErrorBoundary>

            {/* Плашке входящего SDK не нужен — она рисуется всегда. */}
            {incoming.map((call) => (
                <IncomingCall
                    key={call.callId}
                    call={call}
                    onAccept={acceptCall}
                    onDecline={declineCall}
                />
            ))}

            {modal === 'settings' && (
                <SettingsModal
                    me={me}
                    onClose={() => setModal(null)}
                    onUpdated={(p) => {
                        const next = { ...me, name: p.displayName, login: p.login };
                        setMe(next);
                        api.storeSession(api.getToken(), next);
                    }}
                />
            )}
            {modal === 'group' && (
                <NewGroupModal
                    onClose={() => setModal(null)}
                    onCreated={(id, name) => {
                        setModal(null);
                        loadHome();
                        setSelected({ kind: 'group', id, name });
                    }}
                />
            )}
            {modal === 'server' && (
                <NewServerModal
                    onClose={() => setModal(null)}
                    onDone={(id) => { setModal(null); loadServers(); setPlace(id); }}
                />
            )}
            {modal === 'serverSettings' && serverInfo && (
                <ServerSettings
                    server={serverInfo}
                    perms={serverPerms}
                    channels={channels}
                    onClose={() => setModal(null)}
                    onChanged={() => { loadServer(place); loadServers(); }}
                />
            )}
        </div>
    );
}

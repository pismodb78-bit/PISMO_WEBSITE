import React from 'react';
import './styles/globals.css';

import Auth from './components/Auth';
import Conversation from './components/Conversation';
// Звонки тянут за собой SDK LiveKit — полмегабайта, которые при открытии
// переписки не нужны. Грузим их только когда звонок действительно начался.
const Call = React.lazy(() => import('./components/Call'));
const IncomingCall = React.lazy(() => import('./components/Call').then(
    (m) => ({ default: m.IncomingCall }),
));
import ServerSettings from './components/ServerSettings';
import { Avatar, Empty } from './components/Common';
import { ServerRail, ChatList, ChannelList, MembersPanel } from './components/Sidebars';
import { FriendsPanel, SettingsModal, NewGroupModal, NewServerModal } from './components/Panels';

import * as api from './lib/api';
import { socket, ask, on } from './lib/socket';
import { SCOPE, presenceText } from './lib/format';

export default function App() {
    const [me, setMe] = React.useState(api.getStoredUser());
    const [connected, setConnected] = React.useState(false);
    const [connError, setConnError] = React.useState('');

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

    const loadHome = React.useCallback(() => {
        ask('conversations:list').then((r) => {
            setConversations(r.conversations || []);
            const ids = (r.conversations || []).map((c) => c.userId);
            if (ids.length) {
                ask('presence:for', { userIds: ids })
                    .then((p) => setPresence(p.presence || {})).catch(() => {});
            }
        }).catch(() => {});
        ask('groups:list').then((r) => setGroups(r.groups || [])).catch(() => {});
        ask('friends:list').then((r) => setFriendRequests((r.incoming || []).length)).catch(() => {});
    }, []);

    const loadServers = React.useCallback(() => {
        ask('servers:list').then((r) => setServers(r.servers || [])).catch(() => {});
    }, []);

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
        }).catch((e) => setConnError(e.message));

        ask('server:members', { serverId }).then((r) => {
            setMembers(r.members || []);
            setPresence((old) => ({ ...old, ...(r.presence || {}) }));
        }).catch(() => {});
    }, []);

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

    // ── Звонки ────────────────────────────────────────────────────────

    React.useEffect(() => {
        if (!connected) return undefined;
        const offs = [
            on('call:incoming', (call) => {
                setIncoming((old) => (old.some((c) => c.callId === call.callId) ? old : [...old, call]));
            }),
            on('call:ended', ({ callId }) => {
                setIncoming((old) => old.filter((c) => c.callId !== callId));
                setCallSession((s) => (s?.callId === callId ? null : s));
            }),
            on('call:declined', ({ callId }) => {
                setIncoming((old) => old.filter((c) => c.callId !== callId));
            }),
        ];

        // Опрос входящих: позвонить могут с телефона или ПК, а они о нашем
        // сокете ничего не знают — просто пишут строку в call_sessions.
        const poll = () => {
            ask('call:poll').then((r) => {
                if (r.calls?.length) {
                    setIncoming((old) => {
                        const known = new Set(old.map((c) => c.callId));
                        const fresh = r.calls
                            .filter((c) => !known.has(c.id))
                            .map((c) => ({
                                callId: c.id,
                                callerId: c.callerId,
                                callerName: c.callerName,
                                groupId: c.groupId,
                                hasVideo: c.hasVideo,
                            }));
                        return fresh.length ? [...old, ...fresh] : old;
                    });
                }
            }).catch(() => {});
        };
        poll();
        const t = setInterval(poll, 4000);

        return () => { offs.forEach((off) => off()); clearInterval(t); };
    }, [connected]);

    async function startCall(withVideo) {
        try {
            const payload = selected.kind === 'group'
                ? { groupId: selected.id, hasVideo: withVideo }
                : { calleeId: selected.id, hasVideo: withVideo };
            const s = await ask('call:invite', payload);
            setCallSession({ ...s, title: selected.name });
        } catch (e) { setConnError(e.message); }
    }

    async function acceptCall(call) {
        setIncoming((old) => old.filter((c) => c.callId !== call.callId));
        try {
            const s = await ask('call:accept', { callId: call.callId });
            setCallSession({ ...s, title: call.callerName });
        } catch (e) { setConnError(e.message); }
    }

    async function declineCall(call) {
        setIncoming((old) => old.filter((c) => c.callId !== call.callId));
        ask('call:decline', { callId: call.callId }).catch(() => {});
    }

    async function joinVoice(channel) {
        try {
            const s = await ask('voice:join', { channelId: channel.id });
            setCallSession({ ...s, channelId: channel.id, title: `🔊 ${channel.name}` });
        } catch (e) { setConnError(e.message); }
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
                        <button className="icon-btn" title="Позвонить" onClick={() => startCall(false)}>📞</button>
                        <button className="icon-btn" title="Видеозвонок" onClick={() => startCall(true)}>📹</button>
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
                    <button className="icon-btn" title="Групповой звонок" onClick={() => startCall(false)}>📞</button>
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

            <React.Suspense fallback={null}>
                {callSession && (
                    <Call
                        session={callSession}
                        meId={me.id}
                        meName={me.name}
                        onClose={() => setCallSession(null)}
                    />
                )}

                {incoming.map((call) => (
                    <IncomingCall
                        key={call.callId}
                        call={call}
                        onAccept={acceptCall}
                        onDecline={declineCall}
                    />
                ))}
            </React.Suspense>

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

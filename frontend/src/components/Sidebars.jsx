import React from 'react';
import { Avatar, Blob, Empty } from './Common';
import { colorFor, formatListTime } from '../lib/format';

/** Рельс слева: личные сообщения, друзья и кружки серверов. */
export function ServerRail({ servers, active, onPick, onCreate }) {
    return (
        <div className="rail">
            <button
                className={`rail-btn ${active === 'home' ? 'active' : ''}`}
                onClick={() => onPick('home')}
                title="Личные сообщения"
            >
                💬
            </button>
            <div className="rail-sep" />

            {servers.map((s) => (
                <button
                    key={s.id}
                    className={`rail-btn ${active === s.id ? 'active' : ''}`}
                    onClick={() => onPick(s.id)}
                    title={s.name}
                >
                    <Blob name={s.name} />
                    {(s.mentions > 0 || s.unread > 0) && (
                        <span className="rail-badge">{s.mentions > 0 ? s.mentions : s.unread}</span>
                    )}
                </button>
            ))}

            <button className="rail-btn" onClick={onCreate} title="Создать или найти сервер">＋</button>
        </div>
    );
}

/** Список личных диалогов и групп. */
export function ChatList({
    conversations, groups, presence, selected, onSelect,
    onNewGroup, onOpenFriends, friendRequests,
}) {
    const [query, setQuery] = React.useState('');

    const q = query.trim().toLowerCase();
    const filteredChats = conversations.filter(
        (c) => !q || c.name.toLowerCase().includes(q) || c.login.toLowerCase().includes(q),
    );
    const filteredGroups = groups.filter((g) => !q || g.name.toLowerCase().includes(q));

    return (
        <div className="sidebar">
            <div className="sidebar-head">
                <input
                    placeholder="Поиск"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                />
            </div>

            <div className="sidebar-list">
                <button
                    className={`list-item ${selected?.kind === 'friends' ? 'active' : ''}`}
                    onClick={onOpenFriends}
                >
                    <span style={{ width: 34, textAlign: 'center', fontSize: 18 }}>👥</span>
                    <div className="list-item-body">
                        <div className="list-item-name">Друзья</div>
                    </div>
                    {friendRequests > 0 && <span className="badge">{friendRequests}</span>}
                </button>

                <div className="section-title">
                    Группы
                    <button
                        style={{ float: 'right', color: 'var(--text-faint)' }}
                        onClick={onNewGroup}
                        title="Создать группу"
                    >
                        ＋
                    </button>
                </div>

                {filteredGroups.map((g) => (
                    <button
                        key={`g${g.id}`}
                        className={`list-item ${selected?.kind === 'group' && selected.id === g.id ? 'active' : ''}`}
                        onClick={() => onSelect({ kind: 'group', id: g.id, name: g.name, memberCount: g.memberCount })}
                    >
                        <div className="avatar" style={{ background: g.avatarColorHex || colorFor(g.name) }}>
                            {g.name.slice(0, 2).toUpperCase()}
                        </div>
                        <div className="list-item-body">
                            <div className="list-item-name">{g.name}</div>
                            <div className="list-item-sub">{g.lastMessage || `${g.memberCount} участников`}</div>
                        </div>
                        <div className="list-item-meta">
                            <span className="faint" style={{ fontSize: 11 }}>{formatListTime(g.lastTimeMs)}</span>
                            {g.unread > 0 && <span className="badge">{g.unread}</span>}
                        </div>
                    </button>
                ))}
                {filteredGroups.length === 0 && <div className="faint" style={{ padding: '4px 8px', fontSize: 12 }}>Групп нет</div>}

                <div className="section-title">Личные сообщения</div>

                {filteredChats.map((c) => (
                    <button
                        key={`c${c.userId}`}
                        className={`list-item ${selected?.kind === 'dm' && selected.id === c.userId ? 'active' : ''}`}
                        onClick={() => onSelect({ kind: 'dm', id: c.userId, name: c.name, login: c.login })}
                    >
                        <Avatar userId={c.userId} name={c.name} presence={presence[c.userId]} />
                        <div className="list-item-body">
                            <div className="list-item-name">{c.name}</div>
                            <div className="list-item-sub">{c.lastMessage || `@${c.login}`}</div>
                        </div>
                        <div className="list-item-meta">
                            <span className="faint" style={{ fontSize: 11 }}>{formatListTime(c.lastTimeMs)}</span>
                            {c.unread > 0 && <span className="badge">{c.unread}</span>}
                        </div>
                    </button>
                ))}
                {filteredChats.length === 0 && (
                    <div className="faint" style={{ padding: '4px 8px', fontSize: 12 }}>
                        Никого нет. Найдите людей во «Друзьях».
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * Каналы сервера. Голосовые показывают, кто сейчас в эфире — данные те же,
 * что видят ПК и телефон (таблица voice_presence).
 */
export function ChannelList({
    server, channels, voice, perms, selectedId, onSelect,
    onJoinVoice, onManage, activeVoiceChannel,
}) {
    const text = channels.filter((c) => c.type !== 'voice');
    const voiceChannels = channels.filter((c) => c.type === 'voice');

    return (
        <div className="sidebar">
            <div className="sidebar-head">
                <div className="sidebar-title">{server?.name || 'Сервер'}</div>
                <button className="icon-btn" onClick={onManage} title="Настройки сервера">⚙</button>
            </div>

            <div className="sidebar-list">
                <div className="section-title">Текстовые каналы</div>
                {text.map((c) => (
                    <button
                        key={c.id}
                        className={`list-item channel-item ${selectedId === c.id ? 'active' : ''}`}
                        onClick={() => onSelect(c)}
                    >
                        <span className="channel-hash">#</span>
                        <div className="list-item-body">
                            <div className="list-item-name">{c.name}</div>
                        </div>
                        {c.mentions > 0
                            ? <span className="badge badge-mention">{c.mentions}</span>
                            : c.unread > 0 && <span className="badge">{c.unread}</span>}
                    </button>
                ))}
                {text.length === 0 && <div className="faint" style={{ padding: '4px 8px', fontSize: 12 }}>Каналов нет</div>}

                <div className="section-title">Голосовые каналы</div>
                {voiceChannels.map((c) => {
                    const members = voice[c.id] || [];
                    const full = c.userLimit > 0 && members.length >= c.userLimit;
                    const here = activeVoiceChannel === c.id;
                    return (
                        <div key={c.id}>
                            <button
                                className={`list-item channel-item ${here ? 'active' : ''}`}
                                onClick={() => onJoinVoice(c)}
                                title={full ? 'Канал заполнен' : 'Войти в голосовой канал'}
                            >
                                <span className="channel-hash">🔊</span>
                                <div className="list-item-body">
                                    <div className="list-item-name">{c.name}</div>
                                </div>
                                {c.userLimit > 0 && (
                                    <span className="faint" style={{ fontSize: 11 }}>
                                        {members.length}/{c.userLimit}
                                    </span>
                                )}
                            </button>
                            {members.length > 0 && (
                                <div className="voice-members">
                                    {members.map((m) => (
                                        <div className="voice-member" key={m.userId}>
                                            <Avatar userId={m.userId} name={m.name} size="avatar-sm" hideDot />
                                            <span style={{ flex: 1, minWidth: 0 }}>{m.name}</span>
                                            <span className="voice-flags">
                                                {m.micMuted && <span title="Микрофон выключен">🔇</span>}
                                                {m.deafened && <span title="Звук выключен">🔕</span>}
                                                {m.streaming && <span title="Демонстрация">🖥</span>}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    );
                })}
                {voiceChannels.length === 0 && <div className="faint" style={{ padding: '4px 8px', fontSize: 12 }}>Каналов нет</div>}
            </div>
        </div>
    );
}

/** Участники сервера — справа, сгруппированы по ролям, как на ПК. */
export function MembersPanel({ members, presence }) {
    const groupsByRole = React.useMemo(() => {
        const map = new Map();
        for (const m of members) {
            const key = m.isOwner ? 'Владелец' : (m.roleName || 'Участники');
            if (!map.has(key)) map.set(key, []);
            map.get(key).push(m);
        }
        return [...map.entries()];
    }, [members]);

    return (
        <div className="panel">
            <div className="panel-head">Участники — {members.length}</div>
            <div className="panel-list">
                {groupsByRole.map(([role, list]) => (
                    <div key={role}>
                        <div className="section-title">{role} — {list.length}</div>
                        {list.map((m) => (
                            <div className="list-item" key={m.userId}>
                                <Avatar userId={m.userId} name={m.name} presence={presence[m.userId]} size="avatar-sm" />
                                <div className="list-item-body">
                                    <div
                                        className="list-item-name"
                                        style={m.roleColor ? { color: m.roleColor } : undefined}
                                    >
                                        {m.name}
                                    </div>
                                </div>
                            </div>
                        ))}
                    </div>
                ))}
                {members.length === 0 && <Empty icon="👤" title="Пусто" />}
            </div>
        </div>
    );
}

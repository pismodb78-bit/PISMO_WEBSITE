import React from 'react';
import { Modal, Field, Check, Avatar } from './Common';
import { ask } from '../lib/socket';

/**
 * Настройки сервера: каналы, роли, участники и баны.
 *
 * Кнопки прячутся по правам, но это только удобство — каждое действие
 * бэкенд перепроверяет сам (см. socket/servers.js). Прятать и не проверять
 * означало бы, что права обходятся через консоль браузера.
 */
export default function ServerSettings({ server, perms, channels, onClose, onChanged }) {
    const [tab, setTab] = React.useState('channels');
    const [error, setError] = React.useState('');
    const [members, setMembers] = React.useState([]);
    const [roles, setRoles] = React.useState([]);
    const [banned, setBanned] = React.useState([]);
    const [name, setName] = React.useState(server?.name || '');

    const [newChannel, setNewChannel] = React.useState({ name: '', type: 'text' });
    const [editingRole, setEditingRole] = React.useState(null);

    const reload = React.useCallback(() => {
        ask('server:members', { serverId: server.id })
            .then((r) => setMembers(r.members || [])).catch(() => {});
        ask('server:roles', { serverId: server.id })
            .then((r) => setRoles(r.roles || [])).catch(() => {});
        if (perms.canBan) {
            ask('server:bans', { serverId: server.id })
                .then((r) => setBanned(r.banned || [])).catch(() => {});
        }
    }, [server.id, perms.canBan]);

    React.useEffect(() => { reload(); }, [reload]);

    const run = (fn) => fn().then(() => { setError(''); reload(); onChanged?.(); })
        .catch((e) => setError(e.message));

    return (
        <Modal title={`Сервер «${server?.name}»`} onClose={onClose}
            actions={<button className="btn btn-ghost" onClick={onClose}>Закрыть</button>}>

            <div className="tabs" style={{ borderBottom: '1px solid var(--line)', marginBottom: 14 }}>
                <button className={`tab ${tab === 'channels' ? 'active' : ''}`} onClick={() => setTab('channels')}>Каналы</button>
                <button className={`tab ${tab === 'members' ? 'active' : ''}`} onClick={() => setTab('members')}>Участники</button>
                {perms.canManage && (
                    <button className={`tab ${tab === 'roles' ? 'active' : ''}`} onClick={() => setTab('roles')}>Роли</button>
                )}
                <button className={`tab ${tab === 'general' ? 'active' : ''}`} onClick={() => setTab('general')}>Общее</button>
            </div>

            {error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}

            {/* ── Каналы ─────────────────────────────────────────────── */}
            {tab === 'channels' && (
                <>
                    {channels.map((c) => (
                        <div className="list-item" key={c.id}>
                            <span className="channel-hash">{c.type === 'voice' ? '🔊' : '#'}</span>
                            <div className="list-item-body">
                                <div className="list-item-name">{c.name}</div>
                                {c.type === 'voice' && (
                                    <div className="list-item-sub">
                                        {c.userLimit > 0 ? `лимит ${c.userLimit}` : 'без ограничения'}
                                    </div>
                                )}
                            </div>
                            {perms.canChannels && (
                                <>
                                    <button className="icon-btn" title="Переименовать" onClick={() => {
                                        const next = prompt('Новое название канала', c.name);
                                        if (next?.trim()) run(() => ask('channel:rename', { channelId: c.id, name: next.trim() }));
                                    }}>✎</button>
                                    {c.type === 'voice' && (
                                        <button className="icon-btn" title="Вместимость" onClick={() => {
                                            const next = prompt('Сколько человек пускать (0 — без ограничения)', String(c.userLimit || 0));
                                            if (next !== null) run(() => ask('channel:limit', { channelId: c.id, limit: parseInt(next, 10) || 0 }));
                                        }}>👥</button>
                                    )}
                                    <button className="icon-btn" title="Удалить" onClick={() => {
                                        if (confirm(`Удалить канал «${c.name}» вместе с перепиской?`)) {
                                            run(() => ask('channel:delete', { channelId: c.id }));
                                        }
                                    }}>🗑</button>
                                </>
                            )}
                        </div>
                    ))}

                    {perms.canChannels && (
                        <div style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
                            <Field label="Новый канал" placeholder="название"
                                value={newChannel.name}
                                onChange={(e) => setNewChannel({ ...newChannel, name: e.target.value })} />
                            <div className="row">
                                <select
                                    value={newChannel.type}
                                    onChange={(e) => setNewChannel({ ...newChannel, type: e.target.value })}
                                >
                                    <option value="text">Текстовый</option>
                                    <option value="voice">Голосовой</option>
                                </select>
                                <button className="btn" disabled={!newChannel.name.trim()} onClick={() => {
                                    run(() => ask('channel:create', {
                                        serverId: server.id,
                                        name: newChannel.name.trim(),
                                        type: newChannel.type,
                                    })).then(() => setNewChannel({ name: '', type: 'text' }));
                                }}>Создать</button>
                            </div>
                        </div>
                    )}
                </>
            )}

            {/* ── Участники ──────────────────────────────────────────── */}
            {tab === 'members' && (
                <>
                    {members.map((m) => (
                        <div className="list-item" key={m.userId}>
                            <Avatar userId={m.userId} name={m.name} hideDot size="avatar-sm" />
                            <div className="list-item-body">
                                <div className="list-item-name">{m.name}</div>
                                <div className="list-item-sub">
                                    @{m.login}{m.isOwner ? ' · владелец' : (m.roleName ? ` · ${m.roleName}` : '')}
                                </div>
                            </div>

                            {perms.canManage && !m.isOwner && (
                                <select
                                    value={m.roleId || ''}
                                    style={{ width: 'auto' }}
                                    onChange={(e) => run(() => ask('role:assign', {
                                        serverId: server.id,
                                        userId: m.userId,
                                        roleId: e.target.value ? parseInt(e.target.value, 10) : null,
                                    }))}
                                >
                                    <option value="">без роли</option>
                                    {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                                </select>
                            )}

                            {!m.isOwner && perms.canKick && (
                                <button className="icon-btn" title="Исключить" onClick={() => {
                                    if (confirm(`Исключить ${m.name}?`)) {
                                        run(() => ask('member:kick', { serverId: server.id, userId: m.userId, ban: false }));
                                    }
                                }}>🚪</button>
                            )}
                            {!m.isOwner && perms.canBan && (
                                <button className="icon-btn" title="Забанить" onClick={() => {
                                    if (confirm(`Забанить ${m.name}? Он не сможет вернуться.`)) {
                                        run(() => ask('member:kick', { serverId: server.id, userId: m.userId, ban: true }));
                                    }
                                }}>⛔</button>
                            )}
                        </div>
                    ))}

                    {perms.canBan && banned.length > 0 && (
                        <>
                            <div className="section-title">Забаненные — {banned.length}</div>
                            {banned.map((b) => (
                                <div className="list-item" key={b.userId}>
                                    <div className="list-item-body">
                                        <div className="list-item-name">{b.name}</div>
                                        <div className="list-item-sub">@{b.login}</div>
                                    </div>
                                    <button className="btn btn-sm btn-ghost" onClick={() => run(
                                        () => ask('member:unban', { serverId: server.id, userId: b.userId }),
                                    )}>Разбанить</button>
                                </div>
                            ))}
                        </>
                    )}
                </>
            )}

            {/* ── Роли ───────────────────────────────────────────────── */}
            {tab === 'roles' && perms.canManage && (
                <>
                    {roles.map((r) => (
                        <div className="list-item" key={r.id}>
                            <span style={{ color: r.colorHex, fontSize: 18 }}>●</span>
                            <div className="list-item-body">
                                <div className="list-item-name">{r.name}</div>
                                <div className="list-item-sub">
                                    {[r.canManage && 'управление', r.canChannels && 'каналы',
                                        r.canBan && 'баны', r.canKick && 'кики', r.canMute && 'мьюты']
                                        .filter(Boolean).join(', ') || 'без прав'}
                                </div>
                            </div>
                            <button className="icon-btn" onClick={() => setEditingRole({ ...r })}>✎</button>
                            <button className="icon-btn" onClick={() => {
                                if (confirm(`Удалить роль «${r.name}»?`)) {
                                    run(() => ask('role:delete', { serverId: server.id, roleId: r.id }));
                                }
                            }}>🗑</button>
                        </div>
                    ))}

                    <button className="btn btn-ghost" style={{ marginTop: 12 }} onClick={() => setEditingRole({
                        name: 'Новая роль', colorHex: '#5865F2',
                        canBan: false, canKick: false, canMute: false,
                        canManage: false, canChannels: false, position: 0,
                    })}>Добавить роль</button>

                    {editingRole && (
                        <div style={{ marginTop: 16, borderTop: '1px solid var(--line)', paddingTop: 14 }}>
                            <Field label="Название" value={editingRole.name}
                                onChange={(e) => setEditingRole({ ...editingRole, name: e.target.value })} />
                            <div className="field">
                                <label>Цвет</label>
                                <input type="color" value={editingRole.colorHex}
                                    onChange={(e) => setEditingRole({ ...editingRole, colorHex: e.target.value })} />
                            </div>
                            <Check label="Управление сервером" checked={editingRole.canManage}
                                onChange={(v) => setEditingRole({ ...editingRole, canManage: v })} />
                            <Check label="Управление каналами" checked={editingRole.canChannels}
                                onChange={(v) => setEditingRole({ ...editingRole, canChannels: v })} />
                            <Check label="Баны" checked={editingRole.canBan}
                                onChange={(v) => setEditingRole({ ...editingRole, canBan: v })} />
                            <Check label="Исключение" checked={editingRole.canKick}
                                onChange={(v) => setEditingRole({ ...editingRole, canKick: v })} />
                            <Check label="Мьюты" checked={editingRole.canMute}
                                onChange={(v) => setEditingRole({ ...editingRole, canMute: v })} />
                            <div className="row" style={{ marginTop: 10 }}>
                                <button className="btn" onClick={() => {
                                    const event = editingRole.id ? 'role:update' : 'role:create';
                                    run(() => ask(event, { serverId: server.id, role: editingRole }))
                                        .then(() => setEditingRole(null));
                                }}>Сохранить</button>
                                <button className="btn btn-ghost" onClick={() => setEditingRole(null)}>Отмена</button>
                            </div>
                        </div>
                    )}
                </>
            )}

            {/* ── Общее ──────────────────────────────────────────────── */}
            {tab === 'general' && (
                <>
                    <div className="faint" style={{ fontSize: 12, marginBottom: 12 }}>
                        Номер сервера: <b>{server.id}</b> — по нему к вам присоединяются
                        с сайта, с ПК и с телефона.
                    </div>

                    <Check
                        label="Не уведомлять о сообщениях этого сервера"
                        checked={perms.mutedNotifications}
                        onChange={(v) => run(() => ask('server:mute', { serverId: server.id, muted: v }))}
                    />

                    {(perms.isOwner || perms.canManage) && (
                        <>
                            <Field label="Название сервера" value={name}
                                onChange={(e) => setName(e.target.value)} />
                            <button className="btn" onClick={() => run(
                                () => ask('server:rename', { serverId: server.id, name }),
                            )}>Переименовать</button>
                        </>
                    )}

                    <div style={{ height: 1, background: 'var(--line)', margin: '20px 0' }} />

                    {perms.isOwner ? (
                        <button className="btn btn-danger" onClick={() => {
                            if (confirm('Удалить сервер со всеми каналами и перепиской? Отменить нельзя.')) {
                                run(() => ask('server:delete', { serverId: server.id })).then(onClose);
                            }
                        }}>Удалить сервер</button>
                    ) : (
                        <button className="btn btn-danger" onClick={() => {
                            if (confirm('Покинуть сервер?')) {
                                run(() => ask('server:leave', { serverId: server.id })).then(onClose);
                            }
                        }}>Покинуть сервер</button>
                    )}
                </>
            )}
        </Modal>
    );
}

import React from 'react';
import { Avatar, Modal, Field, Check, Empty } from './Common';
import { ask } from '../lib/socket';
import { changePassword } from '../lib/api';
import { presenceText } from '../lib/format';

/** Друзья: список, заявки и поиск людей. */
export function FriendsPanel({ onOpenChat, onReload }) {
    const [tab, setTab] = React.useState('friends');
    const [data, setData] = React.useState({ friends: [], incoming: [], outgoing: [], presence: {} });
    const [query, setQuery] = React.useState('');
    const [found, setFound] = React.useState([]);
    const [error, setError] = React.useState('');

    const load = React.useCallback(() => {
        ask('friends:list').then(setData).catch((e) => setError(e.message));
    }, []);

    React.useEffect(() => { load(); }, [load]);

    React.useEffect(() => {
        const q = query.trim();
        if (!q) { setFound([]); return undefined; }
        // Не дёргаем сервер на каждую букву.
        const t = setTimeout(() => {
            ask('users:search', { query: q }).then((r) => setFound(r.users || [])).catch(() => {});
        }, 300);
        return () => clearTimeout(t);
    }, [query]);

    async function act(event, userId) {
        try {
            await ask(event, { userId });
            load();
            onReload?.();
        } catch (e) { setError(e.message); }
    }

    const list = tab === 'friends' ? data.friends
        : tab === 'incoming' ? data.incoming : data.outgoing;

    return (
        <div className="main">
            <div className="main-head">
                <div className="main-head-title">Друзья</div>
            </div>

            <div className="tabs">
                <button className={`tab ${tab === 'friends' ? 'active' : ''}`} onClick={() => setTab('friends')}>
                    Все — {data.friends.length}
                </button>
                <button className={`tab ${tab === 'incoming' ? 'active' : ''}`} onClick={() => setTab('incoming')}>
                    Входящие {data.incoming.length > 0 && <span className="badge">{data.incoming.length}</span>}
                </button>
                <button className={`tab ${tab === 'outgoing' ? 'active' : ''}`} onClick={() => setTab('outgoing')}>
                    Отправленные — {data.outgoing.length}
                </button>
            </div>

            <div style={{ padding: 12 }}>
                <input
                    placeholder="Найти человека по имени или логину…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                />
            </div>

            {error && <div className="conn-banner">{error}</div>}

            <div className="feed">
                {query.trim() && (
                    <>
                        <div className="section-title">Результаты поиска</div>
                        {found.length === 0 && <div className="faint" style={{ padding: 8 }}>Никого не найдено</div>}
                        {found.map((u) => (
                            <div className="list-item" key={`f${u.id}`}>
                                <Avatar userId={u.id} name={u.name} hideDot />
                                <div className="list-item-body">
                                    <div className="list-item-name">{u.name}</div>
                                    <div className="list-item-sub">@{u.login}</div>
                                </div>
                                <button className="btn btn-sm" onClick={() => act('friend:request', u.id)}>
                                    Добавить
                                </button>
                                <button className="btn btn-sm btn-ghost" onClick={() => onOpenChat(u.id, u.name)}>
                                    Написать
                                </button>
                            </div>
                        ))}
                        <div className="section-title">Мои друзья</div>
                    </>
                )}

                {list.length === 0 && <Empty icon="👥" title="Пусто" hint="Найдите людей через поиск выше" />}

                {list.map((f) => (
                    <div className="list-item" key={f.userId}>
                        <Avatar userId={f.userId} name={f.name} presence={data.presence[f.userId]} />
                        <div className="list-item-body">
                            <div className="list-item-name">{f.name}</div>
                            <div className="list-item-sub">
                                {presenceText(data.presence[f.userId]) || `@${f.login}`}
                            </div>
                        </div>

                        {tab === 'friends' && (
                            <>
                                <button className="btn btn-sm" onClick={() => onOpenChat(f.userId, f.name)}>
                                    Написать
                                </button>
                                <button className="btn btn-sm btn-ghost" onClick={() => act('friend:remove', f.userId)}>
                                    Удалить
                                </button>
                            </>
                        )}
                        {tab === 'incoming' && (
                            <>
                                <button className="btn btn-sm" onClick={() => act('friend:accept', f.userId)}>
                                    Принять
                                </button>
                                <button className="btn btn-sm btn-ghost" onClick={() => act('friend:decline', f.userId)}>
                                    Отклонить
                                </button>
                            </>
                        )}
                        {tab === 'outgoing' && (
                            <button className="btn btn-sm btn-ghost" onClick={() => act('friend:remove', f.userId)}>
                                Отменить
                            </button>
                        )}
                    </div>
                ))}
            </div>
        </div>
    );
}

/** Профиль и настройки. */
export function SettingsModal({ me, onClose, onUpdated }) {
    const [tab, setTab] = React.useState('profile');
    const [profile, setProfile] = React.useState(null);
    const [privacy, setPrivacy] = React.useState(0);
    const [pass, setPass] = React.useState({ old: '', next: '', confirm: '' });
    const [msg, setMsg] = React.useState('');
    const [error, setError] = React.useState('');

    React.useEffect(() => {
        ask('profile:get').then((r) => setProfile(r.profile)).catch((e) => setError(e.message));
        ask('privacy:get').then((r) => setPrivacy(r.dmPrivacy)).catch(() => {});
    }, []);

    async function saveProfile() {
        setError(''); setMsg('');
        try {
            const r = await ask('profile:save', profile);
            setProfile(r.profile);
            setMsg('Сохранено');
            onUpdated?.(r.profile);
        } catch (e) { setError(e.message); }
    }

    async function savePassword() {
        setError(''); setMsg('');
        try {
            await changePassword(pass.old, pass.next, pass.confirm);
            setMsg('Пароль обновлён — он подойдёт и в приложении на ПК и Android');
            setPass({ old: '', next: '', confirm: '' });
        } catch (e) { setError(e.message); }
    }

    function pickAvatar(e) {
        const file = e.target.files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            ask('profile:avatar', { data: reader.result })
                .then(() => setMsg('Аватар обновлён'))
                .catch((err) => setError(err.message));
        };
        reader.readAsDataURL(file);
    }

    return (
        <Modal title="Настройки" onClose={onClose}
            actions={<button className="btn btn-ghost" onClick={onClose}>Закрыть</button>}>
            <div className="tabs" style={{ borderBottom: '1px solid var(--line)', marginBottom: 14 }}>
                <button className={`tab ${tab === 'profile' ? 'active' : ''}`} onClick={() => setTab('profile')}>Профиль</button>
                <button className={`tab ${tab === 'privacy' ? 'active' : ''}`} onClick={() => setTab('privacy')}>Приватность</button>
                <button className={`tab ${tab === 'password' ? 'active' : ''}`} onClick={() => setTab('password')}>Пароль</button>
            </div>

            {error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}
            {msg && <div style={{ color: 'var(--online)', fontSize: 13, marginBottom: 10 }}>{msg}</div>}

            {tab === 'profile' && profile && (
                <>
                    <div className="row" style={{ marginBottom: 14 }}>
                        <Avatar userId={me.id} name={profile.displayName} size="avatar-lg" hideDot />
                        <div>
                            <label className="btn btn-ghost btn-sm" style={{ display: 'inline-block' }}>
                                Сменить аватар
                                <input type="file" accept="image/*" onChange={pickAvatar} style={{ display: 'none' }} />
                            </label>
                        </div>
                    </div>
                    <Field label="Имя" value={profile.name}
                        onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
                    <Field label="Фамилия" value={profile.surname}
                        onChange={(e) => setProfile({ ...profile, surname: e.target.value })} />
                    <Field label="Логин" value={profile.login}
                        onChange={(e) => setProfile({ ...profile, login: e.target.value })} />
                    <div className="field">
                        <label>О себе</label>
                        <textarea rows={3} value={profile.about}
                            onChange={(e) => setProfile({ ...profile, about: e.target.value })} />
                    </div>
                    <Field label="Ссылки" value={profile.socialLinks}
                        onChange={(e) => setProfile({ ...profile, socialLinks: e.target.value })} />
                    <button className="btn" onClick={saveProfile}>Сохранить</button>
                </>
            )}

            {tab === 'privacy' && (
                <>
                    <Check
                        label="Принимать личные сообщения только от друзей"
                        checked={privacy === 1}
                        onChange={(v) => {
                            ask('privacy:set', { friendsOnly: v })
                                .then((r) => { setPrivacy(r.dmPrivacy); setMsg('Сохранено'); })
                                .catch((e) => setError(e.message));
                        }}
                    />
                    <div className="faint" style={{ fontSize: 12, marginTop: 8 }}>
                        Настройка общая с приложением: она хранится в той же базе и действует
                        на ПК и Android.
                    </div>
                </>
            )}

            {tab === 'password' && (
                <>
                    <Field label="Текущий пароль" type="password" value={pass.old}
                        onChange={(e) => setPass({ ...pass, old: e.target.value })} />
                    <Field label="Новый пароль" type="password" value={pass.next}
                        onChange={(e) => setPass({ ...pass, next: e.target.value })} />
                    <Field label="Повторите новый" type="password" value={pass.confirm}
                        onChange={(e) => setPass({ ...pass, confirm: e.target.value })} />
                    <button className="btn" onClick={savePassword}>Сменить пароль</button>
                    <div className="faint" style={{ fontSize: 12, marginTop: 10 }}>
                        Пароль хешируется тем же алгоритмом, что в приложении (PBKDF2), — после
                        смены он подойдёт и на ПК, и на Android.
                    </div>
                </>
            )}
        </Modal>
    );
}

/** Создание группы. */
export function NewGroupModal({ onClose, onCreated }) {
    const [name, setName] = React.useState('');
    const [users, setUsers] = React.useState([]);
    const [picked, setPicked] = React.useState([]);
    const [error, setError] = React.useState('');

    React.useEffect(() => {
        ask('users:list').then((r) => setUsers(r.users || [])).catch((e) => setError(e.message));
    }, []);

    async function create() {
        try {
            const r = await ask('group:create', { name: name.trim(), memberIds: picked });
            onCreated(r.groupId, name.trim());
        } catch (e) { setError(e.message); }
    }

    return (
        <Modal
            title="Новая группа"
            onClose={onClose}
            actions={(
                <>
                    <button className="btn btn-ghost" onClick={onClose}>Отмена</button>
                    <button className="btn" disabled={!name.trim()} onClick={create}>Создать</button>
                </>
            )}
        >
            {error && <div className="error-text">{error}</div>}
            <Field label="Название" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            <div className="field">
                <label>Участники — выбрано {picked.length}</label>
                <div style={{ maxHeight: 250, overflowY: 'auto' }}>
                    {users.map((u) => (
                        <label className="check" key={u.id}>
                            <input
                                type="checkbox"
                                checked={picked.includes(u.id)}
                                onChange={(e) => setPicked(
                                    e.target.checked
                                        ? [...picked, u.id]
                                        : picked.filter((id) => id !== u.id),
                                )}
                            />
                            <span>{u.name} <span className="faint">@{u.login}</span></span>
                        </label>
                    ))}
                </div>
            </div>
        </Modal>
    );
}

/** Создание сервера или вход по номеру — как на ПК. */
export function NewServerModal({ onClose, onDone }) {
    const [name, setName] = React.useState('');
    const [joinId, setJoinId] = React.useState('');
    const [error, setError] = React.useState('');

    async function create() {
        try {
            const r = await ask('server:create', { name: name.trim() });
            onDone(r.serverId);
        } catch (e) { setError(e.message); }
    }

    async function join() {
        try {
            await ask('server:join', { serverId: parseInt(joinId, 10) });
            onDone(parseInt(joinId, 10));
        } catch (e) { setError(e.message); }
    }

    return (
        <Modal title="Серверы" onClose={onClose}
            actions={<button className="btn btn-ghost" onClick={onClose}>Закрыть</button>}>
            {error && <div className="error-text" style={{ marginBottom: 10 }}>{error}</div>}

            <Field label="Создать новый сервер" placeholder="Название"
                value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn" disabled={!name.trim()} onClick={create}>Создать</button>

            <div style={{ height: 1, background: 'var(--line)', margin: '20px 0' }} />

            <Field label="Присоединиться по номеру" placeholder="Например, 4"
                value={joinId} onChange={(e) => setJoinId(e.target.value)} />
            <button className="btn btn-ghost" disabled={!joinId.trim()} onClick={join}>Войти</button>
        </Modal>
    );
}

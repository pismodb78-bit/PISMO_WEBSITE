/**
 * Друзья, профили, присутствие и настройки — через сокет.
 */
const social = require('../data/social');
const presence = require('../data/presence');
const db = require('../db');

function reply(cb, promise, label) {
    if (typeof cb !== 'function') return promise.catch(() => {});
    return promise
        .then((data) => cb({ ok: true, ...(data || {}) }))
        .catch((err) => {
            console.error(`[сокет:${label}]`, err.message);
            cb({ ok: false, error: err.message || 'Ошибка' });
        });
}

function toBuffer(value) {
    if (!value) return null;
    if (Buffer.isBuffer(value)) return value;
    if (typeof value === 'string') {
        const comma = value.indexOf(',');
        const body = value.startsWith('data:') && comma > 0 ? value.slice(comma + 1) : value;
        return Buffer.from(body, 'base64');
    }
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    return null;
}

/**
 * Ограничение на заявки в друзья — порт из FriendsRepository: не чаще
 * двадцати в минуту. Рассылать заявки вручную это не мешает, а
 * автоматическому спаму мешает.
 */
const friendRequests = new Map();
function allowFriendRequest(userId) {
    const now = Date.now();
    const list = (friendRequests.get(userId) || []).filter((t) => now - t < 60000);
    if (list.length >= 20) { friendRequests.set(userId, list); return false; }
    list.push(now);
    friendRequests.set(userId, list);
    return true;
}

module.exports = function registerSocial(io, socket) {
    const me = socket.userId;

    // ── Друзья ────────────────────────────────────────────────────────

    socket.on('friends:list', (_p, cb) => reply(cb, (async () => {
        const [list, incoming, outgoing] = await Promise.all([
            social.friends(me),
            social.incomingRequests(me),
            social.outgoingRequests(me),
        ]);
        return {
            friends: list,
            incoming,
            outgoing,
            presence: await presence.presenceFor(list.map((f) => f.userId)),
        };
    })(), 'friends:list'));

    socket.on('friend:request', ({ userId } = {}, cb) => reply(cb, (async () => {
        if (userId === me) throw new Error('Нельзя добавить себя');
        if (!allowFriendRequest(me)) throw new Error('Слишком много заявок. Подождите минуту.');
        await social.sendRequest(me, userId);
        io.to(`user_${userId}`).emit('friends:changed', { from: me });
        return {};
    })(), 'friend:request'));

    socket.on('friend:accept', ({ userId } = {}, cb) => reply(cb, (async () => {
        await social.acceptRequest(me, userId);
        io.to(`user_${userId}`).to(`user_${me}`).emit('friends:changed', { from: me });
        return {};
    })(), 'friend:accept'));

    socket.on('friend:decline', ({ userId } = {}, cb) => reply(cb, (async () => {
        await social.declineRequest(me, userId);
        io.to(`user_${userId}`).emit('friends:changed', { from: me });
        return {};
    })(), 'friend:decline'));

    socket.on('friend:remove', ({ userId } = {}, cb) => reply(cb, (async () => {
        await social.removeFriend(me, userId);
        io.to(`user_${userId}`).to(`user_${me}`).emit('friends:changed', { from: me });
        return {};
    })(), 'friend:remove'));

    socket.on('friend:relation', ({ userId } = {}, cb) => reply(cb, (async () => ({
        relation: await social.relation(me, userId),
    }))(), 'friend:relation'));

    // ── Профили ───────────────────────────────────────────────────────

    socket.on('profile:get', ({ userId } = {}, cb) => reply(cb, (async () => {
        const id = userId || me;
        const p = await social.profile(id);
        if (!p) throw new Error('Пользователь не найден');
        return {
            profile: p,
            relation: id === me ? 'self' : await social.relation(me, id),
            presence: (await presence.presenceFor([id]))[id] || null,
        };
    })(), 'profile:get'));

    socket.on('profile:save', (payload = {}, cb) => reply(cb, (async () => {
        const { name = '', surname = '', login = '', about = '', socialLinks = '' } = payload;
        const trimmed = String(login).trim();
        if (!trimmed) throw new Error('Логин не может быть пустым');
        if (await social.loginTaken(trimmed, me)) throw new Error('Этот логин уже занят');
        await social.saveProfile(me, {
            name: String(name).trim(),
            surname: String(surname).trim(),
            login: trimmed,
            about,
            socialLinks,
        });
        return { profile: await social.profile(me) };
    })(), 'profile:save'));

    socket.on('profile:avatar', ({ data } = {}, cb) => reply(cb, (async () => {
        const bytes = toBuffer(data);
        // Аватар лежит в самой строке users и читается в списках — крупная
        // картинка здесь дорого обходится каждому запросу.
        if (bytes && bytes.length > 4 * 1024 * 1024) throw new Error('Аватар слишком большой');
        await social.setAvatar(me, bytes);
        io.emit('avatar:changed', { userId: me });
        return {};
    })(), 'profile:avatar'));

    socket.on('profile:banner', ({ data } = {}, cb) => reply(cb, (async () => {
        const bytes = toBuffer(data);
        if (bytes && bytes.length > 8 * 1024 * 1024) throw new Error('Баннер слишком большой');
        await social.setBanner(me, bytes);
        return {};
    })(), 'profile:banner'));

    // ── Приватность ───────────────────────────────────────────────────

    socket.on('privacy:get', (_p, cb) => reply(cb, (async () => ({
        dmPrivacy: await social.dmPrivacy(me),
    }))(), 'privacy:get'));

    socket.on('privacy:set', ({ friendsOnly } = {}, cb) => reply(cb, (async () => {
        await social.setDmPrivacy(me, friendsOnly);
        return { dmPrivacy: friendsOnly ? 1 : 0 };
    })(), 'privacy:set'));

    // ── Присутствие ───────────────────────────────────────────────────

    /**
     * Heartbeat из браузера. active = вкладка на виду и с ней работают;
     * если вкладка в фоне, шлём active=false, и статус честно уезжает в
     * «бездействует» — так же, как это делает ПК при неактивном окне.
     */
    socket.on('presence:beat', ({ active } = {}) => {
        presence.heartbeat(me, Boolean(active)).catch(() => {});
    });

    socket.on('presence:for', ({ userIds } = {}, cb) => reply(cb, (async () => ({
        presence: await presence.presenceFor(userIds || []),
    }))(), 'presence:for'));

    // ── Поиск людей ───────────────────────────────────────────────────

    socket.on('users:search', ({ query } = {}, cb) => reply(cb, (async () => {
        const q = String(query || '').trim();
        if (!q) return { users: [] };
        const like = `%${q}%`;
        const rows = await db.query(
            'SELECT id, Name, Surname, login FROM users '
            + 'WHERE id <> ? AND (login LIKE ? OR Name LIKE ? OR Surname LIKE ?) '
            + 'ORDER BY login LIMIT 30',
            [me, like, like, like],
        );
        return {
            users: rows.map((r) => ({
                id: r.id,
                name: `${r.Name || ''} ${r.Surname || ''}`.trim() || r.login,
                login: r.login || '',
            })),
        };
    })(), 'users:search'));
};

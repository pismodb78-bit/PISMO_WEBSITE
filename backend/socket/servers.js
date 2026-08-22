/**
 * Серверы и каналы через сокет — то, ради чего сайт и переписывался:
 * прежняя версия про серверы не знала вовсе, хотя на ПК и Android это
 * основной способ общения.
 *
 * ПРАВА ПРОВЕРЯЮТСЯ ЗДЕСЬ. На клиенте кнопка может быть спрятана, но
 * событие сокета отправляется руками из консоли за десять секунд —
 * поэтому каждое действие сверяется с ServerPermissions заново.
 */
const servers = require('../data/servers');
const presence = require('../data/presence');
const pins = require('../data/pins');
const reactions = require('../data/reactions');
const livekit = require('../utils/livekit');
const { SCOPE } = require('../data/scopes');

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
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (typeof value === 'string') {
        const comma = value.indexOf(',');
        const body = value.startsWith('data:') && comma > 0 ? value.slice(comma + 1) : value;
        return Buffer.from(body, 'base64');
    }
    return null;
}

module.exports = function registerServers(io, socket) {
    const me = socket.userId;

    /** Права на сервере канала — почти каждое действие начинается с них. */
    async function permsForChannel(channelId) {
        const serverId = await servers.serverOfChannel(channelId);
        if (!serverId) throw new Error('Канал не найден');
        const perms = await servers.permissions(me, serverId);
        if (!perms.isMember && !perms.isOwner) throw new Error('Вы не участник этого сервера');
        return { serverId, perms };
    }

    // ── Список серверов и бейджи ──────────────────────────────────────

    socket.on('servers:list', (_p, cb) => reply(cb, (async () => {
        const list = await servers.myServers(me);
        const badges = await servers.badges(me);

        // Бейджи приходят по каналам — сворачиваем их до серверов, пропуская
        // заглушённые: на них значок гореть не должен.
        const byServer = new Map();
        for (const b of badges) {
            if (b.muted) continue;
            const acc = byServer.get(b.serverId) || { unread: 0, mentions: 0 };
            acc.unread += b.unread;
            acc.mentions += b.mentions;
            byServer.set(b.serverId, acc);
        }
        for (const s of list) {
            const acc = byServer.get(s.id);
            if (acc) { s.unread = acc.unread; s.mentions = acc.mentions; }
        }
        return { servers: list, badges };
    })(), 'servers:list'));

    socket.on('server:create', ({ name } = {}, cb) => reply(cb, (async () => {
        const title = String(name || '').trim();
        if (!title) throw new Error('Укажите название сервера');
        const id = await servers.createServer(me, title);
        if (!id) throw new Error('Сервер не создался');
        return { serverId: id };
    })(), 'server:create'));

    socket.on('server:join', ({ serverId } = {}, cb) => reply(cb, (async () => {
        const res = await servers.joinServer(me, serverId);
        if (res.status === 'banned') throw new Error('Вы забанены на этом сервере');
        if (res.status === 'not_found') throw new Error('Сервер не найден');
        return { name: res.name };
    })(), 'server:join'));

    socket.on('server:leave', ({ serverId } = {}, cb) => reply(cb, (async () => {
        const perms = await servers.permissions(me, serverId);
        if (perms.isOwner) throw new Error('Владелец не может покинуть сервер — удалите его');
        await servers.leaveServer(me, serverId);
        return {};
    })(), 'server:leave'));

    socket.on('server:info', ({ serverId } = {}, cb) => reply(cb, (async () => {
        const [info, perms, chans, voice] = await Promise.all([
            servers.serverInfo(serverId),
            servers.permissions(me, serverId),
            servers.channels(serverId),
            presence.voiceForServer(serverId),
        ]);
        if (!info) throw new Error('Сервер не найден');
        if (!perms.isMember && !perms.isOwner) throw new Error('Вы не участник этого сервера');

        // Непрочитанные раскладываем по каналам — на рельсе видно, где именно.
        const badges = await servers.badges(me);
        for (const ch of chans) {
            const b = badges.find((x) => x.channelId === ch.id);
            if (b) { ch.unread = b.unread; ch.mentions = b.mentions; }
        }
        return { info, perms, channels: chans, voice };
    })(), 'server:info'));

    socket.on('server:rename', ({ serverId, name } = {}, cb) => reply(cb, (async () => {
        const perms = await servers.permissions(me, serverId);
        if (!perms.isOwner && !perms.canManage) throw new Error('Нет права управлять сервером');
        await servers.renameServer(serverId, name);
        io.to(`server_${serverId}`).emit('server:updated', { serverId });
        return {};
    })(), 'server:rename'));

    socket.on('server:delete', ({ serverId } = {}, cb) => reply(cb, (async () => {
        const perms = await servers.permissions(me, serverId);
        if (!perms.isOwner) throw new Error('Удалить сервер может только владелец');
        await servers.deleteServer(serverId);
        io.to(`server_${serverId}`).emit('server:deleted', { serverId });
        return {};
    })(), 'server:delete'));

    socket.on('server:mute', ({ serverId, muted } = {}, cb) => reply(cb, (async () => {
        await servers.setMutedNotifications(me, serverId, muted);
        return { muted: Boolean(muted) };
    })(), 'server:mute'));

    // ── Каналы ────────────────────────────────────────────────────────

    socket.on('channel:create', ({ serverId, name, type } = {}, cb) => reply(cb, (async () => {
        const perms = await servers.permissions(me, serverId);
        if (!perms.canChannels) throw new Error('Нет права управлять каналами');
        const title = String(name || '').trim();
        if (!title) throw new Error('Укажите название канала');
        const id = await servers.createChannel(serverId, title, type);
        io.to(`server_${serverId}`).emit('channels:changed', { serverId });
        return { channelId: id };
    })(), 'channel:create'));

    socket.on('channel:rename', ({ channelId, name } = {}, cb) => reply(cb, (async () => {
        const { serverId, perms } = await permsForChannel(channelId);
        if (!perms.canChannels) throw new Error('Нет права управлять каналами');
        await servers.renameChannel(channelId, String(name || '').trim());
        io.to(`server_${serverId}`).emit('channels:changed', { serverId });
        return {};
    })(), 'channel:rename'));

    socket.on('channel:delete', ({ channelId } = {}, cb) => reply(cb, (async () => {
        const { serverId, perms } = await permsForChannel(channelId);
        if (!perms.canChannels) throw new Error('Нет права управлять каналами');
        await servers.deleteChannel(channelId);
        io.to(`server_${serverId}`).emit('channels:changed', { serverId });
        return {};
    })(), 'channel:delete'));

    socket.on('channel:limit', ({ channelId, limit } = {}, cb) => reply(cb, (async () => {
        const { serverId, perms } = await permsForChannel(channelId);
        if (!perms.canChannels) throw new Error('Нет права управлять каналами');
        await servers.setChannelUserLimit(channelId, Math.max(0, parseInt(limit, 10) || 0));
        io.to(`server_${serverId}`).emit('channels:changed', { serverId });
        return {};
    })(), 'channel:limit'));

    // ── Сообщения канала ──────────────────────────────────────────────

    socket.on('channel:history', ({ channelId, beforeId = 0, limit } = {}, cb) => reply(cb, (async () => {
        if (!(await servers.canAccessChannel(me, channelId))) throw new Error('Нет доступа к каналу');
        const list = await servers.channelMessages(channelId, limit, beforeId);

        if (list.length) {
            const ids = list.map((m) => m.id);
            const [byMessage, pinned] = await Promise.all([
                reactions.forMessages(me, ids, SCOPE.SERVER),
                pins.pinnedIds(SCOPE.SERVER),
            ]);
            for (const m of list) {
                m.reactions = byMessage.get(m.id) || [];
                m.isPinned = pinned.has(m.id);
            }
        }
        return { messages: list, pinned: await pins.listChannel(channelId) };
    })(), 'channel:history'));

    socket.on('channel:send', (payload = {}, cb) => reply(cb, (async () => {
        const { channelId, text = '', replyToId = 0, fileName = null } = payload;
        if (!(await servers.canAccessChannel(me, channelId))) throw new Error('Нет доступа к каналу');

        const image = toBuffer(payload.image);
        const audio = toBuffer(payload.audio);
        const video = toBuffer(payload.video);
        const file = toBuffer(payload.file);

        const id = await servers.sendChannelMessage({
            me, channelId, text, replyToId, image, audio, video, file, fileName,
        });
        if (!id) throw new Error('Сообщение не сохранилось');

        const saved = {
            id, senderId: me, senderName: socket.userName, text,
            createdAtMs: Date.now(), replyToId: replyToId || 0,
            isDeleted: false, isEdited: false,
            hasImage: Boolean(image), hasAudio: Boolean(audio),
            hasVideo: Boolean(video), hasFile: Boolean(file),
            fileName, scope: SCOPE.SERVER, isRead: true, reactions: [], isPinned: false,
        };

        io.to(`channel_${channelId}`).emit('message:new', {
            scope: SCOPE.SERVER, peerId: channelId, message: saved,
        });
        // Тем, кто сейчас в другом канале сервера, — обновление бейджей.
        const serverId = await servers.serverOfChannel(channelId);
        io.to(`server_${serverId}`).emit('badges:changed', { serverId, channelId });
        return { message: saved };
    })(), 'channel:send'));

    socket.on('channel:edit', ({ channelId, messageId, text } = {}, cb) => reply(cb, (async () => {
        const author = await servers.channelMessageAuthor(messageId);
        if (author !== me) throw new Error('Править можно только свои сообщения');
        await servers.editChannelMessage(messageId, text ?? '');
        io.to(`channel_${channelId}`).emit('message:edited', {
            scope: SCOPE.SERVER, peerId: channelId, messageId, text,
        });
        return {};
    })(), 'channel:edit'));

    socket.on('channel:delete_message', ({ channelId, messageId } = {}, cb) => reply(cb, (async () => {
        const { perms } = await permsForChannel(channelId);
        const author = await servers.channelMessageAuthor(messageId);
        // Своё удаляет автор, чужое — модератор (порт правила с ПК).
        const asModerator = perms.isOwner || perms.canManage;
        if (author !== me && !asModerator) throw new Error('Недостаточно прав');

        await servers.deleteChannelMessage(me, messageId, author !== me && asModerator);
        io.to(`channel_${channelId}`).emit('message:deleted', {
            scope: SCOPE.SERVER, peerId: channelId, messageId,
        });
        return {};
    })(), 'channel:delete_message'));

    socket.on('channel:read', ({ channelId } = {}, cb) => reply(cb, (async () => {
        await servers.markChannelRead(me, channelId);
        return {};
    })(), 'channel:read'));

    socket.on('server:read', ({ serverId } = {}, cb) => reply(cb, (async () => {
        await servers.markServerRead(me, serverId);
        return {};
    })(), 'server:read'));

    socket.on('channel:search', ({ channelId, query } = {}, cb) => reply(cb, (async () => {
        if (!(await servers.canAccessChannel(me, channelId))) throw new Error('Нет доступа к каналу');
        return { messages: await servers.searchInChannel(channelId, query) };
    })(), 'channel:search'));

    // ── Участники, роли, баны ─────────────────────────────────────────

    socket.on('server:members', ({ serverId } = {}, cb) => reply(cb, (async () => {
        if (!(await servers.isMember(me, serverId))) throw new Error('Вы не участник этого сервера');
        const list = await servers.members(serverId);
        return {
            members: list,
            presence: await presence.presenceFor(list.map((m) => m.userId)),
        };
    })(), 'server:members'));

    socket.on('server:roles', ({ serverId } = {}, cb) => reply(cb, (async () => {
        if (!(await servers.isMember(me, serverId))) throw new Error('Вы не участник этого сервера');
        return { roles: await servers.roles(serverId) };
    })(), 'server:roles'));

    socket.on('role:create', ({ serverId, role } = {}, cb) => reply(cb, (async () => {
        const perms = await servers.permissions(me, serverId);
        if (!perms.canManage) throw new Error('Нет права управлять сервером');
        const id = await servers.createRole(serverId, role || {});
        io.to(`server_${serverId}`).emit('roles:changed', { serverId });
        return { roleId: id };
    })(), 'role:create'));

    socket.on('role:update', ({ serverId, role } = {}, cb) => reply(cb, (async () => {
        const perms = await servers.permissions(me, serverId);
        if (!perms.canManage) throw new Error('Нет права управлять сервером');
        await servers.updateRole(role);
        io.to(`server_${serverId}`).emit('roles:changed', { serverId });
        return {};
    })(), 'role:update'));

    socket.on('role:delete', ({ serverId, roleId } = {}, cb) => reply(cb, (async () => {
        const perms = await servers.permissions(me, serverId);
        if (!perms.canManage) throw new Error('Нет права управлять сервером');
        await servers.deleteRole(roleId);
        io.to(`server_${serverId}`).emit('roles:changed', { serverId });
        return {};
    })(), 'role:delete'));

    socket.on('role:assign', ({ serverId, userId, roleId } = {}, cb) => reply(cb, (async () => {
        const perms = await servers.permissions(me, serverId);
        if (!perms.canManage) throw new Error('Нет права управлять сервером');
        await servers.assignRole(serverId, userId, roleId);
        io.to(`server_${serverId}`).emit('members:changed', { serverId });
        return {};
    })(), 'role:assign'));

    socket.on('member:kick', ({ serverId, userId, ban } = {}, cb) => reply(cb, (async () => {
        const perms = await servers.permissions(me, serverId);
        if (ban ? !perms.canBan : !perms.canKick) throw new Error('Недостаточно прав');

        const info = await servers.serverInfo(serverId);
        if (info && info.ownerId === userId) throw new Error('Владельца нельзя исключить');

        await servers.kickMember(serverId, userId, Boolean(ban));
        io.to(`server_${serverId}`).emit('members:changed', { serverId });
        io.to(`user_${userId}`).emit('server:kicked', { serverId, banned: Boolean(ban) });
        return {};
    })(), 'member:kick'));

    socket.on('member:unban', ({ serverId, userId } = {}, cb) => reply(cb, (async () => {
        const perms = await servers.permissions(me, serverId);
        if (!perms.canBan) throw new Error('Недостаточно прав');
        await servers.unban(serverId, userId);
        return {};
    })(), 'member:unban'));

    socket.on('server:bans', ({ serverId } = {}, cb) => reply(cb, (async () => {
        const perms = await servers.permissions(me, serverId);
        if (!perms.canBan) throw new Error('Недостаточно прав');
        return { banned: await servers.bannedUsers(serverId) };
    })(), 'server:bans'));

    // ── Голосовые каналы ──────────────────────────────────────────────

    /**
     * Вход в голосовой канал: проверяем вместимость, отмечаемся в
     * voice_presence и выдаём токен LiveKit на комнату vch_<id>. Комната
     * та же, куда заходят ПК и Android, — оттого и слышно друг друга.
     */
    socket.on('voice:join', ({ channelId } = {}, cb) => reply(cb, (async () => {
        if (!(await servers.canAccessChannel(me, channelId))) throw new Error('Нет доступа к каналу');
        if (!livekit.isConfigured()) throw new Error('Голосовая связь не настроена');

        const serverId = await servers.serverOfChannel(channelId);
        const chans = await servers.channels(serverId);
        const channel = chans.find((c) => c.id === channelId);
        if (!channel) throw new Error('Канал не найден');
        if (channel.type !== 'voice') throw new Error('Это не голосовой канал');

        // Перезаход не должен упираться в лимит — считаем только чужих.
        if (channel.userLimit > 0 && !(await presence.amIInChannel(me, channelId))) {
            const busy = await presence.voiceCount(channelId);
            if (busy >= channel.userLimit) throw new Error('В канале нет свободных мест');
        }

        await presence.voiceHeartbeat(me, channelId, {});
        socket.join(`voice_${channelId}`);

        const room = livekit.roomForVoiceChannel(channelId);
        io.to(`server_${serverId}`).emit('voice:changed', { serverId, channelId });
        return {
            token: livekit.createToken(room, me, socket.userName),
            url: livekit.url,
            room,
            participants: await presence.voiceForChannel(channelId),
        };
    })(), 'voice:join'));

    /**
     * Отметка «я ещё здесь» плюс состояние микрофона и наушников.
     *
     * ЗНАЧЕНИЯ НЕ ИНВЕРТИРОВАТЬ: в voice_presence хранится mic_muted
     * (1 = замьючен), а в атрибутах участника LiveKit — mic (1 = ВКЛЮЧЁН).
     * Клиент шлёт сюда micMuted, атрибут выставляет сам у себя.
     */
    socket.on('voice:state', ({ channelId, streaming, micMuted, deafened } = {}) => {
        presence.voiceHeartbeat(me, channelId, { streaming, micMuted, deafened })
            .then(async () => {
                const serverId = await servers.serverOfChannel(channelId);
                io.to(`server_${serverId}`).emit('voice:changed', { serverId, channelId });
            })
            .catch(() => {});
    });

    socket.on('voice:leave', ({ channelId } = {}, cb) => reply(cb, (async () => {
        await presence.voiceLeave(me, channelId);
        socket.leave(`voice_${channelId}`);
        const serverId = await servers.serverOfChannel(channelId);
        io.to(`server_${serverId}`).emit('voice:changed', { serverId, channelId });
        return {};
    })(), 'voice:leave'));

    socket.on('voice:list', ({ serverId } = {}, cb) => reply(cb, (async () => ({
        voice: await presence.voiceForServer(serverId),
    }))(), 'voice:list'));

    // ── Комнаты сокета ────────────────────────────────────────────────

    socket.on('server:enter', async ({ serverId } = {}, cb) => {
        if (await servers.isMember(me, serverId)) socket.join(`server_${serverId}`);
        if (typeof cb === 'function') cb({ ok: true });
    });

    socket.on('server:exit', ({ serverId } = {}) => socket.leave(`server_${serverId}`));

    socket.on('channel:enter', async ({ channelId } = {}, cb) => {
        if (await servers.canAccessChannel(me, channelId)) socket.join(`channel_${channelId}`);
        if (typeof cb === 'function') cb({ ok: true });
    });

    socket.on('channel:exit', ({ channelId } = {}) => socket.leave(`channel_${channelId}`));
};

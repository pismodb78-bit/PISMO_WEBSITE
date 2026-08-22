/**
 * Личные и групповые чаты через сокет.
 *
 * Все обработчики отвечают через ack-колбэк {ok:true, ...} либо
 * {ok:false, error}. Событие «прилетело новое» рассылается в персональные
 * комнаты `user_<id>`: сокет у человека может быть не один (две вкладки),
 * и адресовать надо всем его устройствам сразу — та же поправка, что
 * делали на Android («слать событие на все устройства, а не только
 * собеседнику»).
 */
const db = require('../db');
const messages = require('../data/messages');
const social = require('../data/social');
const reactions = require('../data/reactions');
const pins = require('../data/pins');
const { SCOPE, normalizeScope } = require('../data/scopes');
const { describeMessage, withSender } = require('../utils/format');
const config = require('../config');

/** Приводит вложение из браузера к Buffer. */
function toBuffer(value) {
    if (!value) return null;
    if (Buffer.isBuffer(value)) return value;
    if (value instanceof ArrayBuffer) return Buffer.from(value);
    if (ArrayBuffer.isView(value)) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
    if (typeof value === 'string') {
        // data:URL или голый base64.
        const comma = value.indexOf(',');
        const body = value.startsWith('data:') && comma > 0 ? value.slice(comma + 1) : value;
        return Buffer.from(body, 'base64');
    }
    return null;
}

/** Обёртка ack: единый формат ответа и один лог на все ошибки. */
function reply(cb, promise, label) {
    if (typeof cb !== 'function') return promise.catch(() => {});
    return promise
        .then((data) => cb({ ok: true, ...(data || {}) }))
        .catch((err) => {
            console.error(`[сокет:${label}]`, err.message);
            cb({ ok: false, error: err.message || 'Ошибка' });
        });
}

/** Догружает реакции и закрепы к странице сообщений — одним запросом на страницу. */
async function decorate(me, list, scope) {
    if (!list.length) return list;
    const ids = list.map((m) => m.id);
    const [byMessage, pinned] = await Promise.all([
        reactions.forMessages(me, ids, scope),
        pins.pinnedIds(scope),
    ]);
    for (const m of list) {
        m.reactions = byMessage.get(m.id) || [];
        m.isPinned = pinned.has(m.id);
    }
    return list;
}

module.exports = function registerChat(io, socket) {
    const me = socket.userId;

    // ── Списки ────────────────────────────────────────────────────────

    socket.on('conversations:list', (_p, cb) => reply(cb, (async () => ({
        conversations: await messages.loadConversations(me),
    }))(), 'conversations:list'));

    socket.on('groups:list', (_p, cb) => reply(cb, (async () => ({
        groups: await messages.loadGroups(me),
    }))(), 'groups:list'));

    socket.on('users:list', (_p, cb) => reply(cb, (async () => ({
        users: await social.allUsers(me),
    }))(), 'users:list'));

    // ── История ───────────────────────────────────────────────────────

    socket.on('chat:history', ({ partnerId, beforeId = 0, limit } = {}, cb) => reply(cb, (async () => {
        const list = await messages.loadDirectMessages(me, partnerId, limit, beforeId);
        await decorate(me, list, SCOPE.DM);
        const [blocks, pinnedList] = await Promise.all([
            messages.blockState(me, partnerId),
            pins.listDirect(me, partnerId),
        ]);
        return { messages: list, blocks, pinned: pinnedList };
    })(), 'chat:history'));

    socket.on('group:history', ({ groupId, beforeId = 0, limit } = {}, cb) => reply(cb, (async () => {
        if (!(await social.isGroupMember(groupId, me))) throw new Error('Вы не участник группы');
        const list = await messages.loadGroupMessages(groupId, limit, beforeId);
        await decorate(me, list, SCOPE.GROUP);
        return { messages: list, pinned: await pins.listGroup(groupId) };
    })(), 'group:history'));

    /** Цитата сообщения, на которое отвечают. */
    socket.on('message:quote', ({ scope, messageId } = {}, cb) => reply(cb, (async () => ({
        quote: await messages.loadReplyQuote(messageId, scope),
    }))(), 'message:quote'));

    // ── Отправка ──────────────────────────────────────────────────────

    socket.on('chat:send', (payload = {}, cb) => reply(cb, (async () => {
        const { receiverId, text = '', replyToId = 0, fileName = null } = payload;
        if (!receiverId) throw new Error('Не указан получатель');

        // Блокировки и приватность проверяем на сервере: настройка, которую
        // соблюдает только интерфейс, не защищает ни от чего.
        const blocks = await messages.blockState(me, receiverId);
        if (blocks.blockedMe) throw new Error('Пользователь ограничил вам отправку сообщений');
        if (blocks.iBlocked) throw new Error('Вы заблокировали этого пользователя');
        if (!(await social.canWriteTo(me, receiverId))) {
            throw new Error('Пользователь принимает сообщения только от друзей');
        }

        const image = toBuffer(payload.image);
        const audio = toBuffer(payload.audio);
        const video = toBuffer(payload.video);
        const file = toBuffer(payload.file);
        if (file && file.length > config.maxUploadBytes) throw new Error('Файл слишком большой');

        const id = await messages.sendMessage({
            me, scope: SCOPE.DM, target: receiverId, text, replyToId,
            image, audio, video, file, fileName,
        });
        if (!id) throw new Error('Сообщение не сохранилось');

        const saved = {
            id,
            senderId: me,
            senderName: socket.userName,
            text,
            createdAtMs: Date.now(),
            replyToId: replyToId || 0,
            isDeleted: false,
            isEdited: false,
            hasImage: Boolean(image),
            hasAudio: Boolean(audio),
            hasVideo: Boolean(video),
            hasFile: Boolean(file),
            fileName,
            scope: SCOPE.DM,
            isRead: false,
            reactions: [],
            isPinned: false,
        };

        // Себе тоже — у человека может быть открыт сайт в двух вкладках
        // и телефон рядом.
        io.to(`user_${receiverId}`).to(`user_${me}`).emit('message:new', {
            scope: SCOPE.DM, peerId: me, message: saved,
        });
        io.to(`user_${receiverId}`).emit('chat:list_update', {
            partnerId: me,
            preview: withSender(socket.userName, describeMessage(saved)),
        });
        return { message: saved };
    })(), 'chat:send'));

    socket.on('group:send', (payload = {}, cb) => reply(cb, (async () => {
        const { groupId, text = '', replyToId = 0, fileName = null } = payload;
        if (!groupId) throw new Error('Не указана группа');
        if (!(await social.isGroupMember(groupId, me))) throw new Error('Вы не участник группы');

        const image = toBuffer(payload.image);
        const audio = toBuffer(payload.audio);
        const video = toBuffer(payload.video);
        const file = toBuffer(payload.file);
        if (file && file.length > config.maxUploadBytes) throw new Error('Файл слишком большой');

        const id = await messages.sendMessage({
            me, scope: SCOPE.GROUP, target: groupId, text, replyToId,
            image, audio, video, file, fileName,
        });
        if (!id) throw new Error('Сообщение не сохранилось');

        const saved = {
            id, senderId: me, senderName: socket.userName, text,
            createdAtMs: Date.now(), replyToId: replyToId || 0,
            isDeleted: false, isEdited: false,
            hasImage: Boolean(image), hasAudio: Boolean(audio),
            hasVideo: Boolean(video), hasFile: Boolean(file),
            fileName, scope: SCOPE.GROUP, isRead: true, reactions: [], isPinned: false,
        };

        io.to(`group_${groupId}`).emit('message:new', {
            scope: SCOPE.GROUP, peerId: groupId, message: saved,
        });
        // Участникам, которые сейчас не в этой группе на экране, — обновление
        // списка, чтобы карточка поднялась наверх с непрочитанным.
        const members = await social.groupMembers(groupId);
        for (const m of members) {
            if (m.userId === me) continue;
            io.to(`user_${m.userId}`).emit('group:list_update', {
                groupId, preview: withSender(socket.userName, describeMessage(saved)),
            });
        }
        return { message: saved };
    })(), 'group:send'));

    // ── Правка, удаление, прочитанное ─────────────────────────────────

    socket.on('message:edit', ({ scope, messageId, text, peerId } = {}, cb) => reply(cb, (async () => {
        const sc = normalizeScope(scope);
        const author = await messages.messageAuthor(sc, messageId);
        if (author !== me) throw new Error('Править можно только свои сообщения');

        await messages.editMessage(sc, messageId, text ?? '');
        const room = sc === SCOPE.GROUP ? `group_${peerId}` : `user_${peerId}`;
        io.to(room).to(`user_${me}`).emit('message:edited', {
            scope: sc, peerId, messageId, text,
        });
        return {};
    })(), 'message:edit'));

    socket.on('message:delete', ({ scope, messageId, peerId } = {}, cb) => reply(cb, (async () => {
        const sc = normalizeScope(scope);
        const author = await messages.messageAuthor(sc, messageId);
        if (author !== me) throw new Error('Удалять можно только свои сообщения');

        await messages.deleteMessage(sc, messageId);
        const room = sc === SCOPE.GROUP ? `group_${peerId}` : `user_${peerId}`;
        io.to(room).to(`user_${me}`).emit('message:deleted', { scope: sc, peerId, messageId });
        return {};
    })(), 'message:delete'));

    socket.on('message:history', ({ scope, messageId } = {}, cb) => reply(cb, (async () => ({
        history: await messages.editHistory(scope, messageId),
    }))(), 'message:history'));

    socket.on('chat:read', ({ partnerId } = {}, cb) => reply(cb, (async () => {
        await messages.markAsRead(me, partnerId);
        // Собеседнику — чтобы галочки прочтения обновились сразу.
        io.to(`user_${partnerId}`).emit('messages:read', { byUserId: me });
        return {};
    })(), 'chat:read'));

    socket.on('chat:unread', (_p, cb) => reply(cb, (async () => ({
        unread: await messages.unreadBySender(me),
    }))(), 'chat:unread'));

    // ── Реакции и закрепы ─────────────────────────────────────────────

    socket.on('reaction:toggle', ({ scope, messageId, emoji, peerId } = {}, cb) => reply(cb, (async () => {
        const sc = normalizeScope(scope);
        const active = await reactions.toggle(me, messageId, sc, emoji);
        const list = (await reactions.forMessages(me, [messageId], sc)).get(messageId) || [];

        let room = `user_${peerId}`;
        if (sc === SCOPE.GROUP) room = `group_${peerId}`;
        if (sc === SCOPE.SERVER) room = `channel_${peerId}`;
        io.to(room).to(`user_${me}`).emit('reaction:updated', {
            scope: sc, peerId, messageId, reactions: list,
        });
        return { active, reactions: list };
    })(), 'reaction:toggle'));

    socket.on('pin:toggle', ({ scope, messageId, peerId } = {}, cb) => reply(cb, (async () => {
        const sc = normalizeScope(scope);
        const pinned = await pins.toggle(me, messageId, sc);
        let room = `user_${peerId}`;
        if (sc === SCOPE.GROUP) room = `group_${peerId}`;
        if (sc === SCOPE.SERVER) room = `channel_${peerId}`;
        io.to(room).to(`user_${me}`).emit('pin:updated', { scope: sc, peerId, messageId, pinned });
        return { pinned };
    })(), 'pin:toggle'));

    // ── Печатает… ─────────────────────────────────────────────────────

    socket.on('typing', ({ scope, peerId, typing } = {}) => {
        const sc = normalizeScope(scope);
        const room = sc === SCOPE.GROUP ? `group_${peerId}` : `user_${peerId}`;
        socket.to(room).emit('typing', {
            scope: sc, peerId: sc === SCOPE.GROUP ? peerId : me,
            userId: me, userName: socket.userName, typing: Boolean(typing),
        });
    });

    // ── Блокировки ────────────────────────────────────────────────────

    socket.on('user:block', ({ userId, blocked } = {}, cb) => reply(cb, (async () => {
        if (blocked) await messages.block(me, userId);
        else await messages.unblock(me, userId);
        return { blocked: Boolean(blocked) };
    })(), 'user:block'));

    // ── Группы ────────────────────────────────────────────────────────

    socket.on('group:create', ({ name, memberIds = [] } = {}, cb) => reply(cb, (async () => {
        const title = String(name || '').trim();
        if (!title) throw new Error('Укажите название группы');
        const groupId = await social.createGroup(me, title, memberIds);
        if (!groupId) throw new Error('Группа не создалась');

        for (const uid of [me, ...memberIds]) {
            io.to(`user_${uid}`).emit('group:created', { id: groupId, name: title });
        }
        return { groupId };
    })(), 'group:create'));

    socket.on('group:members', ({ groupId } = {}, cb) => reply(cb, (async () => ({
        members: await social.groupMembers(groupId),
    }))(), 'group:members'));

    socket.on('group:add', ({ groupId, userIds = [] } = {}, cb) => reply(cb, (async () => {
        if (!(await social.isGroupMember(groupId, me))) throw new Error('Вы не участник группы');
        const added = await social.addGroupMembers(groupId, userIds);
        for (const uid of userIds) io.to(`user_${uid}`).emit('group:created', { id: groupId });
        io.to(`group_${groupId}`).emit('group:members_changed', { groupId });
        return { added };
    })(), 'group:add'));

    socket.on('group:leave', ({ groupId } = {}, cb) => reply(cb, (async () => {
        await social.removeGroupMember(groupId, me);
        socket.leave(`group_${groupId}`);
        io.to(`group_${groupId}`).emit('group:members_changed', { groupId });
        return {};
    })(), 'group:leave'));

    socket.on('group:remove', ({ groupId, userId } = {}, cb) => reply(cb, (async () => {
        // Исключать может создатель группы либо системный администратор.
        const creator = await social.groupCreator(groupId);
        if (creator !== me && socket.userRole !== 'admin') {
            throw new Error('Недостаточно прав');
        }
        await social.removeGroupMember(groupId, userId);
        io.to(`group_${groupId}`).emit('group:members_changed', { groupId });
        io.to(`user_${userId}`).emit('group:removed', { groupId });
        return {};
    })(), 'group:remove'));

    /** Вход в комнату группы — чтобы получать её события. */
    socket.on('group:join_room', async ({ groupId } = {}, cb) => {
        if (await social.isGroupMember(groupId, me)) socket.join(`group_${groupId}`);
        if (typeof cb === 'function') cb({ ok: true });
    });

    socket.on('group:leave_room', ({ groupId } = {}) => {
        socket.leave(`group_${groupId}`);
    });
};

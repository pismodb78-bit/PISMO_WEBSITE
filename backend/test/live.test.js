/**
 * Живая доставка: сообщение, попавшее в базу МИМО САЙТА, должно уйти
 * подключённым людям без перезагрузки страницы.
 *
 * Ради этого опрос и появился: ПК-клиент и Android пишут прямо в MySQL и
 * про сокет сайта не знают, поэтому их сообщения раньше были видны только
 * после F5 — со стороны это выглядело как «вебсокет не работает».
 */
const test = require('node:test');
const assert = require('node:assert');

const db = require('../db');
const live = require('../live');
const { enc } = require('../utils/crypto');

/** Заглушка io: запоминает, что и в какую комнату отправили. */
function fakeIo(onlineUserIds) {
    const sent = [];
    const rooms = new Map();
    for (const id of onlineUserIds) rooms.set(`user_${id}`, new Set(['sock']));
    return {
        sent,
        sockets: { adapter: { rooms } },
        to(room) {
            return {
                emit: (event, payload) => sent.push({ room, event, payload }),
            };
        },
    };
}

function withFakeDb(handlers, fn) {
    const saved = {};
    for (const key of Object.keys(handlers)) {
        saved[key] = db[key];
        db[key] = handlers[key];
    }
    return Promise.resolve(fn()).finally(() => {
        for (const key of Object.keys(saved)) db[key] = saved[key];
    });
}

test('новое личное сообщение уходит и получателю, и на другие устройства автора', async () => {
    live._state.dmId = 100;
    live._state.groupId = 0;
    live._state.serverId = 0;
    live._state.hasReplyCol = false;

    const row = {
        id: 101, sender_id: 2, receiver_id: 1,
        text: enc('привет с компьютера'),
        file_name: null, reply_to_id: 0, is_deleted: 0, edited_at: null, is_read: 0,
        created_ts: Math.floor(Date.now() / 1000),
        sender_name: 'Анна Смирнова', login: 'asmirnova',
        has_img: 0, has_audio: 0, has_video: 0, has_file: 0,
    };

    const io = fakeIo([1, 2]);

    await withFakeDb({
        columnExists: async () => false,
        tableExists: async () => false,
        query: async (sql, params = []) => {
            if (/FROM messages m JOIN users u/i.test(sql)) {
                return [row].filter((r) => r.id > params[0]);
            }
            return [];
        },
    }, () => live._tick(io));

    const toReceiver = io.sent.find((s) => s.room === 'user_1' && s.event === 'message:new');
    assert.ok(toReceiver, 'получателю сообщение обязано уйти');
    assert.strictEqual(toReceiver.payload.message.text, 'привет с компьютера');
    assert.strictEqual(toReceiver.payload.peerId, 2, 'для получателя собеседник — отправитель');

    const toAuthor = io.sent.find((s) => s.room === 'user_2' && s.event === 'message:new');
    assert.ok(toAuthor, 'вторая вкладка автора тоже должна получить сообщение');
    assert.strictEqual(toAuthor.payload.peerId, 1, 'для автора собеседник — получатель');

    const listUpdate = io.sent.find((s) => s.room === 'user_1' && s.event === 'chat:list_update');
    assert.ok(listUpdate, 'карточка чата должна подняться в списке');
    assert.match(listUpdate.payload.preview, /Анна Смирнова: привет с компьютера/);

    assert.strictEqual(live._state.dmId, 101, 'отметка обязана сдвинуться');
});

test('второй проход не повторяет уже разосланное', async () => {
    live._state.dmId = 101;
    const io = fakeIo([1, 2]);

    await withFakeDb({
        columnExists: async () => false,
        tableExists: async () => false,
        query: async (sql, params = []) => {
            if (/FROM messages m JOIN users u/i.test(sql)) {
                return [{ id: 101 }].filter((r) => r.id > params[0]);
            }
            return [];
        },
    }, () => live._tick(io));

    assert.strictEqual(io.sent.length, 0, 'старое сообщение второй раз не рассылается');
});

test('когда никого нет онлайн, база не опрашивается вовсе', async () => {
    let queries = 0;
    const io = fakeIo([]);

    await withFakeDb({
        query: async () => { queries += 1; return []; },
    }, () => live._tick(io));

    assert.strictEqual(queries, 0, 'без единого подключения запросов быть не должно');
});

test('сообщение канала не уходит тем, кто заглушил сервер', async () => {
    live._state.dmId = 0;
    live._state.groupId = 0;
    live._state.serverId = 500;
    live._state.hasReplyCol = false;

    const io = fakeIo([1, 3]);

    await withFakeDb({
        columnExists: async () => false,
        tableExists: async () => false,
        query: async (sql, params = []) => {
            if (/FROM messages m JOIN users u/i.test(sql)) return [];
            if (/FROM group_messages gm/i.test(sql)) return [];
            if (/FROM server_messages sm/i.test(sql)) {
                return [{
                    id: 501, channel_id: 21, sender_id: 2, text: enc('в канале'),
                    file_name: null, reply_to_id: 0,
                    created_ts: Math.floor(Date.now() / 1000),
                    sender_name: 'Анна', login: 'asmirnova',
                    server_id: 7, channel_name: 'основной',
                    has_img: 0, has_audio: 0, has_video: 0, has_file: 0,
                }].filter((r) => r.id > params[0]);
            }
            if (/FROM server_members/i.test(sql)) {
                return [
                    { server_id: 7, user_id: 1, muted_notifs: 0 },
                    { server_id: 7, user_id: 3, muted_notifs: 1 },   // заглушил
                ];
            }
            return [];
        },
    }, () => live._tick(io));

    const activity = io.sent.filter((s) => s.event === 'channel:activity');
    assert.strictEqual(activity.length, 1, 'уведомление должно уйти ровно одному');
    assert.strictEqual(activity[0].room, 'user_1');
    assert.strictEqual(activity[0].payload.channelName, 'основной');

    const toChannel = io.sent.find((s) => s.room === 'channel_21' && s.event === 'message:new');
    assert.ok(toChannel, 'в саму комнату канала сообщение уходит всегда');
});

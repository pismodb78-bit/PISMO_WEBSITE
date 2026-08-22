/**
 * Проверка пути «строка из базы → то, что уходит в браузер».
 *
 * Раньше такой проверки не было, и это пропустило падение сайта: слой
 * совместимости тестировался отдельно, интерфейс — на стенде с готовыми
 * строками, а место, где текст превращался в буфер, оказалось ровно между
 * ними. Здесь база подменяется, поэтому подключение не нужно.
 *
 * Главное правило, которое здесь закрепляется: НИ ОДНО поле, уходящее в
 * браузер, не должно быть буфером. socket.io отдаёт буфер как ArrayBuffer,
 * а React на нём падает и гасит весь экран.
 */
const test = require('node:test');
const assert = require('node:assert');

const db = require('../db');
const { enc } = require('../utils/crypto');

/** Подменяет методы базы на время одной проверки. */
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

/** Рекурсивно ищет буферы в том, что уходит клиенту. */
function findBuffers(value, path = '') {
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return [path || '<корень>'];
    if (Array.isArray(value)) {
        return value.flatMap((v, i) => findBuffers(v, `${path}[${i}]`));
    }
    if (value && typeof value === 'object') {
        return Object.entries(value).flatMap(([k, v]) => findBuffers(v, path ? `${path}.${k}` : k));
    }
    return [];
}

test('список диалогов отдаёт текст строкой, даже если база вернула буфер', async () => {
    // Ровно тот случай, что сломал сайт: колонка text объявлена как TEXT и
    // приезжает буфером.
    const rows = [{
        id: 2,
        Name: 'Анна',
        Surname: 'Смирнова',
        login: 'asmirnova',
        last_time: Math.floor(Date.now() / 1000),
        last_msg: Buffer.from(enc('привет с телефона'), 'utf8'),
        unread: 3,
    }];

    await withFakeDb({
        columnExists: async () => true,
        query: async () => rows,
    }, async () => {
        const messages = require('../data/messages');
        const list = await messages.loadConversations(1);

        assert.strictEqual(list.length, 1);
        assert.strictEqual(typeof list[0].lastMessage, 'string');
        assert.strictEqual(list[0].lastMessage, 'привет с телефона');
        assert.deepStrictEqual(findBuffers(list), [], 'в браузер не должно уйти ни одного буфера');
    });
});

test('страница переписки отдаёт текст строкой, даже если база вернула буфер', async () => {
    const rows = [{
        id: 10,
        sender_id: 2,
        text: Buffer.from(enc('текст сообщения'), 'utf8'),
        file_name: null,
        reply_to_id: 0,
        is_deleted: 0,
        edited_at: null,
        is_read: 1,
        created_ts: Math.floor(Date.now() / 1000),
        sender_name: Buffer.from('Анна Смирнова', 'utf8'),
        login: 'asmirnova',
        has_img: 0,
        has_audio: 0,
        has_video: 0,
        has_file: 0,
    }];

    await withFakeDb({ query: async () => rows }, async () => {
        const messages = require('../data/messages');
        const page = await messages.loadDirectMessages(1, 2);

        assert.strictEqual(page[0].text, 'текст сообщения');
        assert.strictEqual(typeof page[0].senderName, 'string');
        assert.deepStrictEqual(findBuffers(page), [], 'в браузер не должно уйти ни одного буфера');
    });
});

test('сообщения канала отдают текст строкой, даже если база вернула буфер', async () => {
    const rows = [{
        id: 30,
        sender_id: 2,
        text: Buffer.from(enc('сообщение в канале'), 'utf8'),
        reply_to_id: 0,
        file_name: null,
        created_ts: Math.floor(Date.now() / 1000),
        sender_name: 'Анна Смирнова',
        login: 'asmirnova',
        has_img: 0,
        has_audio: 0,
        has_video: 0,
        has_file: 0,
    }];

    await withFakeDb({
        columnExists: async () => true,
        tableExists: async () => true,
        query: async () => rows,
    }, async () => {
        const servers = require('../data/servers');
        const page = await servers.channelMessages(21);

        assert.strictEqual(page[0].text, 'сообщение в канале');
        assert.deepStrictEqual(findBuffers(page), [], 'в браузер не должно уйти ни одного буфера');
    });
});

test('профиль отдаёт «о себе» строкой, даже если колонка объявлена как TEXT', async () => {
    await withFakeDb({
        queryFirst: async () => ({
            Name: 'Пётр',
            Surname: 'Петров',
            login: 'ppetrov',
            about: Buffer.from('люблю кофе', 'utf8'),
            social_links: Buffer.from('t.me/ppetrov', 'utf8'),
        }),
    }, async () => {
        const social = require('../data/social');
        const p = await social.profile(1);

        assert.strictEqual(p.about, 'люблю кофе');
        assert.strictEqual(p.socialLinks, 't.me/ppetrov');
        assert.deepStrictEqual(findBuffers(p), [], 'в браузер не должно уйти ни одного буфера');
    });
});

// ── Ничто двоичное не уходит в браузер ─────────────────────────────────

test('toWire вычищает буферы из ответа целиком', () => {
    const { toWire } = require('../utils/wire');

    const payload = {
        messages: [
            { id: 1, text: Buffer.from('привет', 'utf8'), sender: 'Аня' },
            { id: 2, text: 'обычная строка', meta: { note: new Uint8Array(Buffer.from('заметка', 'utf8')) } },
        ],
        pinned: [],
        count: 2,
        nothing: null,
    };

    const wire = toWire(payload);

    assert.strictEqual(wire.messages[0].text, 'привет');
    assert.strictEqual(wire.messages[1].meta.note, 'заметка');
    assert.strictEqual(wire.messages[1].text, 'обычная строка');
    assert.strictEqual(wire.count, 2);
    assert.strictEqual(wire.nothing, null);
    assert.deepStrictEqual(findBuffers(wire), [], 'после toWire буферов быть не должно');
});

test('toWire не портит числа, логические значения и даты', () => {
    const { toWire } = require('../utils/wire');
    const when = new Date('2026-08-22T12:00:00Z');
    const wire = toWire({ n: 42, ok: true, when, list: [1, 'два', false] });

    assert.strictEqual(wire.n, 42);
    assert.strictEqual(wire.ok, true);
    assert.strictEqual(wire.when, when);
    assert.deepStrictEqual(wire.list, [1, 'два', false]);
});

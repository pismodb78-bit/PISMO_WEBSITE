/**
 * Отдача вложений по HTTP.
 *
 * Зачем отдельный роут, если всё остальное идёт через сокет: браузеру
 * картинку нужно поставить в <img src>, звук — в <audio src>, а файл
 * скачать. Гонять двухсотмегабайтный blob через socket.io ради этого
 * бессмысленно — он весь окажется в памяти вкладки. HTTP умеет отдавать
 * это потоком и кешировать.
 *
 * ДОСТУП ПРОВЕРЯЕТСЯ ЗДЕСЬ, а не только в интерфейсе. Ссылка вида
 * /api/media/0/123/image — это просто число: без проверки любой вошедший
 * пользователь мог бы перебором вытащить чужие вложения из личной
 * переписки. Поэтому на каждый запрос сверяем, имеет ли отношение
 * запросивший к этому сообщению.
 */
const express = require('express');
const db = require('../db');
const { verifyToken } = require('../utils/session');
const messages = require('../data/messages');
const social = require('../data/social');
const servers = require('../data/servers');
const { SCOPE, normalizeScope, tableOf } = require('../data/scopes');
const { fileExt } = require('../utils/format');

const router = express.Router();

const MIME = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml', heic: 'image/heic',
    mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska', mov: 'video/quicktime',
    mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', m4a: 'audio/mp4',
    opus: 'audio/opus', flac: 'audio/flac',
    pdf: 'application/pdf', zip: 'application/zip', rar: 'application/vnd.rar',
    '7z': 'application/x-7z-compressed', txt: 'text/plain; charset=utf-8',
};

function mimeFor(kind, fileName) {
    const ext = fileExt(fileName);
    if (MIME[ext]) return MIME[ext];
    if (kind === 'img' || kind === 'image') return 'image/jpeg';
    // Голосовые пишутся в WAV 16 кГц моно — то, что умеет NAudio на ПК.
    if (kind === 'audio') return 'audio/wav';
    // Видео-кружочки лежат в собственном контейнере PSMOVID1, браузер его
    // не проиграет; отдаём как поток байтов, разбирает их фронтенд.
    if (kind === 'video') return 'application/octet-stream';
    return 'application/octet-stream';
}

/**
 * Токен принимаем и в заголовке, и в query: у <img> и <audio> заголовки не
 * выставить, а cookie здесь не используются.
 */
function authFromRequest(req) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : (req.query.token || null);
    const payload = verifyToken(token);
    return payload ? (payload.uid || payload.id) : null;
}

/** Имею ли я право видеть это сообщение. */
async function mayRead(me, scope, msgId) {
    const sc = normalizeScope(scope);

    if (sc === SCOPE.DM) {
        const row = await db.queryFirst(
            'SELECT sender_id, receiver_id FROM messages WHERE id=?', [msgId],
        ).catch(() => null);
        if (!row) return false;
        return row.sender_id === me || row.receiver_id === me;
    }

    if (sc === SCOPE.GROUP) {
        const groupId = await db.scalarInt(
            'SELECT group_id FROM group_messages WHERE id=?', [msgId], 0,
        ).catch(() => 0);
        if (!groupId) return false;
        return social.isGroupMember(groupId, me);
    }

    const channelId = await db.scalarInt(
        'SELECT channel_id FROM server_messages WHERE id=?', [msgId], 0,
    ).catch(() => 0);
    if (!channelId) return false;
    return servers.canAccessChannel(me, channelId);
}

// GET /api/media/:scope/:msgId/:kind   (kind: image | audio | video | file)
router.get('/:scope/:msgId/:kind', async (req, res) => {
    const me = authFromRequest(req);
    if (!me) return res.status(401).json({ message: 'Требуется вход' });

    const scope = normalizeScope(req.params.scope);
    const msgId = parseInt(req.params.msgId, 10);
    const kind = String(req.params.kind || '').toLowerCase();
    if (!Number.isFinite(msgId) || msgId <= 0) {
        return res.status(400).json({ message: 'Некорректный номер сообщения' });
    }

    try {
        if (!(await mayRead(me, scope, msgId))) {
            return res.status(403).json({ message: 'Нет доступа к этому вложению' });
        }

        const blob = await messages.loadBlob(scope, msgId, kind);
        if (!blob) return res.status(404).json({ message: 'Вложение не найдено' });

        const name = blob.fileName || `pismo_${msgId}`;
        res.setHeader('Content-Type', mimeFor(kind, name));
        res.setHeader('Content-Length', blob.data.length);
        // Вложение неизменяемо: правка сообщения его не трогает, а удаление
        // выдаёт 404. Поэтому кешируем надолго и не перезапрашиваем.
        res.setHeader('Cache-Control', 'private, max-age=86400');

        if (kind === 'file') {
            // filename* по RFC 5987 — иначе кириллица в имени превращается
            // в мусор при скачивании.
            res.setHeader(
                'Content-Disposition',
                `attachment; filename="${encodeURIComponent(name)}"; `
                + `filename*=UTF-8''${encodeURIComponent(name)}`,
            );
        }
        return res.end(blob.data);
    } catch (err) {
        console.error('[медиа]', err.message);
        return res.status(500).json({ message: 'Не удалось прочитать вложение' });
    }
});

// GET /api/media/avatar/:userId — аватар пользователя.
router.get('/avatar/:userId', async (req, res) => {
    const me = authFromRequest(req);
    if (!me) return res.status(401).json({ message: 'Требуется вход' });
    const userId = parseInt(req.params.userId, 10);
    if (!Number.isFinite(userId)) return res.status(400).end();

    try {
        const bytes = await social.avatar(userId);
        if (!bytes) return res.status(404).end();
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'private, max-age=300');
        return res.end(bytes);
    } catch (_) {
        return res.status(404).end();
    }
});

// GET /api/media/banner/:userId
router.get('/banner/:userId', async (req, res) => {
    const me = authFromRequest(req);
    if (!me) return res.status(401).json({ message: 'Требуется вход' });
    const userId = parseInt(req.params.userId, 10);
    if (!Number.isFinite(userId)) return res.status(400).end();

    try {
        const bytes = await social.banner(userId);
        if (!bytes) return res.status(404).end();
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'private, max-age=300');
        return res.end(bytes);
    } catch (_) {
        return res.status(404).end();
    }
});

module.exports = router;

/**
 * Access-токены LiveKit — порт LiveKitSettings.CreateToken (ПК) и
 * LiveKitToken.kt (Android).
 *
 * Токен-сервера в проекте нет: клиенты подписывают токен сами секретом
 * проекта. Сайт делает это на бэкенде — секрет не должен попадать в
 * браузер, — но payload собирается ровно тот же.
 *
 * ТРИ ВЕЩИ, КОТОРЫЕ ОБЯЗАНЫ СОВПАДАТЬ, ИНАЧЕ ЗВОНОК «ИДЁТ», НО ПУСТОЙ:
 *
 *  1. Имя комнаты. ПК формирует его как `_isChannel ? _channelRoom
 *     : "call_" + _sessionId`. Префикс не косметический: без него браузер
 *     заходил бы в комнату "17", а ПК — в "call_17", и каждый сидел бы в
 *     своей пустой комнате.
 *  2. identity участника — id пользователя СТРОКОЙ, без префиксов. По нему
 *     ПК сопоставляет участников с плитками. Прежняя версия сайта слала
 *     "user_5", и такой участник на ПК оставался неопознанным.
 *  3. canUpdateOwnMetadata. Без него сервер молча игнорирует смену
 *     атрибутов участника, и значки мьюта микрофона и наушников перестают
 *     работать — без единой ошибки в логах.
 */
const crypto = require('crypto');
const config = require('../config');

/** Base64Url без паддинга — как Jwt.b64Url на клиентах. */
function b64url(buf) {
    return Buffer.from(buf).toString('base64')
        .replace(/=+$/, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

/** Подписывает готовый payload-JSON секретом (HS256). */
function sign(payloadJson, secret) {
    const header = b64url(Buffer.from('{"alg":"HS256","typ":"JWT"}', 'utf8'));
    const payload = b64url(Buffer.from(payloadJson, 'utf8'));
    const signingInput = `${header}.${payload}`;
    const sig = crypto.createHmac('sha256', secret).update(signingInput, 'ascii').digest();
    return `${signingInput}.${b64url(sig)}`;
}

/** Комната личного или группового звонка. */
function roomForCall(sessionId) {
    return `call_${sessionId}`;
}

/** Комната голосового канала сервера. По ней VoicePresence определяет канал. */
function roomForVoiceChannel(channelId) {
    return `vch_${channelId}`;
}

/** "vch_123" -> 123, иначе -1 (порт VoicePresence.ChannelIdFromRoom). */
function channelIdFromRoom(room) {
    if (!room || !/^vch_/i.test(room)) return -1;
    const id = parseInt(room.slice(4), 10);
    return Number.isFinite(id) ? id : -1;
}

/**
 * Создаёт JWT для входа участника в комнату.
 *
 * @param {string} roomName   см. roomForCall / roomForVoiceChannel
 * @param {number|string} identity id пользователя — строкой, без префикса
 * @param {string} displayName отображаемое имя
 */
function createToken(roomName, identity, displayName) {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + config.livekit.tokenTtl;

    // Ключи и их порядок повторяют клиентов. JSON.stringify экранирует
    // строки по тем же правилам, что Jwt.esc.
    const payload = JSON.stringify({
        iss: config.livekit.apiKey,
        sub: String(identity),
        name: displayName || String(identity),
        nbf: now,
        exp,
        video: {
            roomJoin: true,
            room: roomName,
            canPublish: true,
            canSubscribe: true,
            canPublishData: true,
            canUpdateOwnMetadata: true,
        },
    });

    return sign(payload, config.livekit.apiSecret);
}

/** Настроен ли LiveKit — если нет, звонки просто не предлагаются. */
function isConfigured() {
    return Boolean(config.livekit.url && config.livekit.apiKey && config.livekit.apiSecret);
}

module.exports = {
    sign,
    b64url,
    createToken,
    roomForCall,
    roomForVoiceChannel,
    channelIdFromRoom,
    isConfigured,
    url: config.livekit.url,
};

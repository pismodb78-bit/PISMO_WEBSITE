// npm install livekit-server-sdk --save   (в папке backend)
const { AccessToken, RoomServiceClient } = require('livekit-server-sdk');

// Впиши в .env бэкенда (или замени напрямую, но .env удобнее):
//   LIVEKIT_WS_URL=wss://твой_домен_или_ip:7880   <- этот адрес уходит на ФРОНТЕНД (клиент подключается сюда)
//   LIVEKIT_HTTP_URL=http://твой_домен_или_ip:7880 <- этот адрес использует сам бэкенд для Room API
//   LIVEKIT_API_KEY=... (из generate-keys)
//   LIVEKIT_API_SECRET=...
const LIVEKIT_WS_URL = process.env.LIVEKIT_WS_URL || 'ws://localhost:7880';
const LIVEKIT_HTTP_URL = process.env.LIVEKIT_HTTP_URL || 'http://localhost:7880';
const API_KEY = process.env.LIVEKIT_API_KEY;
const API_SECRET = process.env.LIVEKIT_API_SECRET;

if (!API_KEY || !API_SECRET) {
    console.warn('[LiveKit] LIVEKIT_API_KEY / LIVEKIT_API_SECRET не заданы в .env — звонки работать не будут');
}

const roomService = new RoomServiceClient(LIVEKIT_HTTP_URL, API_KEY, API_SECRET);

/**
 * Генерирует JWT-токен для входа конкретного пользователя в конкретную комнату.
 * identity должен быть уникален и стабилен для пользователя (используем user_<id>),
 * это то, что LiveKit покажет как идентификатор участника.
 */
async function createCallToken({ roomName, userId, displayName }) {
    const at = new AccessToken(API_KEY, API_SECRET, {
        identity: `user_${userId}`,
        name: displayName || `user_${userId}`,
        ttl: '15m' // токен нужен только на подключение, дальше сессия живёт по вебсокету LiveKit
    });
    at.addGrant({
        roomJoin: true,
        room: roomName,
        canPublish: true,
        canSubscribe: true,
        canPublishData: true
    });
    return await at.toJwt();
}

/**
 * Принудительно закрывает комнату на сервере LiveKit (отключает всех, если вдруг
 * кто-то завис) — вызывается, когда звонок завершён по логике бэкенда.
 */
async function closeRoom(roomName) {
    try {
        await roomService.deleteRoom(roomName);
    } catch (err) {
        // Комната могла уже не существовать (LiveKit сам закрывает пустые room'ы
        // через empty_timeout) — не считаем это ошибкой
        console.warn(`[LiveKit] closeRoom(${roomName}):`, err.message);
    }
}

module.exports = { createCallToken, closeRoom, LIVEKIT_WS_URL, roomService };
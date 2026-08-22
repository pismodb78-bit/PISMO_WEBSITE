/**
 * Единая точка настройки шлюза.
 *
 * Значения по умолчанию совпадают с тем, что зашито в клиентах: Prefs.kt на
 * Android и ip.txt / livekitsettings.json на ПК. Совпадать они обязаны —
 * иначе сайт подключится к другой базе или подпишет токен LiveKit другим
 * секретом, и пользователи окажутся в разных комнатах.
 *
 * Всё переопределяется переменными окружения, чтобы после ротации ключей
 * не пересобирать бэкенд.
 */
const fs = require('fs');
const path = require('path');

/**
 * ip.txt в формате ПК-версии:
 *   server=5.181.23.167;port=3307;uid=user1;password=scent01;database=bdauth
 *
 * Файл необязателен: без него берутся значения по умолчанию. Раньше его
 * отсутствие роняло процесс через process.exit(1) ещё до старта — на новой
 * машине сайт просто не запускался, ничего не объяснив.
 */
function readIpFile() {
    const file = process.env.PISMO_IP_FILE || path.join(__dirname, '..', 'ip.txt');
    if (!fs.existsSync(file)) return {};
    try {
        const out = {};
        fs.readFileSync(file, 'utf8').trim().split(';').forEach((pair) => {
            const idx = pair.indexOf('=');
            if (idx <= 0) return;
            out[pair.slice(0, idx).trim().toLowerCase()] = pair.slice(idx + 1).trim();
        });
        return out;
    } catch (err) {
        console.warn(`[конфиг] ip.txt не прочитан: ${err.message}`);
        return {};
    }
}

const ip = readIpFile();

/**
 * Хост базы. Прежний адрес 85.174.248.59 больше не обслуживается — всё
 * переехало на 5.181.23.167, туда же смотрят Android (Prefs.dbHost) и ПК.
 */
const DB_HOST = process.env.DB_HOST || ip.server || '5.181.23.167';

const config = {
    db: {
        host: DB_HOST,
        port: parseInt(process.env.DB_PORT || ip.port, 10) || 3307,
        user: process.env.DB_USER || ip.uid || 'user1',
        password: process.env.DB_PASSWORD || ip.password || 'scent01',
        database: process.env.DB_NAME || ip.database || 'bdauth',
    },

    /**
     * Секрет JWT сессии сайта. Тот же, что у ws-сервера сигналинга и у
     * JwtAuth.cs / JwtAuth.kt: с ним выданный сайтом токен принимается
     * сигналингом без отдельного входа.
     */
    jwtSecret: process.env.JWT_SECRET
        || 'uc5KT2e+qYwa6tb0HUXnLZwsC55VuB93szkSpkucr8i1BFjKA6RXbyIrjk0+ign9',
    jwtTtlDays: parseInt(process.env.JWT_TTL_DAYS, 10) || 30,

    livekit: {
        /**
         * Адрес, который уходит в браузер. Браузер по https запрещает
         * подключение к ws:// — на боевом домене здесь обязан быть wss://,
         * см. README. Значение по умолчанию совпадает с клиентами.
         */
        url: process.env.LIVEKIT_URL || `ws://${DB_HOST}:7880`,
        apiKey: process.env.LIVEKIT_API_KEY || 'APIkey5I8EkGBDSc4jdmI5QcVC',
        apiSecret: process.env.LIVEKIT_API_SECRET
            || 'Y3pIteGv4BxEEWSmIvE3P9YqDTBdc3nF7IzWNa51flCRS8Gx',
        /** TTL токена входа в комнату, секунды (как liveKitTokenTtl на Android). */
        tokenTtl: parseInt(process.env.LIVEKIT_TOKEN_TTL, 10) || 21600,
    },

    /** ws-сервер сигналинга ПК-версии. Пусто — сигналинг не используется. */
    signalingUrl: process.env.SIGNALING_URL || `ws://${DB_HOST}:8080/`,

    port: parseInt(process.env.PORT, 10) || 5000,

    /**
     * Разрешённые origin через запятую. Пусто — отражаем любой (режим
     * разработки). На боевом домене задать явно.
     */
    corsOrigins: (process.env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean),

    /**
     * Потолок вложения. На ПК файл дозаписывается кусками по 4 МБ, здесь
     * тот же приём (см. utils/blobs.js), а это ограничение на один кусок,
     * приходящий по сокету.
     */
    chunkBytes: 4 * 1024 * 1024,
    maxUploadBytes: parseInt(process.env.MAX_UPLOAD_BYTES, 10) || 200 * 1024 * 1024,
};

module.exports = config;

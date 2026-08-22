/**
 * Онлайн-статусы и присутствие в голосовых каналах — порт
 * PresenceRepository.kt (MainForm_Presence.cs и VoicePresence.cs на ПК).
 *
 * ПОРОГИ МЕНЯТЬ НЕЛЬЗЯ. «Не в сети» при seen_ago > 40, «бездействует» при
 * active_ago > 90 — ровно как на ПК. Свои значения давали расхождение:
 * сайт показывал бы человека в сети, когда компьютер уже считает его
 * офлайн, и наоборот.
 */
const db = require('../db');

/** Запись в voice_presence «жива», если heartbeat был не давнее 20 секунд. */
const FRESH_SECONDS = 20;

const SEEN_OFFLINE_SEC = 40;
const ACTIVE_IDLE_SEC = 90;

/** Таблицы voice_presence может не быть — тогда перестаём в неё стучаться. */
let voiceTableOk = true;

// ── Присутствие пользователя ──────────────────────────────────────────

/**
 * Heartbeat. active = человек реально что-то делает (иначе обновляем
 * только last_seen, и статус уезжает в «бездействует»).
 */
async function heartbeat(me, active) {
    await db.exec(
        'UPDATE users SET last_seen=NOW(), last_active=IF(?=1, NOW(), last_active) WHERE id=?',
        [active ? 1 : 0, me],
    ).catch(() => {});
}

/** При выходе отодвигаем last_seen на час назад — сразу «оффлайн». */
async function markOffline(me) {
    await db.exec(
        'UPDATE users SET last_seen = DATE_SUB(NOW(), INTERVAL 1 HOUR) WHERE id=?', [me],
    ).catch(() => {});
}

/** Статусы набора пользователей: id -> {seenAgoSec, activeAgoSec, online, idle}. */
async function presenceFor(userIds) {
    const ids = [...new Set((userIds || []).map((n) => parseInt(n, 10)).filter(Number.isFinite))];
    if (ids.length === 0) return {};
    try {
        const rows = await db.query(
            'SELECT id, TIMESTAMPDIFF(SECOND, last_seen, NOW()) AS seen_ago, '
            + 'TIMESTAMPDIFF(SECOND, last_active, NOW()) AS active_ago '
            + `FROM users WHERE id IN (${ids.join(',')})`,
        );
        const out = {};
        for (const r of rows) {
            const seen = r.seen_ago === null ? Number.MAX_SAFE_INTEGER : Number(r.seen_ago);
            const act = r.active_ago === null ? Number.MAX_SAFE_INTEGER : Number(r.active_ago);
            out[r.id] = {
                userId: r.id,
                seenAgoSec: seen,
                activeAgoSec: act,
                online: seen >= 0 && seen <= SEEN_OFFLINE_SEC,
                idle: seen >= 0 && seen <= SEEN_OFFLINE_SEC && act > ACTIVE_IDLE_SEC,
            };
        }
        return out;
    } catch (_) {
        return {};
    }
}

// ── Голосовые каналы ──────────────────────────────────────────────────

/** streaming — включена камера или демонстрация экрана. */
async function voiceHeartbeat(me, channelId, { streaming = false, micMuted = false, deafened = false } = {}) {
    if (!voiceTableOk || !channelId || channelId <= 0) return;
    const b = (v) => (v ? 1 : 0);
    try {
        await db.exec(
            'INSERT INTO voice_presence (channel_id,user_id,joined_at,last_seen,streaming,mic_muted,deafened) '
            + 'VALUES (?,?,NOW(),NOW(),?,?,?) '
            + 'ON DUPLICATE KEY UPDATE last_seen=NOW(), streaming=?, mic_muted=?, deafened=?',
            [channelId, me, b(streaming), b(micMuted), b(deafened),
                b(streaming), b(micMuted), b(deafened)],
        );
    } catch (err) {
        // 1146 = таблицы нет, миграция не выполнена. Больше не долбимся.
        if (/doesn't exist/i.test(err.message || '')) voiceTableOk = false;
    }
}

async function voiceLeave(me, channelId) {
    if (!channelId || channelId <= 0) return;
    await db.exec(
        'DELETE FROM voice_presence WHERE channel_id=? AND user_id=?', [channelId, me],
    ).catch(() => {});
}

/** Сколько живых участников сейчас в канале — для проверки лимита. */
async function voiceCount(channelId) {
    if (!voiceTableOk || !channelId || channelId <= 0) return 0;
    return db.scalarInt(
        'SELECT COUNT(*) FROM voice_presence '
        + `WHERE channel_id=? AND last_seen > (NOW() - INTERVAL ${FRESH_SECONDS} SECOND)`,
        [channelId], 0,
    ).catch(() => 0);
}

/** Уже ли я в этом канале — перезаход не должен упираться в лимит. */
async function amIInChannel(me, channelId) {
    if (!voiceTableOk || !channelId || channelId <= 0) return false;
    const n = await db.scalarInt(
        'SELECT COUNT(*) FROM voice_presence WHERE channel_id=? AND user_id=? '
        + `AND last_seen > (NOW() - INTERVAL ${FRESH_SECONDS} SECOND)`,
        [channelId, me], 0,
    ).catch(() => 0);
    return n > 0;
}

function mapParticipant(r) {
    return {
        userId: r.user_id,
        name: String(r.nm || '').trim() || r.login || '',
        streaming: Number(r.streaming) === 1,
        micMuted: Number(r.mic_muted) === 1,
        deafened: Number(r.deafened) === 1,
    };
}

/** Живые участники всех голосовых каналов сервера: channelId -> список. */
async function voiceForServer(serverId) {
    if (!voiceTableOk || !serverId || serverId <= 0) return {};
    try {
        const rows = await db.query(
            'SELECT vp.channel_id, vp.user_id, vp.streaming, vp.mic_muted, vp.deafened, '
            + "TRIM(CONCAT(u.Name,' ',u.Surname)) AS nm, u.login "
            + 'FROM voice_presence vp '
            + 'JOIN server_channels sc ON sc.id = vp.channel_id '
            + 'JOIN users u ON u.id = vp.user_id '
            + `WHERE sc.server_id=? AND vp.last_seen > (NOW() - INTERVAL ${FRESH_SECONDS} SECOND)`,
            [serverId],
        );
        const out = {};
        for (const r of rows) {
            if (!out[r.channel_id]) out[r.channel_id] = [];
            out[r.channel_id].push(mapParticipant(r));
        }
        return out;
    } catch (_) {
        return {};
    }
}

/** Живые участники одного канала. */
async function voiceForChannel(channelId) {
    try {
        const rows = await db.query(
            'SELECT vp.user_id, vp.streaming, vp.mic_muted, vp.deafened, '
            + "TRIM(CONCAT(u.Name,' ',u.Surname)) AS nm, u.login "
            + 'FROM voice_presence vp JOIN users u ON u.id = vp.user_id '
            + `WHERE vp.channel_id=? AND vp.last_seen > (NOW() - INTERVAL ${FRESH_SECONDS} SECOND)`,
            [channelId],
        );
        return rows.map(mapParticipant);
    } catch (_) {
        return [];
    }
}

module.exports = {
    FRESH_SECONDS, SEEN_OFFLINE_SEC, ACTIVE_IDLE_SEC,
    heartbeat, markOffline, presenceFor,
    voiceHeartbeat, voiceLeave, voiceCount, amIInChannel, voiceForServer, voiceForChannel,
};

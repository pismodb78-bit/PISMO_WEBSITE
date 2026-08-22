/**
 * Друзья, профили, пользователи и группы — порт FriendsRepository.kt,
 * ProfileRepository.kt и GroupRepository.kt.
 */
const db = require('../db');
const { buildName } = require('../utils/format');
const { asText } = require('../utils/crypto');

// ════════════════════════════════════════════════════════════════════
//  ДРУЗЬЯ
// ════════════════════════════════════════════════════════════════════

/** Колонка status появилась миграцией 1; на базе без неё её нет в WHERE. */
let hasStatus = null;
async function acceptedPredicate(alias) {
    if (hasStatus === null) hasStatus = await db.columnExists('friends', 'status').catch(() => true);
    return hasStatus ? `${alias}.status=1` : '(1=1)';
}

const RELATION = {
    NONE: 'none',
    FRIEND: 'friend',
    OUTGOING_PENDING: 'outgoing',
    INCOMING_PENDING: 'incoming',
};

async function relation(me, them) {
    try {
        const row = await db.queryFirst(
            'SELECT user_id, status FROM friends WHERE (user_id=? AND friend_id=?) '
            + 'OR (user_id=? AND friend_id=?)',
            [me, them, them, me],
        );
        if (!row) return RELATION.NONE;
        if (Number(row.status) === 1) return RELATION.FRIEND;
        return row.user_id === me ? RELATION.OUTGOING_PENDING : RELATION.INCOMING_PENDING;
    } catch (_) {
        return RELATION.NONE;
    }
}

async function sendRequest(me, targetId) {
    await db.exec(
        'INSERT IGNORE INTO friends (user_id, friend_id, status) VALUES (?, ?, 0)',
        [me, targetId],
    );
}

/** Принять входящую заявку от requesterId. */
async function acceptRequest(me, requesterId) {
    await db.exec(
        'UPDATE friends SET status=1 WHERE user_id=? AND friend_id=?', [requesterId, me],
    );
}

async function declineRequest(me, requesterId) {
    await db.exec(
        'DELETE FROM friends WHERE user_id=? AND friend_id=? AND status=0', [requesterId, me],
    );
}

/** Удалить из друзей — в обе стороны. */
async function removeFriend(me, otherId) {
    await db.exec(
        'DELETE FROM friends WHERE (user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)',
        [me, otherId, otherId, me],
    );
}

function mapFriend(r) {
    return { userId: r.id, name: buildName(r.Name, r.Surname, r.login), login: r.login || '' };
}

async function friends(me) {
    const accepted = await acceptedPredicate('f');
    const rows = await db.query(
        'SELECT u.id, u.Name, u.Surname, u.login FROM friends f '
        + 'JOIN users u ON u.id = IF(f.user_id=?, f.friend_id, f.user_id) '
        + `WHERE ${accepted} AND (f.user_id=? OR f.friend_id=?) `
        + 'ORDER BY u.Name, u.Surname',
        [me, me, me],
    ).catch(() => []);
    return rows.map(mapFriend);
}

async function incomingRequests(me) {
    const rows = await db.query(
        'SELECT u.id, u.Name, u.Surname, u.login FROM friends f '
        + 'JOIN users u ON u.id = f.user_id '
        + 'WHERE f.friend_id=? AND f.status=0 ORDER BY u.Name',
        [me],
    ).catch(() => []);
    return rows.map(mapFriend);
}

async function outgoingRequests(me) {
    const rows = await db.query(
        'SELECT u.id, u.Name, u.Surname, u.login FROM friends f '
        + 'JOIN users u ON u.id = f.friend_id '
        + 'WHERE f.user_id=? AND f.status=0 ORDER BY u.Name',
        [me],
    ).catch(() => []);
    return rows.map(mapFriend);
}

async function isFriend(a, b) {
    const p = await acceptedPredicate('friends');
    return db.exists(
        `SELECT 1 FROM friends WHERE ${p} AND `
        + '((user_id=? AND friend_id=?) OR (user_id=? AND friend_id=?)) LIMIT 1',
        [a, b, b, a],
    ).catch(() => false);
}

// ════════════════════════════════════════════════════════════════════
//  ПРИВАТНОСТЬ ЛС
// ════════════════════════════════════════════════════════════════════

/** 0 = писать могут все, 1 = только друзья. */
async function dmPrivacy(userId) {
    // Значение хранится в user_prefs, а на базе без миграции 2 — в
    // users.dm_privacy (миграция 3 заводит запасное хранилище).
    const fromPrefs = await db.scalarInt(
        'SELECT dm_privacy FROM user_prefs WHERE user_id=?', [userId], -1,
    ).catch(() => -1);
    if (fromPrefs >= 0) return fromPrefs;
    return db.scalarInt('SELECT dm_privacy FROM users WHERE id=?', [userId], 0).catch(() => 0);
}

async function setDmPrivacy(userId, value) {
    const v = value ? 1 : 0;
    await db.exec(
        'INSERT INTO user_prefs (user_id, dm_privacy) VALUES (?, ?) '
        + 'ON DUPLICATE KEY UPDATE dm_privacy=VALUES(dm_privacy)',
        [userId, v],
    ).catch(() => {});
    await db.exec('UPDATE users SET dm_privacy=? WHERE id=?', [v, userId]).catch(() => {});
}

/**
 * Можно ли мне писать этому человеку. Проверка нужна на сервере, а не
 * только в интерфейсе: иначе настройку обходит кто угодно, кто умеет
 * отправить событие сокета руками.
 */
async function canWriteTo(me, targetId) {
    if (me === targetId) return true;
    const privacy = await dmPrivacy(targetId);
    if (privacy !== 1) return true;
    return isFriend(me, targetId);
}

// ════════════════════════════════════════════════════════════════════
//  ПОЛЬЗОВАТЕЛИ И ПРОФИЛИ
// ════════════════════════════════════════════════════════════════════

async function allUsers(me) {
    const rows = await db.query(
        'SELECT id, Name, Surname, login, role FROM users WHERE id <> ? ORDER BY Name',
        [me],
    );
    return rows.map((r) => ({
        id: r.id,
        name: buildName(r.Name, r.Surname, r.login),
        login: r.login || '',
        role: (r.role || '').toLowerCase(),
    }));
}

async function profile(userId) {
    const row = await db.queryFirst(
        'SELECT Name, Surname, login, about, social_links FROM users WHERE id=?', [userId],
    ).catch(async () => db.queryFirst('SELECT Name, Surname, login FROM users WHERE id=?', [userId]));
    if (!row) return null;
    // about и social_links на части схем объявлены как TEXT, а такие
    // колонки драйвер при неудачной настройке отдаёт буфером — в браузере
    // он превращается в ArrayBuffer и роняет отрисовку. Приводим явно.
    return {
        id: userId,
        name: asText(row.Name) || '',
        surname: asText(row.Surname) || '',
        login: asText(row.login) || '',
        about: asText(row.about) || '',
        socialLinks: asText(row.social_links) || '',
        displayName: buildName(row.Name, row.Surname, row.login),
    };
}

async function loginTaken(login, exceptId) {
    return (await db.scalarInt(
        'SELECT COUNT(*) FROM users WHERE login=? AND id<>?', [login, exceptId], 0,
    )) > 0;
}

async function saveProfile(userId, { name, surname, login, about, socialLinks }) {
    try {
        await db.exec(
            'UPDATE users SET Name=?, Surname=?, login=?, about=?, social_links=? WHERE id=?',
            [name, surname, login, about ?? '', socialLinks ?? '', userId],
        );
    } catch (_) {
        // На базе без колонок about/social_links сохраняем хотя бы имя.
        await db.exec(
            'UPDATE users SET Name=?, Surname=?, login=? WHERE id=?',
            [name, surname, login, userId],
        );
    }
}

/** Аватар и баннер лежат в самой таблице users, как на ПК. */
async function avatar(userId) {
    const row = await db.queryFirst('SELECT avatar_data FROM users WHERE id=?', [userId]).catch(() => null);
    return row?.avatar_data ?? null;
}

async function setAvatar(userId, bytes) {
    await db.exec('UPDATE users SET avatar_data=? WHERE id=?', [bytes, userId]);
}

async function banner(userId) {
    const row = await db.queryFirst('SELECT banner_data FROM users WHERE id=?', [userId]).catch(() => null);
    return row?.banner_data ?? null;
}

async function setBanner(userId, bytes) {
    await db.exec('UPDATE users SET banner_data=? WHERE id=?', [bytes, userId]);
}

// ════════════════════════════════════════════════════════════════════
//  ГРУППЫ
// ════════════════════════════════════════════════════════════════════

async function createGroup(me, name, memberIds = []) {
    const groupId = await db.insert('INSERT INTO group_chats (name, created_by) VALUES (?, ?)', [name, me]);
    if (groupId <= 0) return 0;
    await db.exec(
        'INSERT INTO group_members (group_id, user_id, is_admin) VALUES (?, ?, 1)', [groupId, me],
    );
    for (const uid of memberIds) {
        if (uid === me) continue;
        // eslint-disable-next-line no-await-in-loop
        await db.exec(
            'INSERT INTO group_members (group_id, user_id, is_admin) VALUES (?, ?, 0)',
            [groupId, uid],
        ).catch(() => {});
    }
    return groupId;
}

async function groupMembers(groupId) {
    const rows = await db.query(
        "SELECT u.id, TRIM(CONCAT(u.Name,' ',u.Surname)) AS full_name, u.login, gm.is_admin "
        + 'FROM group_members gm JOIN users u ON u.id = gm.user_id '
        + 'WHERE gm.group_id=? ORDER BY gm.is_admin DESC, full_name ASC',
        [groupId],
    );
    return rows.map((r) => ({
        userId: r.id,
        name: String(r.full_name || '').trim() || r.login || '',
        login: r.login || '',
        isAdmin: Number(r.is_admin) === 1,
    }));
}

async function isGroupMember(groupId, userId) {
    return (await db.scalarInt(
        'SELECT COUNT(*) FROM group_members WHERE group_id=? AND user_id=?', [groupId, userId], 0,
    )) > 0;
}

async function addGroupMembers(groupId, userIds = []) {
    let added = 0;
    for (const uid of userIds) {
        // eslint-disable-next-line no-await-in-loop
        const ok = await db.exec(
            'INSERT INTO group_members (group_id, user_id, is_admin) VALUES (?, ?, 0)',
            [groupId, uid],
        ).then(() => true).catch(() => false);
        if (ok) added += 1;
    }
    return added;
}

async function removeGroupMember(groupId, userId) {
    await db.exec('DELETE FROM group_members WHERE group_id=? AND user_id=?', [groupId, userId]);
}

async function groupCreator(groupId) {
    return db.scalarInt('SELECT created_by FROM group_chats WHERE id=?', [groupId], -1).catch(() => -1);
}

async function deleteGroup(groupId) {
    await db.exec('DELETE FROM group_messages WHERE group_id=?', [groupId]).catch(() => {});
    await db.exec('DELETE FROM group_members WHERE group_id=?', [groupId]).catch(() => {});
    await db.exec('DELETE FROM group_chats WHERE id=?', [groupId]);
}

module.exports = {
    RELATION,
    relation, sendRequest, acceptRequest, declineRequest, removeFriend,
    friends, incomingRequests, outgoingRequests, isFriend,
    dmPrivacy, setDmPrivacy, canWriteTo,
    allUsers, profile, saveProfile, loginTaken, avatar, setAvatar, banner, setBanner,
    createGroup, groupMembers, isGroupMember, addGroupMembers, removeGroupMember,
    groupCreator, deleteGroup,
};

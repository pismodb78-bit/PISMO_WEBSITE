/**
 * Пул подключений к MySQL `bdauth` — к той же базе, куда напрямую ходят
 * ПК-клиент (DBHelper.cs) и Android (Db.kt).
 *
 * Своего бэкенда у проекта исторически нет: приложения работают с базой
 * сами. Браузер так не умеет — из веб-страницы нельзя открыть TCP-сокет к
 * MySQL, — поэтому сайту нужен этот шлюз. Он не «ещё один сервер данных»,
 * а ровно тот же слой запросов, только вынесенный за пределы страницы.
 *
 * Отсюда следует главное правило файла: любой запрос здесь обязан
 * совпадать с запросом клиента. Расхождение не ломает сборку и не даёт
 * ошибку — оно проявляется как «на сайте видно не то, что в приложении».
 */
const mysql = require('mysql2/promise');
const config = require('./config');

const pool = mysql.createPool({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    database: config.db.database,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000,
    // Кириллица и эмодзи. utf8mb4 обязателен: реакции хранятся эмодзи, а в
    // utf8mb4_general_ci разные эмодзи ещё и сравниваются как равные — из-за
    // этого на ПК тумблер реакции снимал чужую (миграция 9 чинит коллацию).
    charset: 'utf8mb4',
    // typeCast ЗДЕСЬ БЫТЬ НЕ ДОЛЖНО — и вот почему.
    //
    // Раньше тут стояла «страховка» для вложений: всё, что похоже на blob,
    // отдавать буфером. Она ломала весь сайт. В протоколе MySQL у TEXT и
    // BLOB ОДИН И ТОТ ЖЕ код типа (0xfc), и mysql2 называет оба 'BLOB' —
    // различает их только кодировка колонки. Поэтому условие по имени типа
    // попадало и в messages.text: текст сообщения приезжал буфером, дальше
    // socket.io отдавал его в браузер как ArrayBuffer, и React падал с
    // «Objects are not valid as a React child» — сайт открывался и тут же
    // гас на списке диалогов.
    //
    // Своя обработка не нужна вовсе: mysql2 по умолчанию смотрит именно на
    // кодировку — двоичная (63) отдаётся буфером, любая другая строкой, —
    // то есть вложения и так приходят байтами, а тексты строками.
    // Времена читаем через UNIX_TIMESTAMP() в самом SQL (как на Android),
    // чтобы драйвер не вносил сдвиг часовых поясов.
    dateStrings: true,
    timezone: 'Z',
});

console.log(`[БД] пул готов: ${config.db.host}:${config.db.port}/${config.db.database}`);

// ── Хелперы запросов (та же форма, что у Db.kt) ────────────────────────

async function query(sql, params = []) {
    const [rows] = await pool.query(sql, params);
    return rows;
}

async function queryFirst(sql, params = []) {
    const rows = await query(sql, params);
    return rows.length ? rows[0] : null;
}

/** Возвращает affectedRows. */
async function exec(sql, params = []) {
    const [result] = await pool.query(sql, params);
    return result.affectedRows ?? 0;
}

/** INSERT с возвратом сгенерированного id (аналог LastInsertedId). */
async function insert(sql, params = []) {
    const [result] = await pool.query(sql, params);
    return result.insertId ?? 0;
}

async function scalar(sql, params = [], fallback = null) {
    const row = await queryFirst(sql, params);
    if (!row) return fallback;
    const first = Object.values(row)[0];
    return first === null || first === undefined ? fallback : first;
}

async function scalarInt(sql, params = [], fallback = 0) {
    const v = await scalar(sql, params, null);
    if (v === null) return fallback;
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}

async function exists(sql, params = []) {
    return (await queryFirst(sql, params)) !== null;
}

/**
 * Есть ли колонка. На этом хостинге доступ к information_schema закрыт даже
 * администратору (#1044) — тот же случай, что описан в ServerRepository.kt,
 * — поэтому есть фолбэк на SHOW COLUMNS, которому хватает обычных прав.
 *
 * Ответ кэшируется: проверка идёт перед каждым запросом сообщений канала, а
 * схема за время жизни процесса не меняется.
 */
const columnCache = new Map();

async function columnExists(table, column) {
    const key = `${table}.${column}`;
    if (columnCache.has(key)) return columnCache.get(key);

    let found = false;
    try {
        found = await scalarInt(
            'SELECT COUNT(*) FROM information_schema.COLUMNS '
            + 'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME=? AND COLUMN_NAME=?',
            [table, column],
        ) > 0;
    } catch (_) {
        if (/^[A-Za-z0-9_]+$/.test(table)) {
            try {
                const rows = await query(`SHOW COLUMNS FROM \`${table}\``);
                found = rows.some((r) => String(r.Field).toLowerCase() === column.toLowerCase());
            } catch (_) {
                found = false;
            }
        }
    }
    columnCache.set(key, found);
    return found;
}

const tableCache = new Map();

async function tableExists(table) {
    if (tableCache.has(table)) return tableCache.get(table);
    let found = false;
    try {
        found = await scalarInt(
            'SELECT COUNT(*) FROM information_schema.TABLES '
            + 'WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME=?',
            [table],
        ) > 0;
    } catch (_) {
        try {
            const rows = await query('SHOW TABLES');
            found = rows.some((r) => String(Object.values(r)[0]).toLowerCase() === table.toLowerCase());
        } catch (_) {
            found = false;
        }
    }
    tableCache.set(table, found);
    return found;
}

/** Проверка связи — для /api/health. */
async function ping() {
    return scalar('SELECT VERSION()', [], '?');
}

module.exports = {
    pool,
    query,
    queryFirst,
    exec,
    insert,
    scalar,
    scalarInt,
    exists,
    columnExists,
    tableExists,
    ping,
};

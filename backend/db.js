const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// ВАЖНО: пул создаётся СИНХРОННО и экспортируется СИНХРОННО.
// Если экспортировать пул из async-функции / .then() / IIFE, то на момент
// `require('../db')` в роутерах окажется `undefined`, и любой вызов
// `db.query(...)` упадёт с невнятным:
//   TypeError: Cannot read properties of undefined (reading 'query')
// именно поэтому инициализация ниже сделана строго синхронной.
function createPool() {
    // Чтение ip.txt из корня проекта (на уровень выше текущего файла)
    const ipFilePath = path.join(__dirname, '..', 'ip.txt');

    if (!fs.existsSync(ipFilePath)) {
        throw new Error(`Файл конфигурации не найден по пути: ${ipFilePath}`);
    }

    const content = fs.readFileSync(ipFilePath, 'utf8').trim();

    // Парсинг строки вида: server=85.174.248.59;port=3307;uid=user1;...
    const config = {};
    content.split(';').forEach(pair => {
        const [key, value] = pair.split('=');
        if (key && value) {
            config[key.trim().toLowerCase()] = value.trim();
        }
    });

    // Поддерживаем варианты ключей из строки подключения .NET (десктоп):
    // server/host, uid/user/"user id", password/pwd
    const host = config.server || config.host;
    const user = config.uid || config.user || config['user id'];
    const password = config.password || config.pwd;
    const database = config.database;
    const port = parseInt(config.port, 10) || 3306;

    // Проверка обязательных параметров
    if (!host || !user || !password || !database) {
        throw new Error('Некорректный формат строки подключения в ip.txt');
    }

    // Создание пула подключений к MySQL
    const pool = mysql.createPool({
        host,
        port,
        user,
        password,
        database,
        waitForConnections: true,
        connectionLimit: 15,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000
    });

    console.log(`[БД] Пул подключений успешно инициализирован (${host}:${port})`);
    return pool;
}

let pool;

try {
    pool = createPool();
} catch (error) {
    // Без БД бэкенд работать не может. Падаем сразу с понятным сообщением —
    // это лучше, чем стартовать сервер и ловить непонятный TypeError в роутах.
    console.error('[Критическая ошибка БД]:', error.message);
    process.exit(1);
}

// Дополнительная страховка: модуль НИКОГДА не должен экспортировать undefined.
// (catch выше уже завершает процесс, но этот guard защищает от будущих правок.)
if (!pool || typeof pool.query !== 'function') {
    console.error('[Критическая ошибка БД]: пул подключений не инициализирован');
    process.exit(1);
}

module.exports = pool;

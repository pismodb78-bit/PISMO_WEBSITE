const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');

// ============================================================
//  Подключение к базе PISMO
//
//  Откуда берутся параметры (первое найденное побеждает):
//    1. Переменные окружения DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME —
//       так настроен сервис на VPS (см. README, файл /etc/pismo-web.env).
//    2. Файл ip.txt — путь из PISMO_IP_FILE, иначе корень проекта. Формат тот
//       же, что у ПК-клиента:
//         server=5.181.23.167;port=3307;uid=user1;pwd=...;database=bdauth
//       Пароль понимается и как password=, и как pwd= (так он записан у ПК),
//       лишние ключи (ws=, livekit=) не мешают.
//
//  Порт по умолчанию — 3307: на этом порту база слушает и на VPS, и на
//  старом сервере.
// ============================================================

function readIpFile() {
    const file = process.env.PISMO_IP_FILE || path.join(__dirname, '..', 'ip.txt');
    if (!fs.existsSync(file)) return { file, config: {} };

    const config = {};
    fs.readFileSync(file, 'utf8').trim().split(';').forEach(pair => {
        // Делим по ПЕРВОМУ «=»: в пароле и в адресах (ws=ws://…) он тоже бывает.
        const eq = pair.indexOf('=');
        if (eq <= 0) return;
        const key = pair.slice(0, eq).trim().toLowerCase();
        const value = pair.slice(eq + 1).trim();
        if (key && value) config[key] = value;
    });
    return { file, config };
}

let pool;

try {
    const { file, config } = readIpFile();
    const env = process.env;

    const host = env.DB_HOST || config.server || config.host;
    const port = parseInt(env.DB_PORT || config.port, 10) || 3307;
    const user = env.DB_USER || config.uid || config.user;
    const password = env.DB_PASSWORD ?? config.password ?? config.pwd;
    const database = env.DB_NAME || config.database || 'bdauth';

    if (!host || !user || password === undefined) {
        throw new Error(
            `Не заданы параметры базы: нужны DB_HOST/DB_USER/DB_PASSWORD или файл ${file}`);
    }

    pool = mysql.createPool({
        host,
        port,
        user,
        password,
        database,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0,
        enableKeepAlive: true,
        keepAliveInitialDelay: 10000
    });

    console.log(`[БД] Пул подключений успешно инициализирован (${host}:${port}/${database})`);
} catch (error) {
    console.error('[Критическая ошибка БД]:', error.message);
    process.exit(1);
}

module.exports = pool;

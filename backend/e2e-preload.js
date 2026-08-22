/** Подменяет базу: отдаёт текст БУФЕРОМ — тот случай, что ронял сайт. */
const db = require('./db');
const { enc } = require('./utils/crypto');
const passwords = require('./utils/passwords');

const HASH = passwords.hash('secret123');
const buf = (s) => Buffer.from(s, 'utf8');

db.columnExists = async () => true;
db.tableExists = async () => true;
db.exec = async () => 1;
db.scalar = async () => null;
db.scalarInt = async () => 0;
db.exists = async () => false;
db.ping = async () => '8.0-fake';

db.queryFirst = async (sql) => {
    if (/FROM users WHERE login=\?/i.test(sql)) {
        return { id: 1, Name: 'Пётр', Surname: 'Петров', role: 'teacher', password: HASH };
    }
    return null;
};

db.query = async (sql) => {
    if (/FROM users u\s*\n?\s*LEFT JOIN/i.test(sql) || /partner_id/i.test(sql)) {
        return [{
            id: 2, Name: buf('Анна'), Surname: buf('Смирнова'), login: 'asmirnova',
            last_time: Math.floor(Date.now() / 1000),
            last_msg: buf(enc('текст пришёл буфером')),   // ← то, что ломало React
            unread: 2,
        }];
    }
    if (/FROM group_chats/i.test(sql)) return [];
    if (/FROM servers s/i.test(sql)) return [];
    if (/FROM friends/i.test(sql)) return [];
    return [];
};

console.log('[тест] база подменена: текстовые колонки отдаются буфером');

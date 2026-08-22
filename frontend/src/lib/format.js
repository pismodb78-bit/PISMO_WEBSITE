/**
 * Те же правила отображения, что на ПК и Android: расхождение здесь
 * заметно сразу — время в ленте, статус в шапке, описание вложения.
 */

/** Область сообщения — числа совпадают с колонкой `scope` в базе. */
export const SCOPE = { DM: 0, GROUP: 1, SERVER: 2 };

export function formatTime(ms) {
    if (!ms) return '';
    return new Date(ms).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
}

export function formatDay(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const today = new Date();
    const yesterday = new Date(Date.now() - 86400000);
    const same = (a, b) => a.toDateString() === b.toDateString();
    if (same(d, today)) return 'Сегодня';
    if (same(d, yesterday)) return 'Вчера';
    return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
}

export function formatListTime(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    if (d.toDateString() === new Date().toDateString()) return formatTime(ms);
    return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' });
}

/**
 * Пороги присутствия обязаны совпадать с ПК (MainForm_Presence.cs):
 * «не в сети» при seen_ago > 40, «бездействует» при active_ago > 90.
 * Свои значения давали расхождение — телефон показывал человека в сети,
 * когда компьютер уже считал его офлайн.
 */
const SEEN_OFFLINE_SEC = 40;
const ACTIVE_IDLE_SEC = 90;

function humanDur(seconds) {
    if (seconds < 60) return 'меньше минуты';
    const m = Math.floor(seconds / 60);
    if (m < 60) return `${m} мин`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} ч`;
    return `${Math.floor(h / 24)} дн`;
}

function humanAgo(seconds) {
    if (seconds < 60) return 'только что';
    const m = Math.floor(seconds / 60);
    if (m < 60) return `${m} мин назад`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} ч назад`;
    return `${Math.floor(h / 24)} дн назад`;
}

export function presenceText(p) {
    if (!p) return '';
    if (p.seenAgoSec > SEEN_OFFLINE_SEC) return `был(а) в сети ${humanAgo(p.seenAgoSec)}`;
    if (p.activeAgoSec > ACTIVE_IDLE_SEC) return `бездействует ${humanDur(p.activeAgoSec)}`;
    return 'в сети';
}

export function presenceKind(p) {
    if (!p || p.seenAgoSec > SEEN_OFFLINE_SEC) return 'offline';
    if (p.activeAgoSec > ACTIVE_IDLE_SEC) return 'idle';
    return 'online';
}

const ARCHIVE = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'cab', 'iso']);
const DOCUMENT = new Set(['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'xls', 'xlsx', 'ods',
    'csv', 'ppt', 'pptx', 'odp', 'djvu', 'epub', 'fb2']);
const VIDEO = new Set(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'flv', 'm4v', '3gp']);
const AUDIO = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus', 'wma']);
const IMAGE = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'heic', 'heif', 'tiff', 'gif']);

export function fileExt(fileName) {
    const name = (fileName || '').trim();
    const dot = name.lastIndexOf('.');
    return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

export function fileIcon(fileName) {
    const ext = fileExt(fileName);
    if (ARCHIVE.has(ext)) return '🗜';
    if (DOCUMENT.has(ext)) return '📄';
    if (VIDEO.has(ext)) return '🎬';
    if (AUDIO.has(ext)) return '🎵';
    if (IMAGE.has(ext)) return '🖼';
    return '📎';
}

export function formatBytes(n) {
    if (!n) return '';
    if (n < 1024) return `${n} Б`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
    if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} МБ`;
    return `${(n / 1024 / 1024 / 1024).toFixed(1)} ГБ`;
}

/** Короткое описание последнего сообщения — как на ПК. */
export function describeMessage(m) {
    if (!m) return '';
    const isGif = /^gif:/i.test(m.text || '');
    if (m.hasAudio) return '🎤 Голосовое';
    if (m.hasVideo) return '⭕ Кружок';
    if (m.hasImage) return isGif ? '🎞 GIF' : '🖼 Фото';
    if (m.hasFile) return `${fileIcon(m.fileName)} ${m.fileName || 'Файл'}`;
    if (isGif) return '🎞 GIF';
    if ((m.text || '').trim()) return m.text;
    return '💬 Сообщение';
}

/** Цвет аватарки из имени — стабильный, чтобы человек «узнавался». */
const COLORS = ['#5865F2', '#57F287', '#FEE75C', '#EB459E', '#ED4245',
    '#3BA55D', '#FAA61A', '#9B59B6', '#1ABC9C', '#E67E22'];

export function colorFor(key) {
    const s = String(key || '');
    let hash = 0;
    for (let i = 0; i < s.length; i += 1) hash = (hash * 31 + s.charCodeAt(i)) | 0;
    return COLORS[Math.abs(hash) % COLORS.length];
}

export function initials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Разбивка текста на куски с подсветкой @упоминаний. */
export function splitMentions(text) {
    const out = [];
    const re = /@([^\s@]+)/g;
    let last = 0;
    let m = re.exec(text);
    while (m) {
        if (m.index > last) out.push({ mention: false, text: text.slice(last, m.index) });
        out.push({ mention: true, text: m[0] });
        last = m.index + m[0].length;
        m = re.exec(text);
    }
    if (last < text.length) out.push({ mention: false, text: text.slice(last) });
    return out;
}

/** Быстрые реакции — тот же набор, что в панели ПК-версии. */
export const QUICK_REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🔥', '🎉', '👎'];

/**
 * Мелкие правила отображения, общие с ПК и Android. Вынесены отдельно,
 * потому что расхождение здесь заметно сразу: имя в списке, текст
 * уведомления, подсветка упоминания.
 */

/** Собирает отображаемое имя: «Имя Фамилия», иначе логин (порт buildName). */
function buildName(name, surname, login) {
    const full = `${name ?? ''} ${surname ?? ''}`.trim();
    return full || (login ?? '');
}

// ── Короткое описание сообщения (порт MessagePreview.kt) ───────────────

const ARCHIVE = new Set(['zip', 'rar', '7z', 'tar', 'gz', 'bz2', 'xz', 'zst', 'cab', 'iso']);
const DOCUMENT = new Set(['pdf', 'doc', 'docx', 'odt', 'rtf', 'txt', 'xls', 'xlsx', 'ods',
    'csv', 'ppt', 'pptx', 'odp', 'djvu', 'epub', 'fb2']);
const VIDEO = new Set(['mp4', 'mkv', 'avi', 'mov', 'wmv', 'webm', 'flv', 'm4v', '3gp', 'mpg', 'mpeg']);
const AUDIO = new Set(['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'opus', 'wma']);
const IMAGE = new Set(['jpg', 'jpeg', 'png', 'webp', 'bmp', 'heic', 'heif', 'tiff']);

function fileExt(fileName) {
    const name = (fileName ?? '').trim();
    const dot = name.lastIndexOf('.');
    return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

/** Тип вложения по расширению. */
function describeFile(fileName) {
    const name = (fileName ?? '').trim();
    if (!name) return '📎 Файл';
    const ext = fileExt(name);
    let kind = '📎 Файл';
    if (ARCHIVE.has(ext)) kind = '🗜 Архив';
    else if (DOCUMENT.has(ext)) kind = '📄 Документ';
    else if (VIDEO.has(ext)) kind = '🎬 Видео';
    else if (AUDIO.has(ext)) kind = '🎵 Аудио';
    else if (IMAGE.has(ext)) kind = '🖼 Изображение';
    return `${kind} · ${name}`;
}

/**
 * Описание по флагам сообщения. Порядок проверок повторяет ПК:
 * голосовое → кружок → картинка → файл → текст.
 *
 * GIF узнаётся по префиксу «gif:» — так его помечает ПК при отправке;
 * расшифрованный текст общий для всех клиентов, менять нельзя.
 */
function describeMessage({ text = '', hasImage, hasAudio, hasVideo, hasFile, fileName }) {
    const isGif = /^gif:/i.test(text);
    if (hasAudio) return '🎤 Голосовое';
    if (hasVideo) return '⭕ Кружок';
    if (hasImage) return isGif ? '🎞 GIF' : '🖼 Фото';
    if (hasFile) return describeFile(fileName);
    if (isGif) return '🎞 GIF';
    if (text && text.trim()) return text;
    return '💬 Сообщение';
}

function withSender(sender, preview) {
    return sender && sender.trim() ? `${sender}: ${preview}` : preview;
}

// ── @упоминания (порт Mentions.kt) ─────────────────────────────────────

const ALL_TOKENS = new Set(['все', 'all', 'everyone', 'here', 'здесь']);
const MENTION_RE = /@([^\s@]+)/g;

/** Все токены после «@», в нижнем регистре, без хвостовой пунктуации. */
function mentionTokens(text) {
    if (!text || !text.includes('@')) return new Set();
    const out = new Set();
    for (const m of String(text).matchAll(MENTION_RE)) {
        const token = m[1].toLowerCase().replace(/^[.,!?:]+|[.,!?:]+$/g, '');
        if (token) out.add(token);
    }
    return out;
}

function mentionsEveryone(text) {
    for (const t of mentionTokens(text)) if (ALL_TOKENS.has(t)) return true;
    return false;
}

/** Упоминают ли здесь меня. Пустые login/role просто не срабатывают. */
function mentionsMe(text, myLogin, myRoleName) {
    const t = mentionTokens(text);
    if (t.size === 0) return false;
    for (const token of t) if (ALL_TOKENS.has(token)) return true;
    if (myLogin && t.has(String(myLogin).toLowerCase())) return true;
    if (myRoleName && t.has(String(myRoleName).toLowerCase())) return true;
    return false;
}

module.exports = {
    buildName,
    fileExt,
    describeFile,
    describeMessage,
    withSender,
    mentionTokens,
    mentionsEveryone,
    mentionsMe,
    ALL_TOKENS,
};

/**
 * Уведомления, звук и счётчик во вкладке — веб-замена трею ПК-версии и
 * шторке Android.
 *
 * ПРО ЗАЩИЩЁННЫЙ КОНТЕКСТ. Notification API, как и микрофон, работает
 * только по https или с localhost. На http по IP разрешение просто не
 * выдаётся. Поэтому уведомления здесь необязательны: если их нет, остаются
 * звук и счётчик в заголовке вкладки — они работают везде, и человек всё
 * равно видит, что пришло новое.
 */

const BASE_TITLE = 'PISMO';

export function notificationsSupported() {
    return typeof window !== 'undefined' && 'Notification' in window;
}

export function notificationsAllowed() {
    return notificationsSupported() && Notification.permission === 'granted';
}

/** Можно ли вообще просить разрешение (в незащищённом контексте — нельзя). */
export function canAskPermission() {
    return notificationsSupported()
        && window.isSecureContext
        && Notification.permission === 'default';
}

export async function ensurePermission() {
    if (!canAskPermission()) return notificationsAllowed();
    try {
        const result = await Notification.requestPermission();
        return result === 'granted';
    } catch (_) {
        return false;
    }
}

/**
 * Показывает уведомление. tag заменяет предыдущее с тем же ярлыком —
 * так десять сообщений из одного чата не превращаются в десять карточек,
 * ровно как на Android, где уведомление на диалог одно.
 */
export function notify({ title, body, tag, onClick }) {
    if (!notificationsAllowed()) return null;
    try {
        const n = new Notification(title, {
            body,
            tag,
            renotify: false,
            silent: true,   // звук играем сами, чтобы он был одинаковым везде
        });
        n.onclick = () => {
            window.focus();
            n.close();
            if (onClick) onClick();
        };
        return n;
    } catch (_) {
        return null;
    }
}

// ── Звук ───────────────────────────────────────────────────────────────

let audioCtx = null;

/**
 * Короткий сигнал через WebAudio.
 *
 * Синтезируем, а не возим файл: звук нужен на полсекунды, а лишний
 * бинарник в сборке пришлось бы ещё и отдавать отдельным запросом.
 * Браузеры не дают играть до первого действия человека — до входа в
 * аккаунт это и не нужно.
 */
function beep(frequencies, duration = 0.12) {
    try {
        if (!audioCtx) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            audioCtx = new Ctx();
        }
        if (audioCtx.state === 'suspended') audioCtx.resume();

        frequencies.forEach((freq, i) => {
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            const at = audioCtx.currentTime + i * duration;

            osc.type = 'sine';
            osc.frequency.value = freq;
            // Плавные фронты: резкий старт и обрыв дают щелчок.
            gain.gain.setValueAtTime(0, at);
            gain.gain.linearRampToValueAtTime(0.13, at + 0.012);
            gain.gain.exponentialRampToValueAtTime(0.0001, at + duration);

            osc.connect(gain).connect(audioCtx.destination);
            osc.start(at);
            osc.stop(at + duration);
        });
    } catch (_) { /* звук — не то, ради чего стоит падать */ }
}

export const sounds = {
    message: () => beep([880, 1170]),
    mention: () => beep([1170, 1470, 1170]),
    call: () => beep([740, 990, 740, 990], 0.18),
};

// ── Счётчик во вкладке ─────────────────────────────────────────────────

/**
 * Число непрочитанных в заголовке — то же, что мигание окна и цифра на
 * значке в ПК-версии. Работает в любом контексте, в отличие от уведомлений.
 */
export function setTitleBadge(count) {
    document.title = count > 0 ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
}

/** Смотрит ли человек сейчас на вкладку. */
export function windowFocused() {
    return document.visibilityState === 'visible' && document.hasFocus();
}

/**
 * Доступность микрофона и камеры в браузере.
 *
 * ГЛАВНОЕ, ЧТО НУЖНО ЗНАТЬ. Браузеры отдают микрофон, камеру и
 * демонстрацию экрана только в «защищённом контексте»: это https либо
 * localhost. На обычном http по IP — например, http://192.168.0.10:5000 —
 * объекта navigator.mediaDevices НЕ СУЩЕСТВУЕТ вовсе.
 *
 * Отсюда две неочевидные вещи, на которых легко потерять вечер:
 *
 *  1. Ошибка выглядит как «Cannot read properties of undefined (reading
 *     'getUserMedia')» — то есть как ошибка в коде сайта, хотя дело в
 *     адресе, по которому он открыт.
 *  2. В настройках сайта камера и микрофон показаны серыми с подписью
 *     «Заблокировано в целях безопасности». Это НЕ разрешение, которое
 *     можно выдать: самого интерфейса запроса в незащищённом контексте
 *     нет. Нажимать там нечего.
 *
 * Поэтому проверяем заранее и объясняем словами, а не даём человеку
 * упереться в текст про undefined.
 */

/** Есть ли вообще доступ к устройствам захвата. */
export function mediaAvailable() {
    return Boolean(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

/** Защищённый контекст: https или localhost. */
export function secureContext() {
    return Boolean(window.isSecureContext);
}

/** Смешанное содержимое: страница по https, а LiveKit по ws://. */
export function mixedContentRisk(livekitUrl) {
    return window.location.protocol === 'https:' && /^ws:\/\//i.test(livekitUrl || '');
}

/**
 * Почему звонки недоступны — текстом, который можно показать человеку.
 * null означает «всё в порядке».
 */
export function callBlockReason() {
    if (mediaAvailable()) return null;

    if (!secureContext()) {
        const host = window.location.hostname;
        return {
            short: 'Звонки недоступны по этому адресу',
            full: `Браузер отдаёт микрофон и камеру только по https или с localhost, `
                + `а сайт открыт как http://${host}. В настройках сайта камера и микрофон `
                + `показаны серыми — выдать их там нельзя, интерфейса запроса просто нет.`,
            fixes: [
                'На самом сервере откройте http://localhost:5000 — localhost считается защищённым.',
                'Для доступа по сети поднимите сайт по https (SSL_KEY и SSL_CERT — см. README).',
                `Разово для проверки: в Chrome или Opera включите флаг `
                    + `unsafely-treat-insecure-origin-as-secure и впишите туда `
                    + `${window.location.origin}.`,
            ],
        };
    }

    return {
        short: 'Браузер не даёт доступ к микрофону',
        full: 'Проверьте, не запрещён ли микрофон для этого сайта в настройках браузера, '
            + 'и не занят ли он другим приложением.',
        fixes: [],
    };
}

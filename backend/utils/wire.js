/**
 * Подготовка данных к отправке в браузер.
 *
 * ЗАЧЕМ ЭТО ЕСТЬ. socket.io умеет передавать двоичные данные и на стороне
 * браузера отдаёт их как ArrayBuffer. Для React это не текст и не элемент —
 * он падает с «Objects are not valid as a React child» и гасит весь экран,
 * а сообщение об ошибке в собранной версии сводится к номеру.
 *
 * Один такой буфер уже стоил сайту работоспособности: драйвер отдавал
 * колонку TEXT байтами (у TEXT и BLOB совпадает код типа), и текст
 * сообщения долетал до браузера буфером. Причину чинили в двух местах, но
 * сам класс ошибки оставался открытым: любая новая колонка или новый
 * запрос мог принести буфер снова, и падало бы так же молча.
 *
 * Здесь этот класс закрывается целиком: наружу через сокет уходит только
 * то, что React умеет отрисовать. Двоичные данные сокетом и не ходят —
 * вложения отдаёт HTTP-роут /api/media, — поэтому терять нечего.
 */

/** Байты, пришедшие из базы, — это всегда текст в utf8. */
function bytesToText(value) {
    return Buffer.isBuffer(value)
        ? value.toString('utf8')
        : Buffer.from(value.buffer ?? value, value.byteOffset ?? 0, value.byteLength ?? value.length)
            .toString('utf8');
}

/**
 * Рекурсивно приводит payload к «отрисовываемому» виду.
 *
 * Глубина ограничена: ответы здесь — плоские списки сообщений и участников,
 * а неограниченный обход на кольцевой ссылке ушёл бы в бесконечность.
 */
function toWire(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (depth > 12) return value;

    if (Buffer.isBuffer(value) || ArrayBuffer.isView(value)) return bytesToText(value);
    if (value instanceof ArrayBuffer) return Buffer.from(value).toString('utf8');

    if (Array.isArray(value)) return value.map((v) => toWire(v, depth + 1));

    // Даты и прочие «непростые» объекты оставляем как есть: socket.io
    // сериализует их сам, и React с ними не встречается.
    if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = toWire(v, depth + 1);
        return out;
    }

    return value;
}

module.exports = { toWire };

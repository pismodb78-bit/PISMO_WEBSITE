/**
 * Область сообщения. Числа обязаны совпадать с ПК и Android: это колонка
 * `scope` в message_reactions, pinned_messages и message_edits, общая для
 * всех трёх видов переписки.
 */
const SCOPE = { DM: 0, GROUP: 1, SERVER: 2 };

const TABLES = {
    [SCOPE.DM]: 'messages',
    [SCOPE.GROUP]: 'group_messages',
    [SCOPE.SERVER]: 'server_messages',
};

/** Таблица по номеру области. Неизвестное значение трактуем как ЛС (как Scope.of). */
function tableOf(scope) {
    return TABLES[Number(scope)] ?? TABLES[SCOPE.DM];
}

function normalizeScope(scope) {
    const n = Number(scope);
    return n === SCOPE.GROUP || n === SCOPE.SERVER ? n : SCOPE.DM;
}

module.exports = { SCOPE, TABLES, tableOf, normalizeScope };

import React from 'react';
import { colorFor, initials } from '../lib/format';

/**
 * Плашка входящего вызова.
 *
 * ЖИВЁТ ОТДЕЛЬНО ОТ Call.jsx НАМЕРЕННО. Раньше она лежала там же и потому
 * тянула за собой SDK LiveKit — полмегабайта ради двух кнопок. Хуже, чем
 * лишний вес: пока SDK не загрузился (или не установлен вовсе), отрисовка
 * плашки роняла всё приложение. Опрос входящих идёт раз в четыре секунды,
 * так что достаточно одной строки со статусом ringing в call_sessions —
 * и сайт гас через несколько секунд после входа.
 *
 * Здесь нет ни одного импорта из livekit-client, и это условие: плашка
 * обязана рисоваться независимо от того, доступен SDK или нет. Тяжёлое
 * окно звонка подгружается уже после того, как человек нажал «Принять».
 */
export default function IncomingCall({ call, onAccept, onDecline }) {
    return (
        <div className="incoming">
            <div className="row">
                <div className="avatar" style={{ background: colorFor(call.callerName) }}>
                    {initials(call.callerName)}
                </div>
                <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{call.callerName}</div>
                    <div className="faint" style={{ fontSize: 12 }}>
                        {call.groupId ? 'Групповой звонок' : 'Входящий звонок'}
                        {call.hasVideo ? ' · видео' : ''}
                    </div>
                </div>
            </div>
            <div className="row" style={{ marginTop: 14 }}>
                <button className="btn" style={{ flex: 1 }} onClick={() => onAccept(call)}>Принять</button>
                <button className="btn btn-danger" style={{ flex: 1 }} onClick={() => onDecline(call)}>
                    Отклонить
                </button>
            </div>
        </div>
    );
}

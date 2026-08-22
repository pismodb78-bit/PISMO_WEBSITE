import React from 'react';
import { Avatar } from './Common';
import { mediaUrl } from '../lib/api';
import {
    SCOPE, formatTime, fileIcon, splitMentions, QUICK_REACTIONS,
} from '../lib/format';

/** Текст с подсветкой @упоминаний. */
function Text({ value }) {
    return (
        <span>
            {splitMentions(value).map((part, i) => (
                part.mention
                    ? <span className="mention" key={i}>{part.text}</span>
                    : <React.Fragment key={i}>{part.text}</React.Fragment>
            ))}
        </span>
    );
}

/**
 * Вложения.
 *
 * Байты сюда не приходят — только флаги: сама лента их не тянет, иначе
 * каждое обновление поднимало бы с диска все картинки страницы (ровно эту
 * жалобу чинили на ПК). Ссылка ведёт на /api/media, браузер тянет и кеширует
 * сам.
 */
function Attachments({ msg, onZoom }) {
    const url = (kind) => mediaUrl(msg.scope, msg.id, kind);

    return (
        <>
            {msg.hasImage && (
                <img
                    className="attach-img"
                    src={url('image')}
                    alt={msg.fileName || 'изображение'}
                    loading="lazy"
                    onClick={() => onZoom(url('image'))}
                />
            )}

            {msg.hasAudio && (
                // Голосовые пишутся в WAV 16 кГц моно — то, что умеет NAudio
                // на ПК; браузер играет их без конвертации.
                <audio className="attach-audio" controls preload="none" src={url('audio')} />
            )}

            {msg.hasVideo && (
                // Видео-кружочки лежат в контейнере PSMOVID1 — браузер такой
                // не проиграет, поэтому предлагаем скачать, а не молча
                // показываем сломанный плеер.
                <a className="attach-file" href={url('video')} download>
                    <span className="attach-file-icon">⭕</span>
                    <span>
                        <div className="attach-file-name">Видео-кружок</div>
                        <div className="faint" style={{ fontSize: 12 }}>
                            записан в приложении · скачать
                        </div>
                    </span>
                </a>
            )}

            {msg.hasFile && (
                <a className="attach-file" href={url('file')} download={msg.fileName || undefined}>
                    <span className="attach-file-icon">{fileIcon(msg.fileName)}</span>
                    <span style={{ minWidth: 0 }}>
                        <div className="attach-file-name">{msg.fileName || 'Файл'}</div>
                        <div className="faint" style={{ fontSize: 12 }}>Нажмите, чтобы скачать</div>
                    </span>
                </a>
            )}
        </>
    );
}

export default function Message({
    msg, prev, meId, myLogin, myRole, quote,
    onReply, onEdit, onDelete, onReact, onPin, onZoom, canModerate,
}) {
    const [picking, setPicking] = React.useState(false);

    // Подряд идущие сообщения одного автора склеиваем — как в ПК-версии.
    const continued = prev
        && prev.senderId === msg.senderId
        && !prev.isDeleted && !msg.isDeleted
        && msg.createdAtMs - prev.createdAtMs < 5 * 60 * 1000;

    const mine = msg.senderId === meId;

    // Подсветка «меня упомянули» — правило MentionsMe с ПК: @логин,
    // @название-роли и общие @все/@all/@everyone.
    const mentionsMe = React.useMemo(() => {
        const text = (msg.text || '').toLowerCase();
        if (!text.includes('@') || mine) return false;
        if (/@(все|all|everyone|here|здесь)\b/.test(text)) return true;
        if (myLogin && text.includes(`@${myLogin.toLowerCase()}`)) return true;
        if (myRole && text.includes(`@${myRole.toLowerCase()}`)) return true;
        return false;
    }, [msg.text, myLogin, myRole, mine]);

    const isGif = /^gif:/i.test(msg.text || '');
    const visibleText = isGif ? '' : (msg.text || '');

    return (
        <div className={`msg ${continued ? 'msg-continued' : ''} ${mentionsMe ? 'mention-me' : ''}`}>
            {!continued && <Avatar userId={msg.senderId} name={msg.senderName} hideDot />}

            <div className="msg-body">
                {!continued && (
                    <div className="msg-head">
                        <span className="msg-author">{msg.senderName}</span>
                        <span className="msg-time">{formatTime(msg.createdAtMs)}</span>
                        {msg.isPinned && <span className="msg-time" title="Закреплено">📌</span>}
                    </div>
                )}

                {quote && (
                    <div className="reply-quote">
                        <b>{quote.sender}</b>: {quote.text || 'вложение'}
                    </div>
                )}

                {msg.isDeleted ? (
                    <div className="msg-text msg-deleted">сообщение удалено</div>
                ) : (
                    <>
                        {visibleText && (
                            <div className="msg-text">
                                <Text value={visibleText} />
                                {msg.isEdited && <span className="msg-edited">(изменено)</span>}
                            </div>
                        )}
                        <Attachments msg={msg} onZoom={onZoom} />
                    </>
                )}

                {msg.reactions?.length > 0 && (
                    <div className="reactions">
                        {msg.reactions.map((r) => (
                            <button
                                key={r.emoji}
                                className={`reaction ${r.mine ? 'mine' : ''}`}
                                onClick={() => onReact(msg, r.emoji)}
                                title={r.mine ? 'Убрать реакцию' : 'Поставить реакцию'}
                            >
                                <span>{r.emoji}</span>
                                <span className="reaction-count">{r.count}</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>

            {!msg.isDeleted && (
                <div className="msg-actions">
                    <button title="Реакция" onClick={() => setPicking((v) => !v)}>😊</button>
                    <button title="Ответить" onClick={() => onReply(msg)}>↩</button>
                    {msg.scope !== SCOPE.SERVER && (
                        <button title={msg.isPinned ? 'Открепить' : 'Закрепить'} onClick={() => onPin(msg)}>📌</button>
                    )}
                    {mine && !msg.hasImage && !msg.hasAudio && !msg.hasFile && (
                        <button title="Изменить" onClick={() => onEdit(msg)}>✎</button>
                    )}
                    {(mine || canModerate) && (
                        <button title="Удалить" onClick={() => onDelete(msg)}>🗑</button>
                    )}
                </div>
            )}

            {picking && (
                <div className="emoji-pick" onMouseLeave={() => setPicking(false)}>
                    {QUICK_REACTIONS.map((e) => (
                        <button key={e} onClick={() => { onReact(msg, e); setPicking(false); }}>{e}</button>
                    ))}
                </div>
            )}
        </div>
    );
}

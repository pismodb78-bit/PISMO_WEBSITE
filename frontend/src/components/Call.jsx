import React from 'react';
import { Room, RoomEvent, Track } from 'livekit-client';
import { socket, ask } from '../lib/socket';
import { colorFor, initials } from '../lib/format';

/**
 * Окно звонка. Медиа идёт напрямую в LiveKit, минуя наш бэкенд —
 * он только выдал токен.
 *
 * ЗНАЧКИ МЬЮТА. ПК читает атрибуты участника: `mic` и `deaf`, где
 * **`mic` = "1" означает, что микрофон ВКЛЮЧЁН** (инверсия неочевидна, но
 * менять её нельзя — иначе на компьютере у всех с сайта будет висеть
 * перечёркнутый микрофон). В базе при этом хранится обратное по смыслу
 * `mic_muted`, поэтому в voice:state уходит именно micMuted.
 */
function Tile({ participant, name }) {
    const videoRef = React.useRef(null);
    const audioRef = React.useRef(null);
    const [speaking, setSpeaking] = React.useState(false);
    const [hasVideo, setHasVideo] = React.useState(false);

    React.useEffect(() => {
        if (!participant) return undefined;

        const attach = () => {
            const cam = participant.getTrackPublication(Track.Source.Camera)
                || participant.getTrackPublication(Track.Source.ScreenShare);
            if (cam?.track && videoRef.current) {
                cam.track.attach(videoRef.current);
                setHasVideo(true);
            } else {
                setHasVideo(false);
            }
            const mic = participant.getTrackPublication(Track.Source.Microphone);
            // Свой звук не воспроизводим — иначе эхо в наушниках.
            if (mic?.track && audioRef.current && !participant.isLocal) {
                mic.track.attach(audioRef.current);
            }
        };

        attach();
        const onSpeak = () => setSpeaking(participant.isSpeaking);
        participant.on('trackSubscribed', attach);
        participant.on('trackUnsubscribed', attach);
        participant.on('trackPublished', attach);
        participant.on('trackMuted', attach);
        participant.on('trackUnmuted', attach);
        participant.on('isSpeakingChanged', onSpeak);

        return () => {
            participant.off('trackSubscribed', attach);
            participant.off('trackUnsubscribed', attach);
            participant.off('trackPublished', attach);
            participant.off('trackMuted', attach);
            participant.off('trackUnmuted', attach);
            participant.off('isSpeakingChanged', onSpeak);
        };
    }, [participant]);

    const attrs = participant?.attributes || {};
    const micOn = attrs.mic !== '0';       // "1" = микрофон включён
    const deafened = attrs.deaf === '1';

    return (
        <div className={`tile ${speaking ? 'speaking' : ''}`}>
            <video ref={videoRef} autoPlay playsInline muted={participant?.isLocal}
                style={{ display: hasVideo ? 'block' : 'none' }} />
            <audio ref={audioRef} autoPlay />
            {!hasVideo && (
                <div className="avatar avatar-lg" style={{ background: colorFor(name) }}>
                    {initials(name)}
                </div>
            )}
            <div className="tile-label">
                <span>{name}</span>
                {!micOn && <span title="Микрофон выключен">🔇</span>}
                {deafened && <span title="Звук выключен">🎧</span>}
            </div>
        </div>
    );
}

export default function Call({ session, meId, meName, onClose }) {
    const [room, setRoom] = React.useState(null);
    const [participants, setParticipants] = React.useState([]);
    const [micOn, setMicOn] = React.useState(true);
    const [camOn, setCamOn] = React.useState(false);
    const [screenOn, setScreenOn] = React.useState(false);
    const [deafened, setDeafened] = React.useState(false);
    const [error, setError] = React.useState('');
    const [status, setStatus] = React.useState('Подключение…');

    // ── Подключение ───────────────────────────────────────────────────

    React.useEffect(() => {
        let active = true;
        const r = new Room({ adaptiveStream: true, dynacast: true });

        const refresh = () => {
            if (!active) return;
            setParticipants([r.localParticipant, ...Array.from(r.remoteParticipants.values())]);
        };

        r.on(RoomEvent.ParticipantConnected, refresh);
        r.on(RoomEvent.ParticipantDisconnected, refresh);
        r.on(RoomEvent.TrackSubscribed, refresh);
        r.on(RoomEvent.TrackUnsubscribed, refresh);
        r.on(RoomEvent.ParticipantAttributesChanged, refresh);
        r.on(RoomEvent.Disconnected, () => { if (active) onClose(); });

        (async () => {
            try {
                await r.connect(session.url, session.token);
                if (!active) { r.disconnect(); return; }

                await r.localParticipant.setMicrophoneEnabled(true);
                if (session.hasVideo) {
                    await r.localParticipant.setCameraEnabled(true).catch(() => {});
                    setCamOn(true);
                }
                // Атрибуты выставляем сразу: ПК рисует значки по ним, и без
                // первой установки участник висит «непонятно в каком» состоянии.
                await r.localParticipant.setAttributes({ mic: '1', deaf: '0' }).catch(() => {});

                setRoom(r);
                setStatus('');
                refresh();
            } catch (err) {
                if (active) {
                    setError(
                        `${err.message}. Проверьте доступ к микрофону; `
                        + 'если сайт открыт по https, адрес LiveKit должен быть wss://',
                    );
                    setStatus('');
                }
            }
        })();

        return () => {
            active = false;
            r.disconnect().catch(() => {});
        };
    }, [session.url, session.token, session.hasVideo, onClose]);

    // Голосовому каналу отмечаемся в voice_presence, чтобы ПК и телефон
    // видели, кто сидит в канале. Запись живёт 20 секунд — отсюда такт.
    React.useEffect(() => {
        if (!session.channelId) return undefined;
        const beat = () => socket.emit('voice:state', {
            channelId: session.channelId,
            streaming: screenOn || camOn,
            micMuted: !micOn,
            deafened,
        });
        beat();
        const t = setInterval(beat, 8000);
        return () => clearInterval(t);
    }, [session.channelId, micOn, camOn, screenOn, deafened]);

    // ── Управление ────────────────────────────────────────────────────

    async function toggleMic() {
        if (!room) return;
        const next = !micOn;
        await room.localParticipant.setMicrophoneEnabled(next);
        // "1" = включён. Инверсия относительно mic_muted в базе намеренная.
        await room.localParticipant.setAttributes({
            mic: next ? '1' : '0', deaf: deafened ? '1' : '0',
        }).catch(() => {});
        setMicOn(next);
    }

    async function toggleCam() {
        if (!room) return;
        const next = !camOn;
        await room.localParticipant.setCameraEnabled(next).catch(() => {});
        setCamOn(next);
    }

    async function toggleScreen() {
        if (!room) return;
        const next = !screenOn;
        await room.localParticipant.setScreenShareEnabled(next).catch((e) => setError(e.message));
        setScreenOn(next);
    }

    async function toggleDeaf() {
        if (!room) return;
        const next = !deafened;
        // Заглушаем всё входящее разом.
        room.remoteParticipants.forEach((p) => {
            p.trackPublications.forEach((pub) => {
                if (pub.track?.kind === 'audio') pub.track.setMuted?.(next);
            });
        });
        room.remoteParticipants.forEach((p) => p.setVolume?.(next ? 0 : 1));
        await room.localParticipant.setAttributes({
            mic: micOn ? '1' : '0', deaf: next ? '1' : '0',
        }).catch(() => {});
        setDeafened(next);
    }

    async function hangup() {
        try {
            if (session.channelId) await ask('voice:leave', { channelId: session.channelId });
            else if (session.callId) await ask('call:leave', { callId: session.callId });
        } catch (_) { /* закрываем окно в любом случае */ }
        onClose();
    }

    return (
        <div className="call-overlay">
            <div className="call-head">
                <b>{session.title || 'Звонок'}</b>
                <span className="dim">{status}</span>
                <div className="spacer" />
                <span className="dim">{participants.length} в звонке</span>
            </div>

            {error && <div className="conn-banner">{error}</div>}

            <div className="call-grid">
                {participants.map((p) => (
                    <Tile
                        key={p.sid || p.identity}
                        participant={p}
                        name={p.isLocal ? `${meName} (вы)` : (p.name || p.identity)}
                    />
                ))}
                {participants.length === 0 && !error && (
                    <div className="empty">Ждём участников…</div>
                )}
            </div>

            <div className="call-bar">
                <button className={`call-btn ${micOn ? '' : 'off'}`} onClick={toggleMic} title="Микрофон">
                    {micOn ? '🎤' : '🔇'}
                </button>
                <button className={`call-btn ${camOn ? 'off' : ''}`} onClick={toggleCam} title="Камера">
                    📹
                </button>
                <button className={`call-btn ${screenOn ? 'off' : ''}`} onClick={toggleScreen} title="Демонстрация экрана">
                    🖥
                </button>
                <button className={`call-btn ${deafened ? 'off' : ''}`} onClick={toggleDeaf} title="Звук">
                    {deafened ? '🔕' : '🎧'}
                </button>
                <button className="call-btn hangup" onClick={hangup} title="Завершить">📞</button>
            </div>
        </div>
    );
}

/** Плашка входящего вызова. */
export function IncomingCall({ call, onAccept, onDecline }) {
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

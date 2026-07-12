import { useCall } from "../../../context/CallContext";
import ParticipantTile from './ParticipantTile';
import './Call.css';

export default function CallWindow() {
    const { activeCall, participants, micOn, camOn, connecting, leaveCall, toggleMic, toggleCam, toggleScreenShare } = useCall();

    if (!activeCall) return null;

    return (
        <div className="call-overlay">
            <div className="call-window">
                {connecting ? (
                    <div className="call-connecting">Подключение…</div>
                ) : (
                    <div className={`participants-grid grid-${Math.min(participants.length, 9)}`}>
                        {participants.map((p) => (
                            <ParticipantTile key={p.identity} participant={p} />
                        ))}
                    </div>
                )}

                <div className="call-controls">
                    <button
                        className={`call-control-btn ${micOn ? '' : 'off'}`}
                        onClick={toggleMic}
                        title={micOn ? 'Выключить микрофон' : 'Включить микрофон'}
                    >
                        {micOn ? '🎙️' : '🔇'}
                    </button>
                    <button
                        className={`call-control-btn ${camOn ? '' : 'off'}`}
                        onClick={toggleCam}
                        title={camOn ? 'Выключить камеру' : 'Включить камеру'}
                    >
                        {camOn ? '📹' : '📷'}
                    </button>
                    <button className="call-control-btn" onClick={toggleScreenShare} title="Демонстрация экрана">
                        🖥️
                    </button>
                    <button className="call-control-btn leave" onClick={leaveCall} title="Завершить звонок">
                        📞
                    </button>
                </div>
            </div>
        </div>
    );
}

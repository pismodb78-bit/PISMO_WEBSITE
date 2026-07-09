import { useCall } from "../../../context/CallContext";
import './Call.css';

export default function IncomingCallModal() {
    const { incomingCall, acceptCall, declineCall } = useCall();
    if (!incomingCall) return null;

    const { callerName, isGroup, hasVideo } = incomingCall;

    return (
        <div className="call-overlay">
            <div className="incoming-card">
                <div className="incoming-avatar">{(callerName || '?').charAt(0).toUpperCase()}</div>
                <div className="incoming-title">{callerName}</div>
                <div className="incoming-subtitle">
                    {isGroup ? 'Групповой звонок' : hasVideo ? 'Видеозвонок' : 'Аудиозвонок'}
                </div>
                <div className="incoming-actions">
                    <button className="call-btn call-btn-decline" onClick={declineCall} title="Отклонить">
                        ✕
                    </button>
                    <button className="call-btn call-btn-accept" onClick={acceptCall} title="Принять">
                        ✓
                    </button>
                </div>
            </div>
        </div>
    );
}

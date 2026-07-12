import { useEffect, useRef } from 'react';

export default function ParticipantTile({ participant }) {
    const videoRef = useRef(null);
    const audioRef = useRef(null);

    useEffect(() => {
        const el = videoRef.current;
        const track = participant.videoTrack;
        if (track && el) {
            track.attach(el);
            return () => track.detach(el);
        }
    }, [participant.videoTrack]);

    useEffect(() => {
        const el = audioRef.current;
        const track = participant.audioTrack;
        // Свой собственный звук не воспроизводим самому себе — иначе эхо
        if (track && el && !participant.isLocal) {
            track.attach(el);
            return () => track.detach(el);
        }
    }, [participant.audioTrack, participant.isLocal]);

    const hasVideo = !!participant.videoTrack && participant.camOn;

    return (
        <div className={`participant-tile ${participant.isSpeaking ? 'speaking' : ''}`}>
            {hasVideo ? (
                <video ref={videoRef} autoPlay playsInline muted={participant.isLocal} />
            ) : (
                <div className="participant-avatar-fallback">
                    {(participant.name || '?').charAt(0).toUpperCase()}
                </div>
            )}
            <audio ref={audioRef} autoPlay />
            <div className="participant-label">
                {participant.name}{participant.isLocal ? ' (вы)' : ''}
                {!participant.micOn && <span className="mic-off-icon"> 🔇</span>}
            </div>
        </div>
    );
}

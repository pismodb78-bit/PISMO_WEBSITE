import React, { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react';
import { Room, RoomEvent } from 'livekit-client';
import { socket } from "../socket";

const CallContext = createContext(null);

export function useCall() {
    const ctx = useContext(CallContext);
    if (!ctx) throw new Error('useCall должен использоваться внутри <CallProvider>');
    return ctx;
}

export function CallProvider({ children }) {
    const [incomingCall, setIncomingCall] = useState(null);
    const [activeCall, setActiveCall] = useState(null);
    const [participants, setParticipants] = useState([]);
    const [micOn, setMicOn] = useState(true);
    const [camOn, setCamOn] = useState(false);
    const [screenOn, setScreenOn] = useState(false);
    const [connecting, setConnecting] = useState(false);
    const roomRef = useRef(null);

    const rebuildParticipants = useCallback((room) => {
        const list = [];
        const local = room.localParticipant;
        list.push({
            identity: local.identity,
            name: local.name || local.identity,
            isLocal: true,
            videoTrack: [...local.videoTrackPublications.values()][0]?.track,
            audioTrack: [...local.audioTrackPublications.values()][0]?.track,
            isSpeaking: local.isSpeaking,
            micOn: local.isMicrophoneEnabled,
            camOn: local.isCameraEnabled
        });
        room.remoteParticipants.forEach((p) => {
            list.push({
                identity: p.identity,
                name: p.name || p.identity,
                isLocal: false,
                videoTrack: [...p.videoTrackPublications.values()][0]?.track,
                audioTrack: [...p.audioTrackPublications.values()][0]?.track,
                isSpeaking: p.isSpeaking,
                micOn: p.isMicrophoneEnabled,
                camOn: p.isCameraEnabled
            });
        });
        setParticipants(list);
    }, []);

    const connectToRoom = useCallback(async ({ callId, roomName, token, livekitUrl, isGroup, wantVideo }) => {
        setConnecting(true);
        const room = new Room({ adaptiveStream: true, dynacast: true });
        roomRef.current = room;

        const refresh = () => rebuildParticipants(room);
        room
            .on(RoomEvent.ParticipantConnected, refresh)
            .on(RoomEvent.ParticipantDisconnected, refresh)
            .on(RoomEvent.TrackSubscribed, refresh)
            .on(RoomEvent.TrackUnsubscribed, refresh)
            .on(RoomEvent.ActiveSpeakersChanged, refresh)
            .on(RoomEvent.Disconnected, () => {
                setActiveCall(null);
                setParticipants([]);
                roomRef.current = null;
            });

        await room.connect(livekitUrl, token);
        await room.localParticipant.setMicrophoneEnabled(true);
        setMicOn(true);
        if (wantVideo) {
            await room.localParticipant.setCameraEnabled(true);
            setCamOn(true);
        }
        refresh();
        setActiveCall({ callId, roomName, isGroup });
        setConnecting(false);
    }, [rebuildParticipants]);

    const startCall = useCallback(({ calleeId, groupId, hasVideo }) => {
        socket.emit('call:invite', { calleeId, groupId, hasVideo }, async (res) => {
            if (!res?.ok) return alert('Ошибка вызова: ' + (res?.error || 'неизвестно'));
            await connectToRoom({ ...res, isGroup: !!groupId, wantVideo: hasVideo });
        });
    }, [connectToRoom]);

    const acceptCall = useCallback(() => {
        if (!incomingCall) return;
        const { callId, hasVideo, isGroup } = incomingCall;
        socket.emit('call:accept', { callId }, async (res) => {
            setIncomingCall(null);
            if (!res?.ok) return alert('Ошибка подключения');
            await connectToRoom({ ...res, isGroup, wantVideo: hasVideo });
        });
    }, [incomingCall, connectToRoom]);

    const declineCall = useCallback(() => {
        if (incomingCall) socket.emit('call:decline', { callId: incomingCall.callId });
        setIncomingCall(null);
    }, [incomingCall]);

    const leaveCall = useCallback(() => {
        if (activeCall) socket.emit('call:leave', { callId: activeCall.callId });
        roomRef.current?.disconnect();
    }, [activeCall]);

    const toggleMic = useCallback(async () => {
        const room = roomRef.current;
        if (!room) return;
        const next = !micOn;
        await room.localParticipant.setMicrophoneEnabled(next);
        setMicOn(next);
    }, [micOn]);

    const toggleCam = useCallback(async () => {
        const room = roomRef.current;
        if (!room) return;
        const next = !camOn;
        await room.localParticipant.setCameraEnabled(next);
        setCamOn(next);
    }, [camOn]);

    const toggleScreenShare = useCallback(async () => {
        const room = roomRef.current;
        if (!room) return;
        const next = !screenOn;
        try {
            await room.localParticipant.setScreenShareEnabled(next);
            setScreenOn(next);
        } catch (err) {
            // Пользователь мог отменить системный выбор окна/экрана — не считаем ошибкой
            console.warn('toggleScreenShare отменён/недоступен:', err?.message);
        }
    }, [screenOn]);

    useEffect(() => {
        const onIncoming = (p) => setIncomingCall(p);
        socket.on('call:incoming', onIncoming);
        socket.on('call:ended', () => roomRef.current?.disconnect());
        return () => {
            socket.off('call:incoming', onIncoming);
        };
    }, []);

    return (
        <CallContext.Provider value={{ incomingCall, activeCall, participants, micOn, camOn, screenOn, connecting, startCall, acceptCall, declineCall, leaveCall, toggleMic, toggleCam, toggleScreenShare }}>
            {children}
        </CallContext.Provider>
    );
}
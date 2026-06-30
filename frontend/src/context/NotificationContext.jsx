import React, { createContext, useContext, useState, useEffect, useRef, useCallback } from 'react';
import { socket } from '../socket';

const NotificationContext = createContext(null);

export function useNotifications() {
    return useContext(NotificationContext);
}

export function NotificationProvider({ userId, activeChatId, children }) {
    const [unreadCounts, setUnreadCounts] = useState({});
    const audioRef = useRef(null);

    useEffect(() => {
        audioRef.current = new Audio('/notification.mp3');
        audioRef.current.volume = 0.5;
    }, []);

    const playSound = useCallback(() => {
        audioRef.current?.play().catch(() => { });
    }, []);

    useEffect(() => {
        if (!userId) return;

        function handleListUpdate(data) {
            const partnerId = data.partnerId ?? data.senderId;

            if (Number(partnerId) === Number(userId)) return;

            const isChatOpen = Number(partnerId) === Number(activeChatId);
            if (isChatOpen) return;

            setUnreadCounts(prev => ({
                ...prev,
                [partnerId]: (prev[partnerId] || 0) + 1
            }));

            playSound();

            try {
                if (document.visibilityState !== 'visible' && Notification.permission === 'granted') {
                    new Notification('PISMO — новое сообщение', {
                        body: `Сообщение от ${partnerId}`
                    });
                }
            } catch (e) { }
        }

        socket.on('chat:list_update', handleListUpdate);
        return () => socket.off('chat:list_update', handleListUpdate);
    }, [userId, activeChatId, playSound]);

    useEffect(() => {
        if (!activeChatId) return;
        setUnreadCounts(prev => {
            if (!prev[activeChatId]) return prev;
            const next = { ...prev };
            delete next[activeChatId];
            return next;
        });
    }, [activeChatId]);

    useEffect(() => {
        const total = Object.values(unreadCounts).reduce((a, b) => a + b, 0);
        document.title = total > 0 ? `(${total}) PISMO` : 'PISMO';
    }, [unreadCounts]);

    const getUnreadCount = useCallback(
        (partnerId) => unreadCounts[partnerId] || 0,
        [unreadCounts]
    );

    const clearUnread = useCallback((partnerId) => {
        setUnreadCounts(prev => {
            if (!prev[partnerId]) return prev;
            const next = { ...prev };
            delete next[partnerId];
            return next;
        });
    }, []);

    const value = { unreadCounts, getUnreadCount, clearUnread };

    return (
        <NotificationContext.Provider value={value}>
            {children}
        </NotificationContext.Provider>
    );
}
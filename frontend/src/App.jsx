import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { socket } from './socket'; // единственный инстанс сокета на весь фронтенд
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import Sidebar from './components/Sidebar/Sidebar';
import ChatWindow from './components/Chat/ChatWindow';
import { NotificationProvider } from './context/NotificationContext';
import './styles/globals.css';



const ChatDashboard = ({ user, onLogout }) => {
    const [activeChat, setActiveChat] = useState(() => {
        const savedChat = localStorage.getItem('pismo_active_chat');
        return savedChat ? JSON.parse(savedChat) : null;
    });

    const handleSelectChat = (chat) => {
        setActiveChat(chat);
        if (chat) {
            localStorage.setItem('pismo_active_chat', JSON.stringify(chat));
        } else {
            localStorage.removeItem('pismo_active_chat');
        }
    };

    return (
        <NotificationProvider userId={user.id} activeChatId={activeChat?.id}>
            <div style={{ display: 'flex', height: '100vh', width: '100%', overflow: 'hidden' }}>
                <Sidebar
                    user={user}
                    onLogout={onLogout}
                    activeChat={activeChat}
                    onSelectChat={handleSelectChat}
                    socket={socket}
                />

                {activeChat ? (
                    <ChatWindow activeChat={activeChat} user={user} socket={socket} />
                ) : (
                    <div style={{ flex: 1, backgroundColor: 'var(--bg-primary)', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', userSelect: 'none' }}>
                        <h2 style={{ color: '#fff', marginBottom: '10px' }}>Добро пожаловать в PISMO!</h2>
                        <p style={{ color: 'var(--text-muted)' }}>Выберите собеседника в левом меню для начала общения.</p>
                    </div>
                )}
            </div>
        </NotificationProvider>
    );
};

function App() {
    const [user, setUser] = useState(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        const savedUser = localStorage.getItem('pismo_user');
        const token = localStorage.getItem('pismo_token');
        if (savedUser && token) {
            setUser(JSON.parse(savedUser));
        }
        setLoading(false);
    }, []);

    // Управление жизненным циклом WebSocket-соединения на клиенте.
    // Авторизация полностью на handshake (auth: { token }) — отдельный 'join' больше не нужен,
    // сервер сам кладёт сокет в комнату user_<id> и во все его группы при коннекте.
    useEffect(() => {
        if (user) {
            socket.connect();

            socket.on('connect', () => {
                console.log(`✅ Сокет подключен и авторизован как пользователь ID: ${user.id}`);
            });

            socket.on('connect_error', (err) => {
                console.error('❌ Ошибка подключения сокета:', err.message);
                if (err.message === 'AUTH_INVALID_TOKEN' || err.message === 'AUTH_NO_TOKEN') {
                    handleLogout();
                }
            });

            return () => {
                socket.off('connect');
                socket.off('connect_error');
                socket.disconnect();
                console.log('[Socket] Подключение разорвано');
            };
        }
    }, [user]);

    const handleLogout = () => {
        localStorage.removeItem('pismo_user');
        localStorage.removeItem('pismo_token');
        localStorage.removeItem('pismo_active_chat');
        socket.disconnect();
        setUser(null);
    };

    if (loading) {
        return (
            <div style={{ backgroundColor: 'var(--bg-tertiary)', height: '100vh', display: 'flex', justifyContent: 'center', alignItems: 'center', color: 'var(--text-primary)' }}>
                <h2>Загрузка мессенджера PISMO...</h2>
            </div>
        );
    }

    return (
        <Router>
            <Routes>
                <Route path="/login" element={!user ? <LoginPage /> : <Navigate to="/" />} />
                <Route path="/register" element={!user ? <RegisterPage /> : <Navigate to="/" />} />
                <Route
                    path="/"
                    element={user ? <ChatDashboard user={user} onLogout={handleLogout} /> : <Navigate to="/login" />}
                />
                <Route path="*" element={<Navigate to="/" />} />
            </Routes>
        </Router>
    );
}

export default App;
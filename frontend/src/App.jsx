import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { socket } from './socket'; // единственный инстанс сокета на весь фронтенд
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import Sidebar from './components/Sidebar/Sidebar';
import ChatWindow from './components/Chat/ChatWindow';
import { NotificationProvider } from './context/NotificationContext';
import './styles/globals.css';
import { initRealtimeNotifications } from './notifications/realtime';



const ChatDashboard = ({ user, onLogout }) => {
  // Инициализируем активный чат из localStorage, чтобы он не пропадал при перезагрузке
  const [activeChat, setActiveChat] = useState(() => {
    const savedChat = localStorage.getItem('pismo_active_chat');
    return savedChat ? JSON.parse(savedChat) : null;
  });

  // Функция для выбора чата с сохранением в кэш
  const handleSelectChat = (chat) => {
    setActiveChat(chat);
    if (chat) {
      localStorage.setItem('pismo_active_chat', JSON.stringify(chat));
    } else {
      localStorage.removeItem('pismo_active_chat');
    }
  };

  return (
    // activeChatId передаём в NotificationProvider, чтобы он знал,
    // какой чат сейчас открыт, и не копил бейдж именно по нему
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
  // Используем единственный singleton-инстанс socket из socket.js — без повторного io(...)
  useEffect(() => {
    if (user) {
      socket.connect();

      socket.on('connect', () => {
        console.log('✅ Сокет подключен к серверу');
        socket.emit('join', user.id);
        console.log(`[Socket] Подключение установлено для пользователя ID: ${user.id}`);
      });

      initRealtimeNotifications({
        userId: user.id,
        activeChatIdProvider: () => {
          try {
            const savedChat = localStorage.getItem('pismo_active_chat');
            const active = savedChat ? JSON.parse(savedChat) : null;
            // activeChat.id — partnerId для личного чата
            return active?.id ?? null;
          } catch {
            return null;
          }
        }
      });


      return () => {
        socket.off('connect');
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

import { io } from 'socket.io-client';

// URL берется из .env или хардкодится для локалки
const URL = import.meta.env.VITE_BACKEND_URL || 'http://localhost:5000';

// autoConnect: false — подключаемся сами, вручную, после логина (см. App.jsx).
// Так сокет не пытается коннектиться на странице логина, где юзера еще нет.
export const socket = io(URL, {
  autoConnect: false,
  withCredentials: true
});
import axios from 'axios';

// Создаем инстанс axios с базовым URL нашего бэкенда
// Адрес бэкенда. По умолчанию — тот же сайт, с которого открыта страница
// (/api): на VPS nginx отдаёт и страницы, и /api; при `npm run dev` запросы
// к /api перекидывает на localhost:5000 сам Vite (см. vite.config.js).
// VITE_BACKEND_URL нужен, только если бэкенд стоит на другом адресе.
const BACKEND = (import.meta.env.VITE_BACKEND_URL || '').replace(/\/+$/, '');

const api = axios.create({
  baseURL: `${BACKEND}/api`,
});

// Добавляем перехватчик (interceptor) для каждого запроса
api.interceptors.request.use(
  (config) => {
    // Достаем токен из локального хранилища браузера
    const token = localStorage.getItem('pismo_token');
    if (token) {
      // Если токен есть, прикрепляем его к заголовкам авторизации
      config.headers.Authorization = `Bearer ${token}`;
    }
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

export default api;
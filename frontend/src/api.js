import axios from 'axios';

// Создаем инстанс axios с базовым URL нашего бэкенда
const api = axios.create({
  baseURL: 'http://localhost:5000/api', // Адрес сервера из первого шага
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
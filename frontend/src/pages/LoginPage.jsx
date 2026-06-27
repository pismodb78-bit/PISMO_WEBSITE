import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../api';

const LoginPage = () => {
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

  const handleLogin = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const response = await api.post('/auth/login', { login, password });
      
      // Сохраняем данные пользователя и токен
      localStorage.setItem('pismo_token', response.data.token);
      localStorage.setItem('pismo_user', JSON.stringify(response.data.user));
      
      // Перезагружаем страницу для обновления состояния App.jsx
      window.location.href = '/'; 
    } catch (err) {
      setError(err.response?.data?.message || 'Ошибка подключения к серверу');
    } finally {
      setIsLoading(false);
    }
  };

  // Inline-стили для точного попадания в Discord-дизайн без лишних CSS файлов
  const styles = {
    container: { display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--bg-tertiary)' },
    box: { backgroundColor: 'var(--bg-primary)', padding: '32px', borderRadius: '8px', width: '100%', maxWidth: '480px', boxShadow: '0 2px 10px rgba(0,0,0,0.2)' },
    title: { color: 'var(--text-primary)', textAlign: 'center', margin: '0 0 8px 0', fontSize: '24px', fontWeight: '600' },
    subtitle: { color: 'var(--text-muted)', textAlign: 'center', margin: '0 0 20px 0', fontSize: '15px' },
    formGroup: { marginBottom: '20px' },
    label: { display: 'block', color: 'var(--text-muted)', fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', marginBottom: '8px' },
    input: { width: '100%', padding: '10px', backgroundColor: 'var(--bg-tertiary)', border: '1px solid rgba(0,0,0,0.3)', borderRadius: '3px', color: 'var(--text-primary)', fontSize: '16px', outline: 'none' },
    button: { width: '100%', padding: '12px', backgroundColor: 'var(--accent)', color: 'white', border: 'none', borderRadius: '3px', fontSize: '16px', fontWeight: '500', cursor: 'pointer', transition: 'background-color 0.2s' },
    error: { color: 'var(--danger)', fontSize: '14px', marginBottom: '15px', textAlign: 'center' },
    link: { color: '#00AFF4', textDecoration: 'none', fontSize: '14px', marginTop: '10px', display: 'inline-block' }
  };

  return (
    <div style={styles.container}>
      <div style={styles.box}>
        <h2 style={styles.title}>С возвращением!</h2>
        <p style={styles.subtitle}>Мы так рады, что вы снова с нами!</p>
        
        {error && <div style={styles.error}>{error}</div>}

        <form onSubmit={handleLogin}>
          <div style={styles.formGroup}>
            <label style={styles.label}>Логин</label>
            <input 
              type="text" 
              value={login} 
              onChange={(e) => setLogin(e.target.value)} 
              style={styles.input} 
              required 
            />
          </div>
          
          <div style={styles.formGroup}>
            <label style={styles.label}>Пароль</label>
            <input 
              type="password" 
              value={password} 
              onChange={(e) => setPassword(e.target.value)} 
              style={styles.input} 
              required 
            />
          </div>

          <button 
            type="submit" 
            style={{...styles.button, opacity: isLoading ? 0.7 : 1}}
            disabled={isLoading}
          >
            {isLoading ? 'Вход...' : 'Вход'}
          </button>
        </form>

        <div style={{ marginTop: '20px', fontSize: '14px', color: 'var(--text-muted)' }}>
          Нужна учетная запись? <Link to="/register" style={styles.link}>Зарегистрироваться</Link>
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
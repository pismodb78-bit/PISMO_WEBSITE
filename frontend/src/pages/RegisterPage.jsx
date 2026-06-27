import React, { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import api from '../api';

const RegisterPage = () => {
  const [formData, setFormData] = useState({
    login: '',
    password: '',
    name: '',
    surname: ''
  });
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const navigate = useNavigate();

  const handleChange = (e) => {
    setFormData({ ...formData, [e.target.name]: e.target.value });
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      await api.post('/auth/register', formData);
      // После успешной регистрации отправляем на страницу входа
      navigate('/login');
    } catch (err) {
      setError(err.response?.data?.message || 'Ошибка при регистрации');
    } finally {
      setIsLoading(false);
    }
  };

  const styles = {
    container: { display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--bg-tertiary)' },
    box: { backgroundColor: 'var(--bg-primary)', padding: '32px', borderRadius: '8px', width: '100%', maxWidth: '480px', boxShadow: '0 2px 10px rgba(0,0,0,0.2)' },
    title: { color: 'var(--text-primary)', textAlign: 'center', margin: '0 0 20px 0', fontSize: '24px', fontWeight: '600' },
    formGroup: { marginBottom: '15px' },
    label: { display: 'block', color: 'var(--text-muted)', fontSize: '12px', fontWeight: '700', textTransform: 'uppercase', marginBottom: '8px' },
    input: { width: '100%', padding: '10px', backgroundColor: 'var(--bg-tertiary)', border: '1px solid rgba(0,0,0,0.3)', borderRadius: '3px', color: 'var(--text-primary)', fontSize: '16px', outline: 'none' },
    button: { width: '100%', padding: '12px', backgroundColor: 'var(--accent)', color: 'white', border: 'none', borderRadius: '3px', fontSize: '16px', fontWeight: '500', cursor: 'pointer', marginTop: '10px' },
    error: { color: 'var(--danger)', fontSize: '14px', marginBottom: '15px', textAlign: 'center' },
    link: { color: '#00AFF4', textDecoration: 'none', fontSize: '14px' },
    row: { display: 'flex', gap: '15px' }
  };

  return (
    <div style={styles.container}>
      <div style={styles.box}>
        <h2 style={styles.title}>Создать учетную запись</h2>
        
        {error && <div style={styles.error}>{error}</div>}

        <form onSubmit={handleRegister}>
          <div style={styles.formGroup}>
            <label style={styles.label}>Логин *</label>
            <input 
              type="text" 
              name="login"
              value={formData.login} 
              onChange={handleChange} 
              style={styles.input} 
              required 
            />
          </div>

          <div style={styles.row}>
            <div style={{...styles.formGroup, flex: 1}}>
              <label style={styles.label}>Имя</label>
              <input 
                type="text" 
                name="name"
                value={formData.name} 
                onChange={handleChange} 
                style={styles.input} 
              />
            </div>
            <div style={{...styles.formGroup, flex: 1}}>
              <label style={styles.label}>Фамилия</label>
              <input 
                type="text" 
                name="surname"
                value={formData.surname} 
                onChange={handleChange} 
                style={styles.input} 
              />
            </div>
          </div>
          
          <div style={styles.formGroup}>
            <label style={styles.label}>Пароль *</label>
            <input 
              type="password" 
              name="password"
              value={formData.password} 
              onChange={handleChange} 
              style={styles.input} 
              required 
            />
          </div>

          <button 
            type="submit" 
            style={{...styles.button, opacity: isLoading ? 0.7 : 1}}
            disabled={isLoading}
          >
            {isLoading ? 'Создание...' : 'Продолжить'}
          </button>
        </form>

        <div style={{ marginTop: '20px', fontSize: '14px' }}>
          <Link to="/login" style={styles.link}>Уже есть учетная запись?</Link>
        </div>
      </div>
    </div>
  );
};

export default RegisterPage;
import React from 'react';
import * as api from '../lib/api';

/**
 * Вход и регистрация.
 *
 * Правила валидации намеренно не дублируются здесь целиком: их проверяет
 * бэкенд по тем же условиям, что RegisterForm.cs, и сообщение приходит
 * оттуда. Иначе два набора правил разъезжаются, и на сайте заводились бы
 * учётные записи, которые ПК потом не принимает.
 */
export default function Auth({ onReady }) {
    const [mode, setMode] = React.useState('login');
    const [form, setForm] = React.useState({ login: '', password: '', name: '', surname: '' });
    const [error, setError] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const [note, setNote] = React.useState('');

    const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

    async function submit(e) {
        e.preventDefault();
        setError('');
        setNote('');
        setBusy(true);
        try {
            if (mode === 'login') {
                const user = await api.login(form.login.trim(), form.password);
                onReady(user);
            } else {
                await api.register(form.name.trim(), form.surname.trim(), form.login.trim(), form.password);
                setNote('Готово. Теперь войдите.');
                setMode('login');
                setForm((f) => ({ ...f, password: '' }));
            }
        } catch (err) {
            setError(err.message);
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="auth-wrap">
            <form className="auth-card" onSubmit={submit}>
                <h1>PISMO</h1>
                <div className="sub">
                    {mode === 'login' ? 'Вход в мессенджер' : 'Регистрация'}
                    {' · '}те же логин и пароль, что в приложении
                </div>

                {mode === 'register' && (
                    <>
                        <div className="field">
                            <label>Имя</label>
                            <input value={form.name} onChange={set('name')} autoComplete="given-name" />
                        </div>
                        <div className="field">
                            <label>Фамилия</label>
                            <input value={form.surname} onChange={set('surname')} autoComplete="family-name" />
                        </div>
                    </>
                )}

                <div className="field">
                    <label>Логин</label>
                    <input value={form.login} onChange={set('login')} autoComplete="username" autoFocus />
                </div>
                <div className="field">
                    <label>Пароль</label>
                    <input
                        type="password"
                        value={form.password}
                        onChange={set('password')}
                        autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                    />
                </div>

                {error && <div className="error-text">{error}</div>}
                {note && <div style={{ color: 'var(--online)', fontSize: 13 }}>{note}</div>}

                <button className="btn" style={{ width: '100%', marginTop: 14 }} disabled={busy}>
                    {busy ? 'Подождите…' : (mode === 'login' ? 'Войти' : 'Зарегистрироваться')}
                </button>

                <div className="auth-switch">
                    {mode === 'login' ? 'Нет учётной записи? ' : 'Уже есть учётная запись? '}
                    <button
                        type="button"
                        onClick={() => { setMode(mode === 'login' ? 'register' : 'login'); setError(''); }}
                    >
                        {mode === 'login' ? 'Создать' : 'Войти'}
                    </button>
                </div>
            </form>
        </div>
    );
}

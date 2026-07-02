import React, { useState } from 'react';
import api from '../../api';

const ChangePasswordModal = ({ onClose }) => {
    const [oldPassword, setOldPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [error, setError] = useState('');
    const [success, setSuccess] = useState(false);
    const [submitting, setSubmitting] = useState(false);

    const handleSubmit = async (e) => {
        e.preventDefault();
        setError('');

        if (!oldPassword || !newPassword || !confirmPassword) {
            setError('Заполните все поля');
            return;
        }
        if (newPassword !== confirmPassword) {
            setError('Новые пароли не совпадают');
            return;
        }
        if (newPassword === oldPassword) {
            setError('Новый пароль совпадает со старым — придумайте другой');
            return;
        }
        if (newPassword.length < 4) {
            setError('Новый пароль слишком короткий (минимум 4 символа)');
            return;
        }

        setSubmitting(true);
        try {
            await api.post('/auth/change-password', { oldPassword, newPassword });
            setSuccess(true);
            setTimeout(() => onClose(), 1500);
        } catch (err) {
            console.error('Ошибка смены пароля:', err);
            // Показываем конкретную ошибку от сервера
            setError(
                err.response?.data?.message ||
                'Не удалось сменить пароль. Проверьте текущий пароль.'
            );
        } finally {
            setSubmitting(false);
        }
    };

    const styles = {
        overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
        modal: { width: '380px', backgroundColor: 'var(--bg-primary)', borderRadius: '8px', overflow: 'hidden' },
        header: { padding: '20px', borderBottom: '1px solid rgba(0,0,0,0.3)' },
        title: { color: '#fff', fontSize: '18px', fontWeight: '700', margin: 0 },
        body: { padding: '20px' },
        label: { color: 'var(--text-muted)', fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', marginBottom: '6px', display: 'block' },
        input: { width: '100%', backgroundColor: 'var(--bg-tertiary)', border: 'none', borderRadius: '4px', padding: '10px 12px', color: '#fff', fontSize: '14px', marginBottom: '16px', boxSizing: 'border-box' },
        error: { color: '#ed4245', fontSize: '13px', marginTop: '12px', padding: '8px 10px', backgroundColor: 'rgba(237,66,69,0.1)', borderRadius: '4px' },
        successMsg: { color: '#43b581', fontSize: '13px', marginTop: '12px', padding: '8px 10px', backgroundColor: 'rgba(67,181,129,0.1)', borderRadius: '4px' },
        footer: { padding: '16px 20px', display: 'flex', justifyContent: 'flex-end', gap: '8px', borderTop: '1px solid rgba(0,0,0,0.3)' },
        btnCancel: { backgroundColor: 'transparent', color: 'var(--text-muted)', border: 'none', padding: '10px 16px', borderRadius: '4px', cursor: 'pointer', fontSize: '14px' },
        btnSubmit: { backgroundColor: '#5865F2', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: '4px', cursor: 'pointer', fontSize: '14px', fontWeight: '600' }
    };

    return (
        <div style={styles.overlay} onClick={onClose}>
            <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
                <div style={styles.header}>
                    <h3 style={styles.title}>Сменить пароль</h3>
                </div>
                <form onSubmit={handleSubmit}>
                    <div style={styles.body}>
                        <label style={styles.label}>Текущий пароль</label>
                        <input type="password" style={styles.input} value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} autoFocus />

                        <label style={styles.label}>Новый пароль</label>
                        <input type="password" style={styles.input} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />

                        <label style={styles.label}>Подтвердите новый пароль</label>
                        <input type="password" style={{ ...styles.input, marginBottom: 0 }} value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} />

                        {error && <div style={styles.error}>⚠️ {error}</div>}
                        {success && <div style={styles.successMsg}>✅ Пароль успешно изменён</div>}
                    </div>
                    <div style={styles.footer}>
                        <button type="button" style={styles.btnCancel} onClick={onClose}>Отмена</button>
                        <button type="submit" style={styles.btnSubmit} disabled={submitting || success}>
                            {submitting ? 'Сохранение...' : 'Сохранить'}
                        </button>
                    </div>
                </form>
            </div>
        </div>
    );
};

export default ChangePasswordModal;
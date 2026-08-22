import React from 'react';
import { avatarUrl } from '../lib/api';
import { colorFor, initials, presenceKind } from '../lib/format';

/** Аватар с точкой присутствия. Картинка грузится с бэкенда, иначе инициалы. */
export function Avatar({ userId, name, size = '', presence, hideDot = false }) {
    const [failed, setFailed] = React.useState(false);
    React.useEffect(() => setFailed(false), [userId]);

    return (
        <div className="avatar-wrap">
            <div className={`avatar ${size}`} style={{ background: colorFor(name || userId) }}>
                {userId && !failed ? (
                    <img src={avatarUrl(userId)} alt="" onError={() => setFailed(true)} />
                ) : initials(name)}
            </div>
            {!hideDot && presence !== undefined && (
                <span className={`dot ${presenceKind(presence)}`} />
            )}
        </div>
    );
}

/** Кружок сервера или группы — без картинки, только буквы и цвет. */
export function Blob({ name, color }) {
    return (
        <div className="avatar" style={{ background: color || colorFor(name), borderRadius: 'inherit', width: '100%', height: '100%' }}>
            {initials(name)}
        </div>
    );
}

export function Modal({ title, onClose, children, actions }) {
    // Escape закрывает — привычка из десктопных диалогов.
    React.useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [onClose]);

    return (
        <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
            <div className="modal">
                <h2>{title}</h2>
                {children}
                {actions && <div className="modal-actions">{actions}</div>}
            </div>
        </div>
    );
}

export function Field({ label, ...rest }) {
    return (
        <div className="field">
            {label && <label>{label}</label>}
            <input {...rest} />
        </div>
    );
}

export function Check({ label, checked, onChange }) {
    return (
        <label className="check">
            <input type="checkbox" checked={Boolean(checked)} onChange={(e) => onChange(e.target.checked)} />
            <span>{label}</span>
        </label>
    );
}

export function Empty({ icon, title, hint }) {
    return (
        <div className="empty">
            <div style={{ fontSize: 40 }}>{icon}</div>
            <div style={{ fontSize: 15, color: 'var(--text-dim)' }}>{title}</div>
            {hint && <div style={{ fontSize: 13 }}>{hint}</div>}
        </div>
    );
}

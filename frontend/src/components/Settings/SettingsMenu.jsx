import React, { useState, useRef, useEffect } from 'react';
import ChangePasswordModal from './ChangePasswordModal';
import DeviceSettingsModal from './DeviceSettingsModal';

const SettingsMenu = ({ onLogout }) => {
  const [open, setOpen] = useState(false);
  const [showPasswordModal, setShowPasswordModal] = useState(false);
  const [showDeviceModal, setShowDeviceModal] = useState(false);
  const menuRef = useRef(null);

  // закрываем меню при клике снаружи
  useEffect(() => {
    function handleClickOutside(e) {
      if (menuRef.current && !menuRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleClearCache = () => {
    // У десктопного клиента "кеш медиа" — это файлы на диске (картинки/аудио/видео),
    // которые он хранит локально, чтобы не перекачивать BLOB из БД повторно.
    // В вебе прямого аналога нет — медиа живёт в памяти React (state) на время сессии.
    // Поэтому веб-эквивалент: явно сбросить состояние и форсировать чистую
    // перезагрузку открытого чата с сервера (см. window event ниже).
    window.dispatchEvent(new CustomEvent('pismo:clear-media-cache'));
    setOpen(false);
    alert('Кеш медиа очищен. История чата будет перезагружена с сервера.');
  };

  const styles = {
    wrapper: { position: 'relative', display: 'inline-block' },
    gearBtn: { background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: '18px', padding: '4px' },
    menu: { position: 'absolute', bottom: '36px', left: 0, backgroundColor: '#18191c', borderRadius: '6px', boxShadow: '0 4px 12px rgba(0,0,0,0.4)', minWidth: '260px', padding: '6px', zIndex: 200 },
    item: { display: 'flex', alignItems: 'center', gap: '10px', padding: '10px 12px', borderRadius: '4px', cursor: 'pointer', color: 'var(--text-primary)', fontSize: '14px' },
    itemDanger: { color: '#ed4245' },
    divider: { height: '1px', backgroundColor: 'rgba(255,255,255,0.06)', margin: '4px 0' }
  };

  return (
    <div style={styles.wrapper} ref={menuRef}>
      <button style={styles.gearBtn} onClick={() => setOpen(o => !o)} title="Настройки">⚙️</button>

      {open && (
        <div style={styles.menu}>
          <div
            style={styles.item}
            onClick={() => { setShowPasswordModal(true); setOpen(false); }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.05)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
          >
            🔑 Сменить пароль
          </div>
          <div
            style={styles.item}
            onClick={() => { setShowDeviceModal(true); setOpen(false); }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.05)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
          >
            🎛️ Настройки устройств (камера/микрофон)
          </div>
          <div
            style={styles.item}
            onClick={handleClearCache}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(255,255,255,0.05)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
          >
            🗑️ Очистить кеш медиа
          </div>
          <div style={styles.divider} />
          <div
            style={{ ...styles.item, ...styles.itemDanger }}
            onClick={() => { setOpen(false); onLogout(); }}
            onMouseEnter={(e) => e.currentTarget.style.backgroundColor = 'rgba(237,66,69,0.1)'}
            onMouseLeave={(e) => e.currentTarget.style.backgroundColor = 'transparent'}
          >
            🚪 Выйти из аккаунта
          </div>
        </div>
      )}

      {showPasswordModal && (
        <ChangePasswordModal onClose={() => setShowPasswordModal(false)} />
      )}
      {showDeviceModal && (
        <DeviceSettingsModal onClose={() => setShowDeviceModal(false)} />
      )}
    </div>
  );
};

export default SettingsMenu;

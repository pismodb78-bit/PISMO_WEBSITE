import React, { useState, useEffect, useRef } from 'react';

const LS_CAMERA_ID = 'pismo_camera_device_id';
const LS_MIC_ID = 'pismo_mic_device_id';
const LS_MIC_GAIN = 'pismo_mic_gain';
const LS_SCREEN_RES = 'pismo_screen_resolution';
const LS_SCREEN_FPS = 'pismo_screen_fps';

const DeviceSettingsModal = ({ onClose }) => {
    const [cameras, setCameras] = useState([]);
    const [mics, setMics] = useState([]);
    const [selectedCameraId, setSelectedCameraId] = useState(localStorage.getItem(LS_CAMERA_ID) || '');
    const [selectedMicId, setSelectedMicId] = useState(localStorage.getItem(LS_MIC_ID) || '');
    const [micGain, setMicGain] = useState(Number(localStorage.getItem(LS_MIC_GAIN)) || 100);
    const [screenRes, setScreenRes] = useState(localStorage.getItem(LS_SCREEN_RES) || '1080');
    const [screenFps, setScreenFps] = useState(localStorage.getItem(LS_SCREEN_FPS) || '60');
    const [deviceStatus, setDeviceStatus] = useState('idle'); // idle | requesting | ready | denied

    const [cameraTesting, setCameraTesting] = useState(false);
    const [micTesting, setMicTesting] = useState(false);
    const [micLevel, setMicLevel] = useState(0);

    const videoRef = useRef(null);
    const cameraStreamRef = useRef(null);
    const micStreamRef = useRef(null);
    const audioContextRef = useRef(null);
    const analyserRef = useRef(null);
    const micAnimationRef = useRef(null);

    // При открытии модалки — сразу запрашиваем разрешение, чтобы получить нормальные имена устройств
    useEffect(() => {
        let cancelled = false;

        async function requestPermissionAndLoad() {
            setDeviceStatus('requesting');
            try {
                // Запрашиваем оба разрешения сразу — без этого браузер не даёт label-ы устройств
                const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true })
                    .catch(async () => {
                        // Если нет видео — пробуем только аудио
                        return await navigator.mediaDevices.getUserMedia({ audio: true })
                            .catch(() => null);
                    });

                // Сразу останавливаем — нам нужно только разрешение, не сам стрим
                stream?.getTracks().forEach(t => t.stop());

                if (cancelled) return;

                const devices = await navigator.mediaDevices.enumerateDevices();
                if (cancelled) return;

                setCameras(devices.filter(d => d.kind === 'videoinput'));
                setMics(devices.filter(d => d.kind === 'audioinput'));
                setDeviceStatus('ready');
            } catch (err) {
                console.error('Ошибка доступа к устройствам:', err);
                if (!cancelled) setDeviceStatus('denied');
            }
        }

        requestPermissionAndLoad();

        return () => {
            cancelled = true;
            stopCameraTest();
            stopMicTest();
        };
    }, []);

    const enumerateDevices = async () => {
        try {
            const devices = await navigator.mediaDevices.enumerateDevices();
            setCameras(devices.filter(d => d.kind === 'videoinput'));
            setMics(devices.filter(d => d.kind === 'audioinput'));
        } catch (err) {
            console.error('Не удалось обновить список устройств:', err);
        }
    };

    const startCameraTest = async () => {
        try {
            const constraints = {
                video: selectedCameraId ? { deviceId: { exact: selectedCameraId } } : true
            };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            cameraStreamRef.current = stream;
            if (videoRef.current) videoRef.current.srcObject = stream;
            setCameraTesting(true);
            await enumerateDevices();
        } catch (err) {
            alert('Не удалось получить доступ к камере: ' + err.message);
        }
    };

    const stopCameraTest = () => {
        cameraStreamRef.current?.getTracks().forEach(t => t.stop());
        cameraStreamRef.current = null;
        if (videoRef.current) videoRef.current.srcObject = null;
        setCameraTesting(false);
    };

    const startMicTest = async () => {
        try {
            const constraints = {
                audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true
            };
            const stream = await navigator.mediaDevices.getUserMedia(constraints);
            micStreamRef.current = stream;

            const AudioContext = window.AudioContext || window.webkitAudioContext;
            const audioContext = new AudioContext();
            audioContextRef.current = audioContext;

            const source = audioContext.createMediaStreamSource(stream);
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            source.connect(analyser);
            analyserRef.current = analyser;

            setMicTesting(true);
            tickMicLevel();
            await enumerateDevices();
        } catch (err) {
            alert('Не удалось получить доступ к микрофону: ' + err.message);
        }
    };

    const tickMicLevel = () => {
        if (!analyserRef.current) return;
        const data = new Uint8Array(analyserRef.current.frequencyBinCount);
        analyserRef.current.getByteFrequencyData(data);
        const avg = data.reduce((sum, v) => sum + v, 0) / data.length;
        const adjusted = Math.min(100, (avg / 255) * 100 * (micGain / 100));
        setMicLevel(adjusted);
        micAnimationRef.current = requestAnimationFrame(tickMicLevel);
    };

    const stopMicTest = () => {
        if (micAnimationRef.current) cancelAnimationFrame(micAnimationRef.current);
        micStreamRef.current?.getTracks().forEach(t => t.stop());
        micStreamRef.current = null;
        audioContextRef.current?.close();
        audioContextRef.current = null;
        analyserRef.current = null;
        setMicTesting(false);
        setMicLevel(0);
    };

    const handleSave = () => {
        localStorage.setItem(LS_CAMERA_ID, selectedCameraId);
        localStorage.setItem(LS_MIC_ID, selectedMicId);
        localStorage.setItem(LS_MIC_GAIN, String(micGain));
        localStorage.setItem(LS_SCREEN_RES, screenRes);
        localStorage.setItem(LS_SCREEN_FPS, screenFps);
        stopCameraTest();
        stopMicTest();
        onClose();
    };

    const handleClose = () => {
        stopCameraTest();
        stopMicTest();
        onClose();
    };

    const renderVuBars = () => {
        const barCount = 30;
        const activeBars = Math.round((micLevel / 100) * barCount);
        return (
            <div style={{ display: 'flex', gap: '2px', height: '24px', alignItems: 'flex-end' }}>
                {Array.from({ length: barCount }).map((_, i) => (
                    <div key={i} style={{
                        width: '8px', height: '100%', borderRadius: '1px',
                        backgroundColor: i < activeBars
                            ? (i < barCount * 0.6 ? '#43b581' : i < barCount * 0.8 ? '#faa61a' : '#f04747')
                            : 'rgba(255,255,255,0.08)',
                        transition: 'background-color 0.05s linear'
                    }} />
                ))}
            </div>
        );
    };

    const styles = {
        overlay: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
        modal: { width: '540px', maxHeight: '95vh', backgroundColor: 'var(--bg-primary)', borderRadius: '8px', display: 'flex', flexDirection: 'column', overflow: 'hidden' },
        header: { padding: '16px 20px', borderBottom: '1px solid rgba(0,0,0,0.3)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
        title: { color: '#fff', fontSize: '18px', fontWeight: '700', margin: 0 },
        closeBtn: { background: 'none', border: 'none', color: 'var(--text-muted)', fontSize: '18px', cursor: 'pointer' },
        body: { padding: '20px', flex: 1, overflowY: 'auto' },
        section: { marginBottom: '24px' },
        sectionTitle: { color: '#fff', fontSize: '15px', fontWeight: '700', marginBottom: '12px', display: 'flex', alignItems: 'center', gap: '8px' },
        label: { color: 'var(--text-muted)', fontSize: '11px', fontWeight: '700', textTransform: 'uppercase', marginBottom: '6px', display: 'block' },
        row: { display: 'flex', gap: '8px', marginBottom: '10px' },
        select: { flex: 1, backgroundColor: 'var(--bg-tertiary)', border: 'none', borderRadius: '4px', padding: '8px 10px', color: '#fff', fontSize: '13px' },
        testBtn: { backgroundColor: '#5865F2', color: '#fff', border: 'none', borderRadius: '4px', padding: '8px 16px', fontSize: '13px', fontWeight: '600', cursor: 'pointer', whiteSpace: 'nowrap' },
        testBtnActive: { backgroundColor: '#ed4245' },
        videoPreview: { width: '100%', height: '160px', backgroundColor: '#000', borderRadius: '6px', objectFit: 'cover' },
        previewPlaceholder: { width: '100%', height: '160px', backgroundColor: '#000', borderRadius: '6px', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', fontSize: '13px' },
        statusBanner: { padding: '10px 14px', borderRadius: '6px', fontSize: '13px', marginBottom: '16px' },
        gainRow: { marginTop: '12px' },
        gainLabel: { display: 'flex', justifyContent: 'space-between', color: 'var(--text-muted)', fontSize: '12px', marginBottom: '6px' },
        slider: { width: '100%' },
        vuWrapper: { marginTop: '10px', backgroundColor: 'var(--bg-tertiary)', borderRadius: '4px', padding: '8px' },
        footer: { padding: '16px 20px', display: 'flex', justifyContent: 'flex-end', gap: '8px', borderTop: '1px solid rgba(0,0,0,0.3)' },
        btnCancel: { backgroundColor: 'transparent', color: 'var(--text-muted)', border: 'none', padding: '10px 16px', borderRadius: '4px', cursor: 'pointer', fontSize: '14px' },
        btnSave: { backgroundColor: '#5865F2', color: '#fff', border: 'none', padding: '10px 20px', borderRadius: '4px', cursor: 'pointer', fontSize: '14px', fontWeight: '600' }
    };

    return (
        <div style={styles.overlay} onClick={handleClose}>
            <div style={styles.modal} onClick={(e) => e.stopPropagation()}>
                <div style={styles.header}>
                    <h3 style={styles.title}>Настройки устройств</h3>
                    <button style={styles.closeBtn} onClick={handleClose}>✕</button>
                </div>

                <div style={styles.body}>
                    {deviceStatus === 'requesting' && (
                        <div style={{ ...styles.statusBanner, backgroundColor: 'rgba(88,101,242,0.15)', color: '#8ea1e1' }}>
                            ⏳ Запрашиваем доступ к камере и микрофону...
                        </div>
                    )}
                    {deviceStatus === 'denied' && (
                        <div style={{ ...styles.statusBanner, backgroundColor: 'rgba(237,66,69,0.15)', color: '#ed4245' }}>
                            ⚠️ Нет доступа к устройствам. Разрешите доступ в настройках браузера и откройте это окно снова.
                        </div>
                    )}

                    {/* КАМЕРА */}
                    <div style={styles.section}>
                        <div style={styles.sectionTitle}>📷 Камера</div>
                        <label style={styles.label}>Устройство</label>
                        <div style={styles.row}>
                            <select style={styles.select} value={selectedCameraId} onChange={(e) => setSelectedCameraId(e.target.value)}>
                                <option value="">По умолчанию</option>
                                {cameras.map(c => (
                                    <option key={c.deviceId} value={c.deviceId}>
                                        {c.label || `Камера ${c.deviceId.slice(0, 8)}`}
                                    </option>
                                ))}
                            </select>
                            <button
                                style={{ ...styles.testBtn, ...(cameraTesting ? styles.testBtnActive : {}) }}
                                onClick={cameraTesting ? stopCameraTest : startCameraTest}
                                disabled={deviceStatus === 'requesting'}
                            >
                                {cameraTesting ? '⏹ Стоп' : '▶ Тест'}
                            </button>
                        </div>
                        {cameraTesting
                            ? <video ref={videoRef} autoPlay muted playsInline style={styles.videoPreview} />
                            : <div style={styles.previewPlaceholder}>Превью не запущено</div>
                        }
                    </div>

                    {/* МИКРОФОН */}
                    <div style={styles.section}>
                        <div style={styles.sectionTitle}>🎙️ Микрофон</div>
                        <label style={styles.label}>Устройство</label>
                        <div style={styles.row}>
                            <select style={styles.select} value={selectedMicId} onChange={(e) => setSelectedMicId(e.target.value)}>
                                <option value="">По умолчанию</option>
                                {mics.map(m => (
                                    <option key={m.deviceId} value={m.deviceId}>
                                        {m.label || `Микрофон ${m.deviceId.slice(0, 8)}`}
                                    </option>
                                ))}
                            </select>
                            <button
                                style={{ ...styles.testBtn, ...(micTesting ? styles.testBtnActive : {}) }}
                                onClick={micTesting ? stopMicTest : startMicTest}
                                disabled={deviceStatus === 'requesting'}
                            >
                                {micTesting ? '⏹ Стоп' : '▶ Тест'}
                            </button>
                        </div>

                        <div style={styles.gainRow}>
                            <div style={styles.gainLabel}>
                                <span>Чувствительность (усиление)</span>
                                <span>{micGain}%</span>
                            </div>
                            <input
                                type="range" min="0" max="200" value={micGain}
                                onChange={(e) => setMicGain(Number(e.target.value))}
                                style={styles.slider}
                            />
                        </div>

                        <div style={styles.vuWrapper}>{renderVuBars()}</div>
                    </div>

                    {/* ДЕМОНСТРАЦИЯ ЭКРАНА */}
                    <div style={styles.section}>
                        <div style={styles.sectionTitle}>🖥️ Демонстрация экрана</div>
                        <label style={styles.label}>Разрешение / FPS</label>
                        <div style={styles.row}>
                            <select style={styles.select} value={screenRes} onChange={(e) => setScreenRes(e.target.value)}>
                                <option value="720">720p</option>
                                <option value="1080">1080p</option>
                                <option value="1440">1440p</option>
                            </select>
                            <select style={styles.select} value={screenFps} onChange={(e) => setScreenFps(e.target.value)}>
                                <option value="15">15 FPS</option>
                                <option value="30">30 FPS</option>
                                <option value="60">60 FPS</option>
                            </select>
                        </div>
                    </div>
                </div>

                <div style={styles.footer}>
                    <button style={styles.btnCancel} onClick={handleClose}>Отмена</button>
                    <button style={styles.btnSave} onClick={handleSave}>Сохранить</button>
                </div>
            </div>
        </div>
    );
};

export default DeviceSettingsModal;
import React from 'react';

/**
 * Граница ошибок.
 *
 * Без неё любая ошибка при отрисовке — не пойманное исключение, не
 * загрузившийся ленивый кусок кода — размонтирует всё дерево, и человек
 * видит просто белый экран. Понять по нему нечего: сайт «зашёл и пропал».
 *
 * Здесь ошибка останавливается и показывается текстом, а вместе с ней —
 * подсказка про самый частый её повод: не поставлены зависимости
 * фронтенда, из-за чего не резолвится импорт.
 *
 * [fallback] позволяет ограничить падение частью экрана: звонок, упавший
 * в своей границе, не должен уносить с собой переписку.
 */
export default class ErrorBoundary extends React.Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
    }

    static getDerivedStateFromError(error) {
        return { error };
    }

    componentDidCatch(error, info) {
        // В консоль — со стеком компонентов: по нему видно, какой экран упал.
        console.error('[PISMO] ошибка отрисовки:', error, info?.componentStack);
    }

    render() {
        const { error } = this.state;
        if (!error) return this.props.children;

        if (this.props.fallback !== undefined) return this.props.fallback;

        const looksLikeMissingModule = /Failed to fetch dynamically imported module|Importing a module script failed|could not be resolved|Failed to resolve/i
            .test(error.message || '');

        return (
            <div className="auth-wrap">
                <div className="auth-card">
                    <h1>PISMO</h1>
                    <div className="sub">Страница не отрисовалась</div>

                    <div className="error-text" style={{ marginBottom: 14, wordBreak: 'break-word' }}>
                        {error.message || String(error)}
                    </div>

                    {looksLikeMissingModule && (
                        <div className="faint" style={{ fontSize: 13, marginBottom: 14 }}>
                            Похоже, не доставлены зависимости фронтенда. В папке
                            {' '}<code>frontend</code>{' '}выполните <code>npm install</code>
                            {' '}и перезапустите <code>npm run dev</code>.
                        </div>
                    )}

                    <div className="row">
                        <button className="btn" onClick={() => window.location.reload()}>
                            Перезагрузить
                        </button>
                        <button
                            className="btn btn-ghost"
                            onClick={() => {
                                localStorage.removeItem('pismo_token');
                                localStorage.removeItem('pismo_user');
                                window.location.reload();
                            }}
                        >
                            Выйти и войти заново
                        </button>
                    </div>
                </div>
            </div>
        );
    }
}

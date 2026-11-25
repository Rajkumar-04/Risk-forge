import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './styles.css';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  handleResetStorage = () => {
    try {
      Object.keys(window.localStorage)
        .filter((k) => k.startsWith('rcc_'))
        .forEach((k) => window.localStorage.removeItem(k));
    } catch {
      // Ignore storage errors
    }
    window.location.reload();
  };

  render() {
    if (this.state.error) {
      return (
        <div
          style={{
            minHeight: '100vh',
            display: 'grid',
            placeItems: 'center',
            padding: '24px',
            background: '#090c12',
            color: '#f1f5f9',
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          <div
            style={{
              maxWidth: '480px',
              padding: '24px',
              borderRadius: '12px',
              background: '#11151f',
              border: '1px solid #2c374d',
            }}
          >
            <h1 style={{ margin: '0 0 8px', fontSize: '18px' }}>
              Release Control Center hit an unexpected error
            </h1>
            <p style={{ margin: '0 0 16px', color: '#94a3b8', fontSize: '13px' }}>
              {String(this.state.error?.message || this.state.error)}
            </p>
            <button
              type="button"
              onClick={this.handleResetStorage}
              style={{
                padding: '8px 14px',
                borderRadius: '8px',
                border: 'none',
                background: '#f43f5e',
                color: '#fff',
                fontWeight: 600,
                cursor: 'pointer',
              }}
            >
              Reset local data &amp; reload
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>
);

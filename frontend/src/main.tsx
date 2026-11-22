import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles/global.css';

interface LaunchParams {
  targetURL?: string;
}

interface LaunchQueue {
  setConsumer: (consumer: (params: LaunchParams) => void) => void;
}

function setupPwa() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  document.documentElement.classList.toggle('pwa-standalone', standalone);

  const launchQueue = (window as Window & { launchQueue?: LaunchQueue }).launchQueue;
  launchQueue?.setConsumer((params) => {
    if (params.targetURL) {
      const target = new URL(params.targetURL, window.location.href);
      const current = new URL(window.location.href);
      // focus-existing 优先保留当前窗口；只有启动目标确实指向另一个会话时才导航。
      if (
        target.origin === current.origin &&
        target.search &&
        target.search !== current.search
      ) {
        window.location.assign(target.href);
      }
    }
    window.focus();
  });

  if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch((error) => {
        console.warn('Service worker registration failed', error);
      });
    });
  }
}

setupPwa();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

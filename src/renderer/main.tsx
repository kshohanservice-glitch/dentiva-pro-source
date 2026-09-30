/**
 * Renderer entry point.
 *
 * Fonts first (so Bengali and Latin text render identically in the app and in
 * printed documents), then the design tokens, then the application.
 */
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter } from 'react-router-dom';

import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';
import '@fontsource/noto-sans-bengali/400.css';
import '@fontsource/noto-sans-bengali/500.css';
import '@fontsource/noto-sans-bengali/600.css';
import '@fontsource/noto-sans-bengali/700.css';
import './styles/app.css';

import { App } from './app';
import { AppProvider } from './state/store';

const container = document.getElementById('root');
if (!container) throw new Error('The application root element is missing.');

createRoot(container).render(
  <StrictMode>
    <HashRouter>
      <AppProvider>
        <App />
      </AppProvider>
    </HashRouter>
  </StrictMode>,
);

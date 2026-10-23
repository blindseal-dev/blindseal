import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { captureToken } from './api/client';
import App from './App';
import './tokens.css';
import './index.css';

// Capture the bearer token from the URL fragment before anything renders (kept in memory only).
captureToken();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

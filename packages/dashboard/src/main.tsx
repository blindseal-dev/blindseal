import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { captureToken } from './api/client';
import App from './App';

// Kit CSS, carried verbatim from design/mockups/_shared (DECISIONS: FE port architecture).
import './kit/tokens.css';
import './kit/fonts.css';
import './kit/motion.css';
import './kit/glass.css';
import './kit/ui.css';
import './kit/space.css';
import './kit/shell.css';
import './kit/diagrams.css';
import './app.css';

// Kit JS primitives populate window.BS (order matters: constants → icons → motion → reveal → …).
import './kit/constants.js';
import './kit/icons.js';
import './kit/motion.js';
import './kit/reveal.js';
import './kit/glass.js';
import './kit/diagrams.js';
import './kit/sheet.js';
import './kit/space.js';
import './kit/ui.js';

captureToken();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

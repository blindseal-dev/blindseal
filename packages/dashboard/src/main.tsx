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
import './kit/shell.js'; // BS.mountShell — the sidebar/top bar/status bar/route cover (Shell.tsx)

captureToken();

// React's root container IS <main id="main-content">: BS.mountShell adopts that element into the
// shell frame, and React 18 delegates events at its root container — so the container must be the
// element the shell moves, or clicks inside the pages would no longer reach React.
createRoot(document.getElementById('main-content')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

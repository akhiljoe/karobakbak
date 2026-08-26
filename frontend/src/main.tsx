import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import { Root } from './Root';
import './index.css';

const container = document.getElementById('root');
if (!container) throw new Error('missing #root');

createRoot(container).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);

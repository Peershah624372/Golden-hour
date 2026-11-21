import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import './index.css';
import CrewPage from './pages/Crew';
import DispatchPage from './pages/Dispatch';
import ErPage from './pages/Er';
import HomePage from './pages/Home';
import Placeholder from './pages/Placeholder';
import SosPage from './pages/Sos';
import FirstAidPage from './pages/FirstAidPage';
import { startQueueWorker } from './lib/queue';

// Level 3: any SOS saved while offline is retried on reconnect, on focus and every 15 s.
startQueueWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/sos" element={<SosPage />} />
        <Route path="/first-aid" element={<FirstAidPage />} />
        <Route path="/dispatch" element={<DispatchPage />} />
        <Route path="/crew" element={<CrewPage />} />
        <Route path="/er" element={<ErPage />} />
        <Route path="/admin" element={<Placeholder title="Admin Console" />} />
        <Route path="*" element={<Placeholder title="Page not found" />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);

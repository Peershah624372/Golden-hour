import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router';
import './index.css';
import { RequireRole } from './components/RequireRole';
import AdminPage from './pages/Admin';
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
        {/* Staff screens: the server enforces the same roles on every request and live channel. */}
        <Route path="/dispatch" element={<RequireRole screen="dispatch"><DispatchPage /></RequireRole>} />
        <Route path="/crew" element={<RequireRole screen="crew"><CrewPage /></RequireRole>} />
        <Route path="/er" element={<RequireRole screen="er"><ErPage /></RequireRole>} />
        <Route path="/admin" element={<RequireRole screen="admin"><AdminPage /></RequireRole>} />
        <Route path="*" element={<Placeholder title="Page not found" />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);

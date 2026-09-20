import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './theme.css';

createRoot(document.getElementById('root')).render(<App />);

// Registered for installability (see public/sw.js for why it caches nothing).
// Only in production: the dev server's HMR does not play well with a service
// worker intercepting requests, and there is no install prompt to earn there.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
}

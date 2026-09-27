import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './theme.css';

createRoot(document.getElementById('root')).render(<App />);

// The service worker keeps the app shell on the device, so the page opens
// with no network (see public/sw.js). Only in production: the dev server's HMR
// does not play well with a service worker intercepting requests.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js'));
}

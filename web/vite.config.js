import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    build: {
        // The API serves this directory as static files in production, so the
        // build lands where server/index.js expects it.
        outDir: 'dist',
    },
    server: {
        // In development the API runs separately on 8090; proxying keeps the
        // frontend's fetch('/api/...') and the /api/live socket identical in
        // both environments.
        proxy: {
            '/api': { target: 'http://localhost:8090', ws: true },
        },
    },
});

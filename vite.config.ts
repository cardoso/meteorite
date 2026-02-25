/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { playwright } from '@vitest/browser-playwright';

export default defineConfig({
    resolve: {
        alias: {
            'meteor': '/src/meteor'
        },
    },
    test: {
        include: ['**/*.spec.ts'],
        browser: {
            enabled: true,
            provider: playwright(),
            instances: [{browser: 'chromium', headless: true}] // Adjust as needed,
        }
    },
});
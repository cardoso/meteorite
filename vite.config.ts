/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
    resolve: {
        alias: {
            'meteor': '/src/meteor'
        },
    },
    test: {
        include: ['src/**/*.spec.ts'],
    },
});
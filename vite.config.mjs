import {defineConfig} from 'vite';
export default defineConfig({build:{rollupOptions:{input:{comparison:'index.html',range:'examples/range.html'}}}});

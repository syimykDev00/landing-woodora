import { defineConfig, loadEnv } from 'vite';
import leadHandler from './api/lead.js';

// В разработке обслуживаем /api/lead тем же обработчиком, что и на Vercel,
// чтобы форму можно было проверить через `npm run dev`.
function devApi() {
  return {
    name: 'dev-api',
    configureServer(server) {
      server.middlewares.use('/api/lead', (req, res) => leadHandler(req, res));
    },
  };
}

export default defineConfig(({ mode }) => {
  Object.assign(process.env, loadEnv(mode, process.cwd(), 'TELEGRAM_'));
  return { plugins: [devApi()] };
});

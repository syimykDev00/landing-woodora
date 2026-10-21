// Загрузка .env.local и .env для локальных скриптов (значения из терминала главнее файлов)
import { existsSync } from 'node:fs';

export function loadEnv() {
  for (const file of ['.env.local', '.env']) {
    if (existsSync(file)) process.loadEnvFile(file);
  }
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SECRET_KEY) {
    console.error('Нужны SUPABASE_URL и SUPABASE_SECRET_KEY (в .env или в окружении).');
    process.exit(1);
  }
}

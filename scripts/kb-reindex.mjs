// Переиндексация базы знаний из терминала: фрагменты + embeddings (если доступен AI Gateway).
//   npm run kb:reindex
// Для embeddings локально нужен AI_GATEWAY_API_KEY или свежий VERCEL_OIDC_TOKEN (vercel env pull).
import { loadEnv } from './env.mjs';

loadEnv();
const { indexAll } = await import('../server/kb.js');
const results = await indexAll();
const chunks = results.reduce((n, r) => n + r.chunks, 0);
const embedded = results.filter((r) => r.embedded).length;
console.log(`Документов: ${results.length}, фрагментов: ${chunks}, с embeddings: ${embedded}/${results.length}`);
if (embedded < results.length) console.log('Без embeddings работает полнотекстовый поиск. Причина — в сообщениях выше.');

// Переиндексация базы знаний из терминала: фрагменты + embeddings (если доступен OpenAI).
//   npm run kb:reindex
// Для embeddings нужен OPENAI_API_KEY в .env.
import { loadEnv } from './env.mjs';

loadEnv();
const { indexAll } = await import('../server/kb.js');
const results = await indexAll();
const chunks = results.reduce((n, r) => n + r.chunks, 0);
const embedded = results.filter((r) => r.embedded).length;
const fresh = results.reduce((n, r) => n + (r.embedded_new || 0), 0);
console.log(`Документов: ${results.length}, фрагментов: ${chunks}, с embeddings: ${embedded}/${results.length}, новых запросов к OpenAI embeddings: ${fresh} (остальные из кэша)`);
if (embedded < results.length) console.log('Без embeddings работает полнотекстовый поиск. Причина — в сообщениях выше.');

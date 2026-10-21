// База знаний (RAG): разбиение текста на фрагменты, embeddings OpenAI, индексация и поиск.
//
// Поиск гибридный (SQL-функция public.match_kb_chunks):
// - полнотекстовый (tsvector, русская морфология) работает всегда;
// - векторный (pgvector, cosine) — embeddings OpenAI text-embedding-3-small (1536 измерений,
//   столбец kb_chunks.embedding vector(1536)). Без ключа OpenAI поиск честно остаётся
//   полнотекстовым, а режим виден в ответе (mode) и в админке.
// Векторный поиск важен и для кыргызского языка: embeddings многоязычные, а полнотекстовый
// индекс построен по русской морфологии.
import { db, check } from './db.js';
import { openai, openaiConfigured, embeddingModel, openaiError } from './openai.js';

export const EMBEDDING_DIMENSIONS = 1536;
export { embeddingModel };

const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 150;
const EMBED_TIMEOUT_MS = 10_000;

// Делим по абзацам, длинные абзацы — по предложениям. Соседние фрагменты перекрываются
// хвостом предыдущего, чтобы ответ на стыке не терялся.
export function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  const normalized = String(text || '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!normalized) return [];

  const pieces = [];
  for (const paragraph of normalized.split(/\n\s*\n/)) {
    const p = paragraph.trim();
    if (!p) continue;
    if (p.length <= size) { pieces.push(p); continue; }
    const sentences = p.match(/[^.!?…\n]+[.!?…]*\s*|\n/g) || [p];
    let buf = '';
    for (const s of sentences) {
      if ((buf + s).length > size && buf) { pieces.push(buf.trim()); buf = ''; }
      if (s.length > size) {
        for (let i = 0; i < s.length; i += size) pieces.push(s.slice(i, i + size).trim());
      } else {
        buf += s;
      }
    }
    if (buf.trim()) pieces.push(buf.trim());
  }

  const chunks = [];
  let current = '';
  for (const piece of pieces) {
    if (current && (current.length + piece.length + 2) > size) {
      chunks.push(current);
      // Перекрытие начинаем с границы слова
      const tail = current.slice(-overlap);
      const cut = tail.search(/\s/);
      const carry = cut >= 0 ? tail.slice(cut + 1).trim() : '';
      current = carry ? `${carry}\n\n${piece}` : piece;
    } else {
      current = current ? `${current}\n\n${piece}` : piece;
    }
  }
  if (current) chunks.push(current);
  return chunks.filter((c) => c.trim().length > 0);
}

// null — embeddings недоступны (нет OPENAI_API_KEY, лимит, сеть). Причина — в лог.
export async function embedTexts(values) {
  if (!openaiConfigured() || !values.length) return values.length ? null : [];
  try {
    const result = await openai().embeddings.create(
      { model: embeddingModel(), input: values, dimensions: EMBEDDING_DIMENSIONS },
      { timeout: EMBED_TIMEOUT_MS * 3 },
    );
    const vectors = [...result.data].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (vectors.length !== values.length || vectors[0].length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`ожидалась размерность ${EMBEDDING_DIMENSIONS}, получено ${vectors[0]?.length}`);
    }
    return vectors;
  } catch (err) {
    console.error('embeddings недоступны:', openaiError(err));
    return null;
  }
}

async function embedQuery(text) {
  const vectors = await embedTexts([text]);
  return vectors ? vectors[0] : null;
}

// Векторы уже проиндексированных фрагментов: при переиндексации неизменённый текст
// не отправляется в OpenAI повторно (экономия запросов embeddings)
async function existingEmbeddings(documentId) {
  const rows = check(
    await db().from('kb_chunks').select('content,embedding').eq('document_id', documentId).not('embedding', 'is', null),
    'kb_chunks cache',
  );
  const map = new Map();
  for (const r of rows) {
    const vector = typeof r.embedding === 'string' ? JSON.parse(r.embedding) : r.embedding;
    if (Array.isArray(vector) && vector.length === EMBEDDING_DIMENSIONS) map.set(r.content, vector);
  }
  return map;
}

// Перестраивает фрагменты одного документа. Возвращает { chunks, embedded, embedded_new }.
export async function indexDocument(documentId) {
  const client = db();
  const doc = check(
    await client.from('kb_documents').select('id,title,content').eq('id', documentId).maybeSingle(),
    'kb_documents select',
  );
  if (!doc) throw new Error('документ не найден');

  // Заголовок добавляем в каждый фрагмент: «Гарантия: ...» находится и по слову из заголовка
  const parts = chunkText(doc.content).map((c) => `${doc.title}\n${c}`);
  const cache = await existingEmbeddings(doc.id);
  const missing = [...new Set(parts.filter((p) => !cache.has(p)))];
  const fresh = await embedTexts(missing);
  if (fresh) missing.forEach((p, i) => cache.set(p, fresh[i]));
  // Векторы должны быть у всех фрагментов — иначе документ индексируется без них (полнотекстовый поиск)
  const vectors = parts.length && parts.every((p) => cache.has(p)) ? parts.map((p) => cache.get(p)) : null;

  check(await client.from('kb_chunks').delete().eq('document_id', doc.id), 'kb_chunks delete');
  if (parts.length) {
    const rows = parts.map((content, i) => ({
      document_id: doc.id,
      chunk_index: i,
      content,
      embedding: vectors ? vectors[i] : null,
    }));
    check(await client.from('kb_chunks').insert(rows), 'kb_chunks insert');
  }
  check(
    await client.from('kb_documents')
      .update({ indexed_at: new Date().toISOString(), embedding_model: vectors ? embeddingModel() : null })
      .eq('id', doc.id),
    'kb_documents update',
  );
  return { chunks: parts.length, embedded: Boolean(vectors), embedded_new: fresh ? missing.length : 0 };
}

export async function indexAll() {
  const docs = check(await db().from('kb_documents').select('id').order('id'), 'kb_documents list');
  const results = [];
  for (const { id } of docs) results.push({ id, ...(await indexDocument(id)) });
  return results;
}

// Поиск фрагментов для ответа агента. mode: 'hybrid' (векторы + полнотекстовый) или 'fulltext'.
export async function searchKnowledge(query, limit = 5) {
  const text = String(query || '').trim().slice(0, 500);
  if (!text) return { mode: 'fulltext', results: [] };

  const { count } = await db().from('kb_chunks').select('id', { count: 'exact', head: true }).not('embedding', 'is', null);
  const embedding = count ? await embedQuery(text) : null;

  const rows = check(
    await db().rpc('match_kb_chunks', { query_text: text, query_embedding: embedding, match_count: limit }),
    'match_kb_chunks',
  );
  return {
    mode: embedding ? 'hybrid' : 'fulltext',
    results: (rows || []).map((r) => ({
      document_id: r.document_id, title: r.title, kind: r.kind, content: r.content, score: Number(r.score.toFixed(4)),
    })),
  };
}

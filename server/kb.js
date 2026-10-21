// База знаний (RAG): разбиение текста на фрагменты, embeddings, индексация и поиск.
//
// Поиск гибридный (SQL-функция public.match_kb_chunks):
// - полнотекстовый (tsvector, русская морфология) работает всегда;
// - векторный (pgvector, cosine) — если у фрагментов есть embeddings и удалось получить
//   embedding вопроса через Vercel AI Gateway. Без доступа к модели embeddings поиск честно
//   остаётся полнотекстовым, а режим виден в ответе (mode) и в админке.
import { embed, embedMany } from 'ai';
import { db, check } from './db.js';

export const EMBEDDING_DIMENSIONS = 1536;
export const embeddingModel = () => process.env.AI_EMBEDDING_MODEL || 'openai/text-embedding-3-small';

const CHUNK_SIZE = 900;
const CHUNK_OVERLAP = 150;
const EMBED_TIMEOUT_MS = 8000;

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

// null — модель embeddings недоступна (нет ключа/OIDC, нет кредитов, сеть). Причина — в лог.
export async function embedTexts(values) {
  try {
    const { embeddings } = await embedMany({
      model: embeddingModel(),
      values,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(EMBED_TIMEOUT_MS * 3),
    });
    if (!embeddings?.length || embeddings[0].length !== EMBEDDING_DIMENSIONS) {
      throw new Error(`ожидалась размерность ${EMBEDDING_DIMENSIONS}, получено ${embeddings?.[0]?.length}`);
    }
    return embeddings;
  } catch (err) {
    console.error('embeddings недоступны:', String(err?.message || err).slice(0, 300));
    return null;
  }
}

async function embedQuery(text) {
  try {
    const { embedding } = await embed({
      model: embeddingModel(),
      value: text,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(EMBED_TIMEOUT_MS),
    });
    return embedding?.length === EMBEDDING_DIMENSIONS ? embedding : null;
  } catch (err) {
    console.error('embedding вопроса недоступен:', String(err?.message || err).slice(0, 300));
    return null;
  }
}

// Перестраивает фрагменты одного документа. Возвращает { chunks, embedded }.
export async function indexDocument(documentId) {
  const client = db();
  const doc = check(
    await client.from('kb_documents').select('id,title,content').eq('id', documentId).maybeSingle(),
    'kb_documents select',
  );
  if (!doc) throw new Error('документ не найден');

  // Заголовок добавляем в каждый фрагмент: «Гарантия: ...» находится и по слову из заголовка
  const parts = chunkText(doc.content).map((c) => `${doc.title}\n${c}`);
  const vectors = parts.length ? await embedTexts(parts) : null;

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
  return { chunks: parts.length, embedded: Boolean(vectors) };
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

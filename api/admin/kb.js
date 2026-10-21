// База знаний: операции, которым нужен сервер (только для администратора).
// POST /api/admin/kb
//   { action: 'reindex', document_id }  — перестроить фрагменты и embeddings документа
//   { action: 'reindex_all' }           — перестроить всё
//   { action: 'upload', filename, title?, kind?, data_base64 } — загрузить .txt/.md/.pdf,
//       извлечь текст, создать документ и проиндексировать
//   { action: 'search', query }         — проверка поиска (то же, что видит AI-агент)
// Обычное создание/редактирование документов админка делает напрямую через Supabase (RLS).
import { send, readBody, BodyTooLarge, safeError } from '../lead.js';
import { db, dbConfigured, check } from '../../server/db.js';
import { requireAdmin, HttpError } from '../../server/auth.js';
import { indexDocument, indexAll, searchKnowledge, embeddingModel } from '../../server/kb.js';

const MAX_BODY = 4 * 1024 * 1024; // предел тела функции Vercel — 4,5 МБ
const KINDS = new Set(['company', 'faq', 'product', 'service', 'policy', 'article', 'file']);

async function extractText(filename, buffer) {
  const ext = filename.toLowerCase().split('.').pop();
  if (ext === 'pdf') {
    const { extractText: pdfText, getDocumentProxy } = await import('unpdf');
    const pdf = await getDocumentProxy(new Uint8Array(buffer));
    const { text } = await pdfText(pdf, { mergePages: true });
    return text;
  }
  if (['txt', 'md', 'markdown', 'csv'].includes(ext)) return buffer.toString('utf8');
  throw new HttpError(400, 'Поддерживаются файлы .txt, .md, .csv и .pdf');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { ok: false, error: 'Метод не поддерживается' });
  }
  if (!dbConfigured()) return send(res, 500, { ok: false, error: 'Сервер не настроен' });

  try {
    await requireAdmin(req);

    let body;
    try {
      body = await readBody(req, MAX_BODY);
    } catch (err) {
      if (err instanceof BodyTooLarge) throw new HttpError(413, 'Файл слишком большой (до 3 МБ)');
      throw new HttpError(400, 'Некорректный запрос');
    }

    switch (body?.action) {
      case 'reindex': {
        const id = Number(body.document_id);
        if (!Number.isInteger(id)) throw new HttpError(400, 'Не указан документ');
        const result = await indexDocument(id);
        return send(res, 200, { ok: true, ...result, model: result.embedded ? embeddingModel() : null });
      }
      case 'reindex_all': {
        const results = await indexAll();
        return send(res, 200, {
          ok: true,
          documents: results.length,
          chunks: results.reduce((n, r) => n + r.chunks, 0),
          embedded: results.length > 0 && results.every((r) => r.embedded),
          model: embeddingModel(),
        });
      }
      case 'upload': {
        const filename = String(body.filename || '').slice(0, 200);
        if (!filename || typeof body.data_base64 !== 'string') throw new HttpError(400, 'Нет файла');
        const text = (await extractText(filename, Buffer.from(body.data_base64, 'base64'))).trim();
        if (text.length < 20) throw new HttpError(400, 'В файле не найден текст (для сканов PDF нужен OCR)');
        const kind = KINDS.has(body.kind) ? body.kind : 'file';
        const title = String(body.title || filename.replace(/\.[^.]+$/, '')).trim().slice(0, 200) || filename;
        const doc = check(
          await db().from('kb_documents')
            .insert({ title, kind, content: text.slice(0, 200000), source_filename: filename })
            .select('id').single(),
          'kb_documents insert',
        );
        const result = await indexDocument(doc.id);
        return send(res, 200, { ok: true, document_id: doc.id, characters: text.length, ...result });
      }
      case 'search': {
        const query = String(body.query || '').trim();
        if (query.length < 2) throw new HttpError(400, 'Введите запрос');
        return send(res, 200, { ok: true, ...(await searchKnowledge(query, 6)) });
      }
      default:
        throw new HttpError(400, 'Неизвестное действие');
    }
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { ok: false, error: err.message });
    console.error('admin/kb:', safeError(err));
    return send(res, 500, { ok: false, error: 'Ошибка сервера' });
  }
}

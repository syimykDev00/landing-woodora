// AI-чат на лендинге: плавающая кнопка и окно переписки.
// Ответы формирует сервер (/api/chat) — языковая модель с доступом к каталогу, базе знаний
// и настройкам компании из CRM. Ключей в браузере нет; здесь только интерфейс.

const SESSION_KEY = 'woodora.chat.session';
const SUGGESTIONS = ['Помогите выбрать диван', 'Как проходит доставка?', 'Можно сделать по моим размерам?'];

const ICON_CHAT = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v11H8l-4 4z"/><path d="M8 9h8M8 12h5"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const ICON_SEND = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h15M13 6l6 6-6 6"/></svg>';

const storage = {
  get() { try { return localStorage.getItem(SESSION_KEY); } catch { return null; } },
  set(id) { try { localStorage.setItem(SESSION_KEY, id); } catch { /* приватный режим */ } },
  clear() { try { localStorage.removeItem(SESSION_KEY); } catch { /* приватный режим */ } },
};

const root = document.createElement('div');
root.className = 'chat';
root.innerHTML = `
  <section class="chat__panel" id="chat-panel" role="dialog" aria-modal="false" aria-labelledby="chat-title" hidden>
    <header class="chat__head">
      <span class="chat__avatar" aria-hidden="true"></span>
      <div class="chat__title-wrap">
        <h2 class="chat__title" id="chat-title">Помощник WOODORA</h2>
        <p class="chat__subtitle">ИИ-консультант · отвечает по данным компании</p>
      </div>
      <button type="button" class="chat__icon-btn" data-chat-reset title="Новый диалог" aria-label="Начать новый диалог">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12a8 8 0 1 0 2.4-5.7M4 4v4h4"/></svg>
      </button>
      <button type="button" class="chat__icon-btn" data-chat-close aria-label="Закрыть чат">${ICON_CLOSE}</button>
    </header>
    <div class="chat__log" data-chat-log aria-live="polite"></div>
    <div class="chat__suggestions" data-chat-suggestions></div>
    <form class="chat__form" data-chat-form>
      <label class="visually-hidden" for="chat-input">Сообщение</label>
      <textarea id="chat-input" rows="1" maxlength="1000" placeholder="Напишите вопрос…" autocomplete="off"></textarea>
      <button type="submit" class="chat__send" aria-label="Отправить">${ICON_SEND}</button>
    </form>
    <p class="chat__note">ИИ может ошибаться. Цены и сроки подтвердит менеджер.</p>
  </section>
  <button type="button" class="chat__toggle" aria-controls="chat-panel" aria-expanded="false">
    <span class="chat__toggle-icon">${ICON_CHAT}</span>
    <span class="chat__toggle-label">Спросить ИИ</span>
  </button>`;
document.body.append(root);

const panel = root.querySelector('.chat__panel');
const toggle = root.querySelector('.chat__toggle');
const log = root.querySelector('[data-chat-log]');
const form = root.querySelector('[data-chat-form]');
const input = form.querySelector('textarea');
const sendButton = form.querySelector('.chat__send');
const suggestions = root.querySelector('[data-chat-suggestions]');

const state = { loaded: false, busy: false, greeting: '', enabled: true };

function bubble(role, text = '') {
  const el = document.createElement('div');
  el.className = `chat__msg chat__msg--${role}`;
  // textContent — ответ модели никогда не вставляется как HTML
  el.textContent = text;
  log.append(el);
  log.scrollTop = log.scrollHeight;
  return el;
}

// Модель иногда добавляет **жирный** — убираем разметку, оставляем текст
const plain = (text) => text.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^#+\s*/gm, '');

function renderSuggestions(show) {
  suggestions.innerHTML = '';
  if (!show) return;
  SUGGESTIONS.forEach((text) => {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'chat__chip';
    chip.textContent = text;
    chip.addEventListener('click', () => send(text));
    suggestions.append(chip);
  });
}

async function load() {
  if (state.loaded) return;
  state.loaded = true;
  try {
    const sessionId = storage.get();
    const response = await fetch(`/api/chat${sessionId ? `?session_id=${encodeURIComponent(sessionId)}` : ''}`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error);
    state.enabled = data.enabled;
    state.greeting = data.greeting;
    root.querySelector('.chat__title').textContent = data.bot_name;
    if (!data.enabled) {
      bubble('system', 'Чат временно отключён. Оставьте заявку через форму на сайте — менеджер свяжется с вами.');
      setDisabled(true);
      return;
    }
    if (data.greeting) bubble('assistant', data.greeting);
    data.messages.forEach((m) => bubble(m.role, plain(m.content)));
    renderSuggestions(data.messages.length === 0);
  } catch {
    bubble('system', 'Не удалось подключиться к чату. Попробуйте позже или оставьте заявку через форму.');
  }
}

function setDisabled(disabled) {
  input.disabled = disabled;
  sendButton.disabled = disabled;
}

function setOpen(open) {
  panel.hidden = !open;
  toggle.setAttribute('aria-expanded', String(open));
  root.classList.toggle('chat--open', open);
  if (open) {
    load();
    setTimeout(() => input.focus(), 50);
  }
}

async function send(text) {
  const message = text.trim();
  if (!message || state.busy || !state.enabled) return;
  state.busy = true;
  setDisabled(true);
  renderSuggestions(false);
  bubble('user', message);
  input.value = '';
  autoresize();

  const typing = bubble('assistant', '');
  typing.classList.add('chat__msg--typing');
  typing.innerHTML = '<span></span><span></span><span></span>';

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, session_id: storage.get() }),
    });

    const isJson = (response.headers.get('Content-Type') || '').includes('application/json');
    if (!response.ok || isJson) {
      const data = await response.json().catch(() => ({}));
      if (data.session_id) storage.set(data.session_id);
      throw new Error(data.error || 'Ошибка сервера');
    }

    const sessionId = response.headers.get('X-Chat-Session');
    if (sessionId) storage.set(sessionId);

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let reply = '';
    typing.classList.remove('chat__msg--typing');
    typing.textContent = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      reply += decoder.decode(value, { stream: true });
      typing.textContent = plain(reply);
      log.scrollTop = log.scrollHeight;
    }
    reply += decoder.decode();
    typing.textContent = plain(reply);
  } catch (err) {
    typing.remove();
    const msg = err instanceof TypeError ? 'Нет соединения с сервером.' : err.message;
    bubble('system', msg);
  } finally {
    state.busy = false;
    setDisabled(false);
    input.focus();
  }
}

function autoresize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
}

toggle.addEventListener('click', () => setOpen(panel.hidden));
root.querySelector('[data-chat-close]').addEventListener('click', () => setOpen(false));
root.querySelector('[data-chat-reset]').addEventListener('click', () => {
  if (state.busy) return;
  storage.clear();
  log.innerHTML = '';
  if (state.greeting && state.enabled) bubble('assistant', state.greeting);
  renderSuggestions(state.enabled);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !panel.hidden) setOpen(false);
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  send(input.value);
});
input.addEventListener('input', autoresize);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send(input.value);
  }
});

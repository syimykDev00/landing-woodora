import { products, ROOMS, formatPrice } from './products.js';

const ICON_ARROW = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';

const grid = document.getElementById('products');
const empty = document.getElementById('catalog-empty');
const chips = document.querySelectorAll('#catalog-filters .chip');
const searchInput = document.getElementById('catalog-search');
const catalog = document.getElementById('catalog');

const state = { filter: 'all', query: '' };

/* ============ Каталог ============ */

const normalize = (text) => text.toLowerCase().replace(/ё/g, 'е').trim();

function productCard(p) {
  const badge = p.oldPrice
    ? `<span class="badge badge--sale">−${Math.round((1 - p.price / p.oldPrice) * 100)}%</span>`
    : p.isNew ? '<span class="badge">Новинка</span>' : '';
  const oldPrice = p.oldPrice ? ` <s>${formatPrice(p.oldPrice)}</s>` : '';

  return `
    <article class="product">
      <div class="product__media">
        ${badge}
        <img src="${p.image}" alt="${p.name}" loading="lazy">
      </div>
      <div class="product__body">
        <p class="product__material">${p.material}</p>
        <h3 class="product__name">${p.name}</h3>
        <div class="product__footer">
          <p class="price">${formatPrice(p.price)}${oldPrice}</p>
          <button type="button" class="btn-order" data-order="${p.id}">Заказать ${ICON_ARROW}</button>
        </div>
      </div>
    </article>`;
}

function matches(p) {
  if (state.filter === 'new' && !p.isNew) return false;
  if (state.filter !== 'all' && state.filter !== 'new' && p.room !== state.filter) return false;
  if (!state.query) return true;
  const haystack = normalize(`${p.name} ${p.material} ${ROOMS[p.room]}`);
  return normalize(state.query).split(/\s+/).every((word) => haystack.includes(word));
}

function renderCatalog() {
  const list = products.filter(matches);
  grid.innerHTML = list.map(productCard).join('');
  empty.hidden = list.length > 0;

  chips.forEach((chip) => {
    const active = chip.dataset.filter === state.filter;
    chip.classList.toggle('chip--active', active);
    chip.setAttribute('aria-pressed', String(active));
  });
}

function setFilter(filter, { resetQuery = false } = {}) {
  state.filter = filter;
  if (resetQuery) {
    state.query = '';
    searchInput.value = '';
  }
  renderCatalog();
}

// Фильтры: чипы каталога, карточки категорий, ссылки в футере
document.addEventListener('click', (e) => {
  const trigger = e.target.closest('[data-filter]');
  if (!trigger) return;
  const fromChips = trigger.closest('#catalog-filters');
  setFilter(trigger.dataset.filter, { resetQuery: !fromChips });
});

document.querySelector('[data-reset-filters]').addEventListener('click', () => {
  setFilter('all', { resetQuery: true });
  searchInput.focus();
});

searchInput.addEventListener('input', () => {
  state.query = searchInput.value;
  renderCatalog();
});

// Кнопка поиска в шапке ведёт к полю поиска в каталоге
document.querySelector('[data-search-open]').addEventListener('click', () => {
  catalog.scrollIntoView({ behavior: 'smooth' });
  searchInput.focus({ preventScroll: true });
});

/* ============ Мобильное меню ============ */

const menuToggle = document.getElementById('menu-toggle');
document.querySelectorAll('.nav__link').forEach((link) => {
  link.addEventListener('click', () => { menuToggle.checked = false; });
});

/* ============ Модальное окно заказа ============ */

const modal = document.getElementById('order-modal');
const modalFields = {
  image: modal.querySelector('[data-modal-image]'),
  material: modal.querySelector('[data-modal-material]'),
  name: modal.querySelector('[data-modal-name]'),
  price: modal.querySelector('[data-modal-price]'),
  product: modal.querySelector('[data-modal-product]'),
};

function openOrder(id) {
  const p = products.find((item) => item.id === id);
  if (!p) return;
  const form = modal.querySelector('form');
  form.reset();
  setStatus(form, '');
  // reset() не снимает подсветку ошибок с прошлой попытки
  form.querySelectorAll('[aria-invalid]').forEach((field) => field.removeAttribute('aria-invalid'));

  modalFields.image.src = p.image;
  modalFields.image.alt = p.name;
  modalFields.material.textContent = p.material;
  modalFields.name.textContent = p.name;
  modalFields.price.textContent = formatPrice(p.price);
  modalFields.product.value = `${p.name} — ${formatPrice(p.price)}`;

  modal.showModal();
}

document.addEventListener('click', (e) => {
  const trigger = e.target.closest('[data-order]');
  if (trigger) openOrder(trigger.dataset.order);
});

modal.querySelector('[data-modal-close]').addEventListener('click', () => modal.close());
// Закрытие по клику на подложку
modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.close();
});

/* ============ Формы заявки ============ */

const productSelect = document.querySelector('[data-product-select]');
products.forEach((p) => {
  productSelect.add(new Option(`${p.name} — ${formatPrice(p.price)}`, p.name));
});

function setStatus(form, text, type = '') {
  const status = form.querySelector('.form-status');
  status.textContent = text;
  status.dataset.type = type;
}

function validate(form) {
  const { name, phone, quantity } = form.elements;
  const checks = [
    [name, name.value.trim().length >= 2, 'Укажите ваше имя'],
    [phone, phone.value.replace(/\D/g, '').length >= 9, 'Укажите номер телефона'],
  ];
  // Количество: целое число от 1 до 99 (то же правило проверяет сервер)
  if (quantity) {
    const value = quantity.value.trim();
    checks.push([quantity, /^\d+$/.test(value) && +value >= 1 && +value <= 99, 'Укажите количество от 1 до 99']);
  }

  checks.forEach(([field, ok]) => field.toggleAttribute('aria-invalid', !ok));
  const failed = checks.find(([, ok]) => !ok);
  if (failed) {
    setStatus(form, failed[2], 'error');
    failed[0].focus();
    return false;
  }
  return true;
}

document.querySelectorAll('[data-lead-form]').forEach((form) => {
  form.addEventListener('input', (e) => e.target.removeAttribute('aria-invalid'));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!validate(form)) return;

    const button = form.querySelector('[type="submit"]');
    button.disabled = true;
    setStatus(form, 'Отправляем…');

    try {
      const response = await fetch('/api/lead', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.fromEntries(new FormData(form))),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !result.ok) throw new Error(result.error || 'Ошибка отправки');

      form.reset();
      setStatus(form, 'Спасибо! Заявка отправлена — мы скоро свяжемся с вами.', 'success');
    } catch (err) {
      const message = err instanceof TypeError ? 'Нет соединения с сервером' : err.message;
      setStatus(form, `${message}. Попробуйте ещё раз или позвоните нам.`, 'error');
    } finally {
      button.disabled = false;
    }
  });
});

/* ============ Прочее ============ */

document.querySelector('[data-year]').textContent = new Date().getFullYear();

renderCatalog();

// Каталог товаров. Цены и названия — временные, заменить на реальные.
// room: living | bedroom | dining | office | decor

const img = (id) => `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=800&q=80`;

export const ROOMS = {
  living: 'Гостиная',
  bedroom: 'Спальня',
  dining: 'Столовая',
  office: 'Кабинет',
  decor: 'Декор',
};

export const products = [
  {
    id: 'fjord-sofa',
    name: 'Диван «Фьорд»',
    material: 'Дуб · рогожка',
    room: 'living',
    price: 84900,
    image: img('1540574163026-643ea20ade25'),
  },
  {
    id: 'skandi-chair',
    name: 'Кресло «Сканди»',
    material: 'Ясень · букле',
    room: 'living',
    price: 32000,
    isNew: true,
    image: img('1567538096630-e0c55bd6374c'),
  },
  {
    id: 'soder-sofa',
    name: 'Диван «Сёдер»',
    material: 'Дуб · велюр',
    room: 'living',
    price: 92000,
    image: img('1555041469-a586c61ea9bc'),
  },
  {
    id: 'nord-bed',
    name: 'Кровать «Норд»',
    material: 'Массив дуба · 160×200',
    room: 'bedroom',
    price: 68000,
    image: img('1617806118233-18e1de247200'),
  },
  {
    id: 'olma-table',
    name: 'Стол «Ольма»',
    material: 'Массив дуба',
    room: 'dining',
    price: 57000,
    image: img('1533090481720-856c6e3c1fdc'),
  },
  {
    id: 'bergen-chair',
    name: 'Стул «Берген»',
    material: 'Дуб · лён',
    room: 'dining',
    price: 13900,
    image: img('1592078615290-033ee584e267'),
  },
  {
    id: 'lund-stool',
    name: 'Табурет «Лунд»',
    material: 'Бук · масло-воск',
    room: 'dining',
    price: 6900,
    oldPrice: 8100,
    image: img('1503602642458-232111445657'),
  },
  {
    id: 'trond-dining',
    name: 'Обеденная группа «Тронд»',
    material: 'Ясень · стол и 4 стула',
    room: 'dining',
    price: 95000,
    isNew: true,
    image: img('1617104678098-de229db51175'),
  },
  {
    id: 'knut-desk',
    name: 'Рабочий стол «Кнут»',
    material: 'Дуб · сталь',
    room: 'office',
    price: 38500,
    image: img('1518455027359-f3f8164ba6bd'),
  },
  {
    id: 'mala-lamp',
    name: 'Торшер «Мала»',
    material: 'Ясень · льняной абажур',
    room: 'decor',
    price: 11500,
    isNew: true,
    image: img('1507473885765-e6ed057f782c'),
  },
  {
    id: 'linne-decor',
    name: 'Набор декора «Линне»',
    material: 'Дерево · керамика · лён',
    room: 'decor',
    price: 4900,
    image: img('1532372320572-cda25653a26d'),
  },
];

export function formatPrice(value) {
  return `${value.toLocaleString('ru-RU')} сом`;
}

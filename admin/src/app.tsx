import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, supabaseConfigured } from './supabase';
import { Button, Spinner, useHashRoute } from './ui';
import { Dashboard } from './pages/Dashboard';
import { Applications } from './pages/Applications';
import { Clients } from './pages/Clients';
import { Orders } from './pages/Orders';
import { Products } from './pages/Products';
import { Analytics } from './pages/Analytics';
import { Knowledge } from './pages/Knowledge';
import { Chats } from './pages/Chats';
import { Settings } from './pages/Settings';

const icon = (d: string) => <svg viewBox="0 0 24 24" aria-hidden="true"><path d={d} /></svg>;

const NAV: { page: string; label: string; icon: ReactNode; group?: string }[] = [
  { page: 'dashboard', label: 'Обзор', icon: icon('M4 13h6V4H4zM14 20h6v-9h-6zM4 20h6v-4H4zM14 4v4h6V4z') },
  { page: 'applications', label: 'Заявки', icon: icon('M5 4h14v16H5zM9 9h6M9 13h6M9 17h3') },
  { page: 'clients', label: 'Клиенты', icon: icon('M16 19v-1a4 4 0 0 0-8 0v1M12 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6M20 19v-1a3 3 0 0 0-2-2.8M17 5.2a3 3 0 0 1 0 5.6') },
  { page: 'orders', label: 'Заказы', icon: icon('M3 7h11v9H3zM14 10h4l3 3v3h-7M7 19a2 2 0 1 0 0-.1M17 19a2 2 0 1 0 0-.1') },
  { page: 'products', label: 'Каталог', icon: icon('M4 10h16v6H4zM6 16v3M18 16v3M7 10V7a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v3') },
  { page: 'analytics', label: 'Аналитика', icon: icon('M4 20V10M10 20V4M16 20v-7M22 20H2'), group: 'Анализ' },
  { page: 'chats', label: 'AI-диалоги', icon: icon('M4 5h16v11H8l-4 4zM8 9h8M8 12h5') },
  { page: 'knowledge', label: 'База знаний', icon: icon('M5 4h10l4 4v12H5zM14 4v5h5M8 13h8M8 17h5'), group: 'AI-агент' },
  { page: 'settings', label: 'Настройки', icon: icon('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6a7 7 0 0 0 0 2.4l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2') },
];

type AuthState = { status: 'loading' } | { status: 'signed-out' } | { status: 'denied'; session: Session } | { status: 'admin'; session: Session };

export function App() {
  const [auth, setAuth] = useState<AuthState>({ status: 'loading' });

  useEffect(() => {
    if (!supabaseConfigured) return;
    let active = true;
    const resolve = async (session: Session | null) => {
      if (!session) { if (active) setAuth({ status: 'signed-out' }); return; }
      // Права проверяет база (public.is_admin) — без строки в admins данные всё равно закрыты RLS
      const { data, error } = await supabase.rpc('is_admin');
      if (!active) return;
      setAuth(!error && data === true ? { status: 'admin', session } : { status: 'denied', session });
    };
    supabase.auth.getSession().then(({ data }) => resolve(data.session));
    const { data: sub } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' || event === 'SIGNED_OUT' || event === 'USER_UPDATED') resolve(session);
    });
    return () => { active = false; sub.subscription.unsubscribe(); };
  }, []);

  if (!supabaseConfigured) {
    return (
      <AuthScreen>
        <p className="auth__error">Админка не настроена: при сборке не заданы SUPABASE_URL и SUPABASE_PUBLISHABLE_KEY.</p>
      </AuthScreen>
    );
  }
  if (auth.status === 'loading') return <div className="boot"><Spinner /></div>;
  if (auth.status === 'signed-out') return <Login />;
  if (auth.status === 'denied') {
    return (
      <AuthScreen>
        <p className="auth__error">У аккаунта {auth.session.user.email} нет прав администратора.</p>
        <p className="muted">Права выдаёт владелец проекта командой <code>npm run admin:create</code>.</p>
        <Button onClick={() => supabase.auth.signOut()}>Выйти</Button>
      </AuthScreen>
    );
  }
  return <Shell session={auth.session} />;
}

function AuthScreen({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <div className="auth__card">
        <div className="brand brand--dark"><span className="brand__mark" />WOODORA <small>CRM</small></div>
        {children}
      </div>
    </div>
  );
}

function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const { error: err } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
    setBusy(false);
    if (err) setError(err.message === 'Invalid login credentials' ? 'Неверный email или пароль' : err.message);
  }

  return (
    <AuthScreen>
      <h1 className="auth__title">Вход в панель управления</h1>
      <form className="auth__form" onSubmit={submit}>
        <label className="field">
          <span className="field__label">Email</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="field">
          <span className="field__label">Пароль</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="auth__error" role="alert">{error}</p>}
        <Button type="submit" variant="primary" loading={busy}>Войти</Button>
      </form>
      <p className="muted auth__note">Регистрации нет: доступ выдаёт владелец проекта.</p>
    </AuthScreen>
  );
}

function Shell({ session }: { session: Session }) {
  const route = useHashRoute();
  const [menuOpen, setMenuOpen] = useState(false);
  const [newCount, setNewCount] = useState<number | null>(null);

  // Счётчик новых заявок в меню — обновляется при переходах и раз в минуту
  useEffect(() => {
    let active = true;
    const load = async () => {
      const { count } = await supabase.from('applications').select('id', { count: 'exact', head: true }).eq('status', 'new');
      if (active) setNewCount(count ?? null);
    };
    load();
    const timer = setInterval(load, 60_000);
    return () => { active = false; clearInterval(timer); };
  }, [route.page]);

  useEffect(() => { setMenuOpen(false); window.scrollTo(0, 0); }, [route.page]);

  const current = NAV.find((n) => n.page === route.page) ? route.page : 'dashboard';

  const page = (() => {
    switch (current) {
      case 'applications': return <Applications routeId={route.id} />;
      case 'clients': return <Clients routeId={route.id} />;
      case 'orders': return <Orders routeId={route.id} />;
      case 'products': return <Products />;
      case 'analytics': return <Analytics />;
      case 'chats': return <Chats routeId={route.id} />;
      case 'knowledge': return <Knowledge />;
      case 'settings': return <Settings />;
      default: return <Dashboard />;
    }
  })();

  let lastGroup: string | undefined;

  return (
    <div className={`shell ${menuOpen ? 'shell--menu' : ''}`}>
      <aside className="sidebar">
        <div className="brand"><span className="brand__mark" />WOODORA <small>CRM</small></div>
        <nav className="nav" aria-label="Разделы">
          {NAV.map((item) => {
            const heading = item.group && item.group !== lastGroup ? item.group : null;
            if (item.group) lastGroup = item.group;
            return (
              <div key={item.page}>
                {heading && <p className="nav__group">{heading}</p>}
                <a href={`#/${item.page}`} className={`nav__link ${current === item.page ? 'is-active' : ''}`} aria-current={current === item.page ? 'page' : undefined}>
                  {item.icon}
                  <span>{item.label}</span>
                  {item.page === 'applications' && newCount ? <span className="nav__count" title="Новые заявки">{newCount}</span> : null}
                </a>
              </div>
            );
          })}
        </nav>
        <div className="sidebar__foot">
          <a className="nav__link" href="/" target="_blank" rel="noopener">
            {icon('M14 4h6v6M20 4l-9 9M18 14v6H4V6h6')}<span>Открыть сайт</span>
          </a>
          <div className="user">
            <span className="user__email" title={session.user.email}>{session.user.email}</span>
            <button type="button" className="link-btn" onClick={() => supabase.auth.signOut()}>Выйти</button>
          </div>
        </div>
      </aside>
      <div className="sidebar-backdrop" onClick={() => setMenuOpen(false)} />
      <div className="main">
        <header className="topbar">
          <button type="button" className="icon-btn" onClick={() => setMenuOpen(true)} aria-label="Открыть меню">
            {icon('M4 7h16M4 12h16M4 17h16')}
          </button>
          <div className="brand brand--dark"><span className="brand__mark" />WOODORA</div>
        </header>
        <main className="content">{page}</main>
      </div>
    </div>
  );
}

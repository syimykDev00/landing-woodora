-- AI через OpenAI: источник заявок и клиентов из чата — 'ai_chat'; учёт токенов по каждому ответу.
-- Применять после 20261021120200_phone_national_digits.sql.

begin;

-- Источник 'chat' → 'ai_chat'
alter table public.applications drop constraint applications_source_check;
update public.applications set source = 'ai_chat' where source = 'chat';
alter table public.applications add constraint applications_source_check
  check (source in ('site', 'modal', 'ai_chat', 'manual'));

alter table public.clients drop constraint if exists clients_source_check;
update public.clients set source = 'ai_chat' where source = 'chat';
alter table public.clients add constraint clients_source_check
  check (source in ('site', 'ai_chat', 'manual', 'phone', 'showroom', 'other'));

-- Токены и модель каждого ответа агента (контроль расходов в админке)
alter table public.chat_messages
  add column if not exists model text,
  add column if not exists input_tokens integer check (input_tokens is null or input_tokens >= 0),
  add column if not exists output_tokens integer check (output_tokens is null or output_tokens >= 0);

alter table public.chat_sessions
  add column if not exists input_tokens integer not null default 0,
  add column if not exists output_tokens integer not null default 0;

-- create_application: клиент из чата получает источник 'ai_chat'
create or replace function public.create_application(
  p_name text,
  p_phone text,
  p_source text,
  p_product_id text default null,
  p_product_name text default null,
  p_quantity integer default 1,
  p_comment text default null,
  p_chat_session_id uuid default null
)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  all_digits text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
  digits text := right(all_digits, 9);
  v_client_id bigint;
  v_product_id text;
  v_app_id bigint;
begin
  if char_length(all_digits) < 9 then
    raise exception 'invalid phone' using errcode = '22023';
  end if;

  select id into v_client_id from public.clients where phone_digits = digits;
  if v_client_id is null then
    insert into public.clients (name, phone, source)
    values (btrim(p_name), btrim(p_phone), case when p_source = 'ai_chat' then 'ai_chat' else 'site' end)
    on conflict (phone_digits) where phone_digits is not null do update set updated_at = now()
    returning id into v_client_id;
  end if;

  if p_product_id is not null then
    select id into v_product_id from public.products where id = p_product_id;
  end if;

  insert into public.applications
    (customer_name, phone, product_name, product_id, quantity, comment, status, source, client_id, chat_session_id)
  values
    (btrim(p_name), btrim(p_phone), nullif(btrim(coalesce(p_product_name, '')), ''), v_product_id,
     coalesce(p_quantity, 1), nullif(btrim(coalesce(p_comment, '')), ''), 'new', p_source, v_client_id, p_chat_session_id)
  returning id into v_app_id;

  if p_chat_session_id is not null then
    update public.chat_sessions set application_id = v_app_id where id = p_chat_session_id;
  end if;

  return v_app_id;
end;
$$;

revoke all on function public.create_application(text, text, text, text, text, integer, text, uuid) from public, anon, authenticated;

-- Аналитика: серия «chat» считает заявки с источником 'ai_chat'; добавлены токены за период
create or replace function public.crm_analytics(p_days integer default 30)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  since timestamptz;
  result jsonb;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  since := (date_trunc('day', now() at time zone 'Asia/Bishkek')
            - make_interval(days => greatest(1, least(p_days, 365)) - 1)) at time zone 'Asia/Bishkek';

  select jsonb_build_object(
    'since', since,
    'totals', jsonb_build_object(
      'clients', (select count(*) from public.clients),
      'applications', (select count(*) from public.applications),
      'applications_new', (select count(*) from public.applications where status = 'new'),
      'orders', (select count(*) from public.orders),
      'orders_active', (select count(*) from public.orders where status not in ('completed', 'cancelled')),
      'revenue', (select coalesce(sum(total), 0) from public.orders where status <> 'cancelled'),
      'products_active', (select count(*) from public.products where is_active),
      'chat_sessions', (select count(*) from public.chat_sessions)
    ),
    'period', jsonb_build_object(
      'applications', (select count(*) from public.applications where created_at >= since),
      'clients', (select count(*) from public.clients where created_at >= since),
      'orders', (select count(*) from public.orders where created_at >= since),
      'revenue', (select coalesce(sum(total), 0) from public.orders where created_at >= since and status <> 'cancelled'),
      'converted', (select count(*) from public.applications where created_at >= since and status = 'converted'),
      'chat_sessions', (select count(*) from public.chat_sessions where created_at >= since),
      'ai_input_tokens', (select coalesce(sum(input_tokens), 0) from public.chat_messages where created_at >= since),
      'ai_output_tokens', (select coalesce(sum(output_tokens), 0) from public.chat_messages where created_at >= since)
    ),
    'daily', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'day', to_char(g.d, 'YYYY-MM-DD'),
               'site', (select count(*) from public.applications a
                         where a.source in ('site', 'modal') and (a.created_at at time zone 'Asia/Bishkek')::date = g.d),
               'chat', (select count(*) from public.applications a
                         where a.source = 'ai_chat' and (a.created_at at time zone 'Asia/Bishkek')::date = g.d),
               'manual', (select count(*) from public.applications a
                         where a.source = 'manual' and (a.created_at at time zone 'Asia/Bishkek')::date = g.d),
               'revenue', (select coalesce(sum(o.total), 0) from public.orders o
                         where o.status <> 'cancelled' and (o.created_at at time zone 'Asia/Bishkek')::date = g.d)
             ) order by g.d), '[]'::jsonb)
        from (select gs::date as d
                from generate_series((since at time zone 'Asia/Bishkek')::date,
                                     (now() at time zone 'Asia/Bishkek')::date, interval '1 day') gs) g
    ),
    'applications_by_status', (
      select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
        from (select status, count(*) n from public.applications where created_at >= since group by status) s
    ),
    'applications_by_source', (
      select coalesce(jsonb_object_agg(source, n), '{}'::jsonb)
        from (select source, count(*) n from public.applications where created_at >= since group by source) s
    ),
    'orders_by_status', (
      select coalesce(jsonb_object_agg(status, n), '{}'::jsonb)
        from (select status, count(*) n from public.orders group by status) s
    ),
    'top_products', (
      select coalesce(jsonb_agg(t order by t.requests desc), '[]'::jsonb) from (
        select coalesce(p.name, a.product_name) as name, count(*) as requests
          from public.applications a
          left join public.products p on p.id = a.product_id
         where a.created_at >= since and coalesce(p.name, a.product_name) is not null
         group by 1
         order by 2 desc
         limit 8
      ) t
    )
  ) into result;
  return result;
end;
$$;

revoke all on function public.crm_analytics(integer) from public, anon;
grant execute on function public.crm_analytics(integer) to authenticated;

commit;

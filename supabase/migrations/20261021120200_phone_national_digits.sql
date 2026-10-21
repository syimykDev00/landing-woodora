-- Один номер в разных форматах (+996 555 123 456, 0555 123 456, 555123456) — один клиент.
-- Клиенты сравниваются по последним 9 цифрам (национальный номер Кыргызстана).

begin;

drop index if exists public.clients_phone_digits_key;
alter table public.clients drop column phone_digits;
alter table public.clients add column phone_digits text
  generated always as (nullif(right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 9), '')) stored;
create unique index clients_phone_digits_key on public.clients (phone_digits) where phone_digits is not null;

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
    values (btrim(p_name), btrim(p_phone), case when p_source = 'chat' then 'chat' else 'site' end)
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

commit;

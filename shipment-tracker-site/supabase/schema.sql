-- Shipment Tracker: database setup for Supabase.
-- Paste this whole file into Supabase > SQL Editor > New query, then press Run. Run it once.

create extension if not exists pgcrypto;

-- ---------- people ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  first_name text not null default '',
  last_name text not null default '',
  email text,
  role text not null default 'pending' check (role in ('pending', 'member', 'admin', 'removed')),
  created_at timestamptz not null default now()
);

-- A profile is made automatically when someone signs up, with the first and last name they typed.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, first_name, last_name, email)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'first_name', ''),
          coalesce(new.raw_user_meta_data->>'last_name', ''),
          new.email)
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.is_member() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role in ('member', 'admin'));
$$;
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin');
$$;

-- Only the admin can change someone's access. People can change their own name.
create or replace function public.guard_profile() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() then
    if new.role is distinct from old.role or new.email is distinct from old.email or new.id <> old.id then
      raise exception 'Only the admin can change access';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists guard_profile on public.profiles;
create trigger guard_profile before update on public.profiles
  for each row execute function public.guard_profile();

alter table public.profiles enable row level security;
drop policy if exists "see own profile or all if member" on public.profiles;
create policy "see own profile or all if member" on public.profiles for select
  using (id = auth.uid() or public.is_member());
drop policy if exists "edit own name, admin edits all" on public.profiles;
create policy "edit own name, admin edits all" on public.profiles for update
  using (id = auth.uid() or public.is_admin());

-- ---------- shipments ----------
create table if not exists public.shipments (
  id text primary key default gen_random_uuid()::text,
  kind text not null default 'Bulk',
  sn numeric,
  product text not null,
  po_number text default '',
  contact text default '',
  qty numeric,
  company text default '',
  shipping_kwd numeric,
  clearance_kwd numeric,
  total_kwd numeric,
  carrier text default '',
  tracking text default '',
  mode text default '',
  status text default '',
  remarks text default '',
  month text default '',
  eta date,
  promised_eta date,
  ready_on date,
  arrived_on date,
  source text default '',
  change_reason text,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id)
);

-- Supplier contacts keep the name only: phone numbers and email addresses are removed.
alter table public.shipments add column if not exists po_number text default '';

create or replace function public.clean_contact(t text) returns text
language sql immutable as $$
  select btrim(regexp_replace(regexp_replace(regexp_replace(regexp_replace(regexp_replace(coalesce(t, ''),
    '\m(tel|phone|mobile|e-?mail)\M\s*[:.]?', '', 'gi'),
    '\S+@\S+', '', 'g'),
    '\+?\(?\d[\d\s()+-]{5,}\d', '', 'g'),
    '\(\s*\)', '', 'g'),
    '\s{2,}', ' ', 'g'), ' -+:,=');
$$;

create or replace function public.shipment_before() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null then
    new.contact := public.clean_contact(new.contact);
  end if;
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
    new.promised_eta := coalesce(new.promised_eta, new.eta);
    -- imports run by the owner in the SQL editor keep their totals as they are
    if auth.uid() is not null and (new.shipping_kwd is not null or new.clearance_kwd is not null) then
      new.total_kwd := coalesce(new.shipping_kwd, 0) + coalesce(new.clearance_kwd, 0);
    end if;
  elsif auth.uid() is null then
    return new; -- the owner working in the SQL editor
  else
    new.id := old.id;
    new.created_at := old.created_at;
    new.created_by := old.created_by;
    -- the first ETA is the promise and stays locked (only the admin can change it)
    if old.promised_eta is null then
      new.promised_eta := coalesce(new.promised_eta, new.eta);
    elsif not public.is_admin() then
      new.promised_eta := old.promised_eta;
    end if;
    -- total = shipping + clearance whenever a cost changes; otherwise the old total stays
    if new.shipping_kwd is distinct from old.shipping_kwd or new.clearance_kwd is distinct from old.clearance_kwd then
      new.total_kwd := case when new.shipping_kwd is null and new.clearance_kwd is null then null
                            else coalesce(new.shipping_kwd, 0) + coalesce(new.clearance_kwd, 0) end;
    else
      new.total_kwd := old.total_kwd;
    end if;
    if new.eta is not distinct from old.eta then
      new.change_reason := null;
    elsif old.eta is not null and coalesce(btrim(new.change_reason), '') = '' then
      raise exception 'Write the reason for the ETA change';
    end if;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
drop trigger if exists shipment_before on public.shipments;
create trigger shipment_before before insert or update on public.shipments
  for each row execute function public.shipment_before();

-- ---------- change log (written only by the database, never edited or deleted) ----------
create table if not exists public.history (
  id bigserial primary key,
  shipment_id text not null references public.shipments(id),
  field text not null,
  label text,
  old_value text,
  new_value text,
  reason text,
  changed_by uuid references public.profiles(id),
  changed_at timestamptz not null default now()
);
create index if not exists history_shipment on public.history (shipment_id, changed_at desc);
create index if not exists history_time on public.history (changed_at desc);

create or replace function public.shipment_after() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  labels jsonb := '{"status":"Status","eta":"ETA","promised_eta":"Promised ETA","ready_on":"Ready date","arrived_on":"Arrival date","remarks":"Remarks","product":"Product","po_number":"PO number","kind":"Sheet","sn":"S/N","qty":"Qty","company":"Company","contact":"Contact person","mode":"Shipping","carrier":"Shipped by","tracking":"Tracking no.","month":"Month","shipping_kwd":"Shipping cost","clearance_kwd":"Clearance cost","total_kwd":"Total charges"}';
  o jsonb; n jsonb; k text;
begin
  if auth.uid() is null then return null; end if; -- imports made by the owner in the SQL editor are not logged
  if tg_op = 'INSERT' then
    insert into public.history (shipment_id, field, label, new_value, changed_by)
    values (new.id, 'created', 'Shipment', new.product, auth.uid());
    return null;
  end if;
  o := to_jsonb(old); n := to_jsonb(new);
  for k in select jsonb_object_keys(labels) loop
    if (o->k) is distinct from (n->k) then
      insert into public.history (shipment_id, field, label, old_value, new_value, reason, changed_by)
      values (new.id, k, labels->>k, o->>k, n->>k, case when k = 'eta' then nullif(btrim(new.change_reason), '') end, auth.uid());
    end if;
  end loop;
  return null;
end $$;
drop trigger if exists shipment_after on public.shipments;
create trigger shipment_after after insert or update on public.shipments
  for each row execute function public.shipment_after();

alter table public.shipments enable row level security;
drop policy if exists "members read shipments" on public.shipments;
create policy "members read shipments" on public.shipments for select using (public.is_member());
drop policy if exists "members add shipments" on public.shipments;
create policy "members add shipments" on public.shipments for insert with check (public.is_member());
drop policy if exists "members edit shipments" on public.shipments;
create policy "members edit shipments" on public.shipments for update using (public.is_member());
-- no delete policy: shipments cannot be deleted from the website

alter table public.history enable row level security;
drop policy if exists "members read history" on public.history;
create policy "members read history" on public.history for select using (public.is_member());
drop policy if exists "members add notes" on public.history;
create policy "members add notes" on public.history for insert
  with check (public.is_member() and field = 'note' and changed_by = auth.uid());
-- no update or delete policy: the change log cannot be edited or deleted

-- ---------- invoices and packing lists ----------
create table if not exists public.documents (
  id bigserial primary key,
  shipment_id text not null references public.shipments(id),
  kind text not null default 'Invoice',
  name text not null,
  path text not null unique,
  size bigint,
  type text,
  uploaded_by uuid references public.profiles(id) default auth.uid(),
  uploaded_at timestamptz not null default now()
);
create or replace function public.document_after() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.history (shipment_id, field, label, new_value, changed_by)
  values (new.shipment_id, 'file', new.kind, new.name, auth.uid());
  return null;
end $$;
drop trigger if exists document_after on public.documents;
create trigger document_after after insert on public.documents
  for each row execute function public.document_after();

alter table public.documents enable row level security;
drop policy if exists "members read documents" on public.documents;
create policy "members read documents" on public.documents for select using (public.is_member());
drop policy if exists "members add documents" on public.documents;
create policy "members add documents" on public.documents for insert
  with check (public.is_member() and uploaded_by = auth.uid());

insert into storage.buckets (id, name, public, file_size_limit)
values ('documents', 'documents', false, 10485760)
on conflict (id) do nothing;
drop policy if exists "members read files" on storage.objects;
create policy "members read files" on storage.objects for select
  using (bucket_id = 'documents' and public.is_member());
drop policy if exists "members upload files" on storage.objects;
create policy "members upload files" on storage.objects for insert
  with check (bucket_id = 'documents' and public.is_member());

-- live updates for everyone who has the website open
do $$ begin
  begin alter publication supabase_realtime add table public.shipments; exception when others then null; end;
  begin alter publication supabase_realtime add table public.history; exception when others then null; end;
  begin alter publication supabase_realtime add table public.documents; exception when others then null; end;
end $$;

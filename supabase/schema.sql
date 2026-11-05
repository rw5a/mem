-- =====================================================================
-- Membership Management Platform - Database Schema
-- Target: Supabase (PostgreSQL 15+). Run in the SQL Editor.
-- Uses named dollar-quote tags ($fn$) so copy/paste never mangles them.
-- =====================================================================

create table if not exists public.members (
    id                uuid primary key default gen_random_uuid(),
    auth_user_id      uuid unique references auth.users (id) on delete set null,
    email             text not null unique,
    first_name        text,
    last_name         text,
    full_name         text generated always as (
        nullif(trim(both ' ' from
            coalesce(first_name,'') || ' ' || coalesce(last_name,'')), '')
    ) stored,
    phone             text,
    is_member         boolean not null default false,
    membership_status text not null default 'pending'
                      check (membership_status in ('pending','active','lapsed','suspended')),
    membership_type   text not null default 'non-recurring'
                      check (membership_type in ('recurring','non-recurring')),
    next_renewal_date date,
    tier              text not null default 'No Shirt'
                      check (tier in ('No Shirt','Shirt','Sponsor')),
    date_shirt_sent   date,
    address_line1     text,
    address_line2     text,
    city              text,
    state             text,
    postal_code       text,
    shirt_size        text check (shirt_size in ('XS','S','M','L','XL','XXL','XXXL')),
    is_admin          boolean not null default false,
    archived          boolean not null default false,
    created_at        timestamptz not null default now(),
    updated_at        timestamptz not null default now(),
    constraint renewal_only_if_recurring
        check (next_renewal_date is null or membership_type = 'recurring'),
    constraint shirt_date_only_if_shirt
        check (date_shirt_sent is null or tier <> 'No Shirt')
);

create table if not exists public.events (
    id          uuid primary key default gen_random_uuid(),
    name        text not null,
    description text,
    start_at    timestamptz not null,
    end_at      timestamptz,
    location    text,
    created_by  uuid references public.members (id) on delete set null,
    created_at  timestamptz not null default now(),
    check (end_at is null or end_at >= start_at)
);

create table if not exists public.volunteer_hours (
    id          uuid primary key default gen_random_uuid(),
    member_id   uuid not null references public.members (id) on delete cascade,
    event_id    uuid not null references public.events (id) on delete cascade,
    hours       numeric(5,2) not null check (hours > 0 and hours <= 24),
    travel_time numeric(5,2) not null default 0
                check (travel_time >= 0 and travel_time <= 24),
    total_hours numeric(6,2) generated always as (hours + travel_time) stored,
    notes       text,
    logged_at   timestamptz not null default now(),
    unique (member_id, event_id)
);

create table if not exists public.event_attendance (
    member_id  uuid not null references public.members (id) on delete cascade,
    event_id   uuid not null references public.events (id) on delete cascade,
    attended   boolean not null default false,
    updated_at timestamptz not null default now(),
    primary key (member_id, event_id)
);

create table if not exists public.event_rsvp (
    member_id  uuid not null references public.members (id) on delete cascade,
    event_id   uuid not null references public.events (id) on delete cascade,
    rsvp       boolean not null default false,
    updated_at timestamptz not null default now(),
    primary key (member_id, event_id)
);

-- ---- Helpers --------------------------------------------------------
create or replace function public.current_member_id()
returns uuid
language sql security definer stable set search_path = public
as $fn$ select id from public.members where auth_user_id = auth.uid() and not archived; $fn$;

create or replace function public.current_user_is_admin()
returns boolean
language sql security definer stable set search_path = public
as $fn$
    select coalesce(
        (select m.is_admin from public.members m where m.auth_user_id = auth.uid()),
        false);
$fn$;

-- ---- Trigger: create (or link) a person row at signup --------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = public
as $fn$
begin
    update public.members set auth_user_id = new.id
     where email = new.email and auth_user_id is null;
    if not found then
        insert into public.members (email, auth_user_id, is_member)
        values (new.email, new.id, false)
        on conflict (email) do update set auth_user_id = excluded.auth_user_id;
    end if;
    return new;
end;
$fn$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
    after insert on auth.users
    for each row execute function public.handle_new_user();

-- ---- Trigger: maintain updated_at -----------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $fn$
begin new.updated_at := now(); return new; end; $fn$;

drop trigger if exists members_touch_updated_at on public.members;
create trigger members_touch_updated_at
    before update on public.members
    for each row execute function public.touch_updated_at();

-- ---- Row Level Security ---------------------------------------------
alter table public.members          enable row level security;
alter table public.events           enable row level security;
alter table public.volunteer_hours  enable row level security;
alter table public.event_attendance enable row level security;
alter table public.event_rsvp       enable row level security;

create policy members_select on public.members
    for select using (auth_user_id = auth.uid() or public.current_user_is_admin());
create policy members_admin_update on public.members
    for update using (public.current_user_is_admin())
    with check (public.current_user_is_admin());
create policy members_admin_insert on public.members
    for insert with check (public.current_user_is_admin());

create policy events_select on public.events
    for select using (auth.uid() is not null);
create policy events_admin_write on public.events
    for all using (public.current_user_is_admin())
    with check (public.current_user_is_admin());

create policy vh_select on public.volunteer_hours
    for select using (
        member_id = public.current_member_id() or public.current_user_is_admin());
create policy vh_admin_write on public.volunteer_hours
    for all using (public.current_user_is_admin())
    with check (public.current_user_is_admin());

create policy att_select on public.event_attendance
    for select using (
        member_id = public.current_member_id() or public.current_user_is_admin());
create policy att_admin_write on public.event_attendance
    for all using (public.current_user_is_admin())
    with check (public.current_user_is_admin());

create policy rsvp_select on public.event_rsvp
    for select using (
        member_id = public.current_member_id() or public.current_user_is_admin());
create policy rsvp_admin_write on public.event_rsvp
    for all using (public.current_user_is_admin())
    with check (public.current_user_is_admin());

-- ---- View: roster with total hours ---------------------------------
create or replace view public.member_roster
with (security_invoker = true) as
    select m.*,
           coalesce((select sum(vh.total_hours) from public.volunteer_hours vh
                      where vh.member_id = m.id), 0)::numeric(12,2) as total_hours
      from public.members m;

-- ---- RPC: self-service profile (basic contact info; any signer) -----
create or replace function public.update_my_profile(
    p_first_name text, p_last_name text, p_phone text,
    p_address_line1 text, p_address_line2 text, p_city text,
    p_state text, p_postal_code text, p_shirt_size text)
returns public.members
language plpgsql security definer set search_path = public
as $fn$
declare v_member public.members;
begin
    if auth.uid() is null then raise exception 'not authenticated'; end if;
    if p_shirt_size is not null
       and p_shirt_size not in ('XS','S','M','L','XL','XXL','XXXL') then
        raise exception 'invalid shirt size: %', p_shirt_size;
    end if;
    update public.members
       set first_name=p_first_name, last_name=p_last_name, phone=p_phone,
           address_line1=p_address_line1, address_line2=p_address_line2,
           city=p_city, state=p_state, postal_code=p_postal_code,
           shirt_size=p_shirt_size
     where auth_user_id = auth.uid()
    returning * into v_member;
    if not found then raise exception 'member record not found'; end if;
    return v_member;
end;
$fn$;

-- ---- RPC: mark attendance (requires a complete profile) -----------
create or replace function public.set_my_attendance(p_event_id uuid, p_attended boolean)
returns public.event_attendance
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.event_attendance; v_mid uuid := public.current_member_id();
begin
    if v_mid is null then raise exception 'no person record'; end if;
    if not exists (select 1 from public.events e where e.id = p_event_id) then
        raise exception 'event not found'; end if;
    if not exists (select 1 from public.members m where m.id = v_mid
            and m.first_name is not null and btrim(m.first_name) <> ''
            and m.last_name is not null and btrim(m.last_name) <> ''
            and m.phone is not null and length(regexp_replace(m.phone, '\D', '', 'g')) = 10) then
        raise exception 'complete your profile (first name, last name, and a 10-digit phone) before marking attendance';
    end if;
    insert into public.event_attendance (member_id, event_id, attended)
    values (v_mid, p_event_id, coalesce(p_attended,false))
    on conflict (member_id, event_id)
    do update set attended = excluded.attended, updated_at = now()
    returning * into v_row;
    return v_row;
end;
$fn$;

-- ---- RPC: RSVP to an event (requires a complete profile) ----------
create or replace function public.set_my_rsvp(p_event_id uuid, p_rsvp boolean)
returns public.event_rsvp
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.event_rsvp; v_mid uuid := public.current_member_id();
begin
    if v_mid is null then raise exception 'no person record'; end if;
    if not exists (select 1 from public.events e where e.id = p_event_id) then
        raise exception 'event not found'; end if;
    if not exists (select 1 from public.members m where m.id = v_mid
            and m.first_name is not null and btrim(m.first_name) <> ''
            and m.last_name is not null and btrim(m.last_name) <> ''
            and m.phone is not null and length(regexp_replace(m.phone, '\D', '', 'g')) = 10) then
        raise exception 'complete your profile (first name, last name, and a 10-digit phone) before you RSVP';
    end if;
    insert into public.event_rsvp (member_id, event_id, rsvp)
    values (v_mid, p_event_id, coalesce(p_rsvp,false))
    on conflict (member_id, event_id)
    do update set rsvp = excluded.rsvp, updated_at = now()
    returning * into v_row;
    return v_row;
end;
$fn$;

-- ---- RPC: log own hours (requires a complete profile) -------------
create or replace function public.log_volunteer_hours(
    p_event_id uuid, p_hours numeric, p_travel numeric, p_notes text)
returns public.volunteer_hours
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.volunteer_hours; v_mid uuid := public.current_member_id();
begin
    if v_mid is null then raise exception 'no person record'; end if;
    if not exists (select 1 from public.members m where m.id = v_mid
            and m.first_name is not null and btrim(m.first_name) <> ''
            and m.last_name is not null and btrim(m.last_name) <> ''
            and m.phone is not null and length(regexp_replace(m.phone, '\D', '', 'g')) = 10) then
        raise exception 'complete your profile (first name, last name, and a 10-digit phone) before logging hours';
    end if;
    if p_hours is null or p_hours <= 0 or p_hours > 24 then
        raise exception 'event hours must be between 0 and 24'; end if;
    if coalesce(p_travel,0) < 0 or coalesce(p_travel,0) > 24 then
        raise exception 'travel hours must be between 0 and 24'; end if;
    if not exists (select 1 from public.events e where e.id = p_event_id) then
        raise exception 'event not found'; end if;
    insert into public.volunteer_hours (member_id, event_id, hours, travel_time, notes)
    values (v_mid, p_event_id, p_hours, coalesce(p_travel,0), p_notes)
    on conflict (member_id, event_id)
    do update set hours=excluded.hours, travel_time=excluded.travel_time,
                  notes=excluded.notes, logged_at=now()
    returning * into v_row;
    return v_row;
end;
$fn$;

-- ---- RPC: ADMIN logs/updates hours for any person -----------------
create or replace function public.admin_log_hours(
    p_member_id uuid, p_event_id uuid, p_hours numeric, p_travel numeric, p_notes text)
returns public.volunteer_hours
language plpgsql security definer set search_path = public
as $fn$
declare v_row public.volunteer_hours;
begin
    if not public.current_user_is_admin() then raise exception 'admin privileges required'; end if;
    if p_hours is null or p_hours <= 0 or p_hours > 24 then
        raise exception 'event hours must be between 0 and 24'; end if;
    if coalesce(p_travel,0) < 0 or coalesce(p_travel,0) > 24 then
        raise exception 'travel hours must be between 0 and 24'; end if;
    if not exists (select 1 from public.members m where m.id = p_member_id) then
        raise exception 'person not found'; end if;
    if not exists (select 1 from public.events e where e.id = p_event_id) then
        raise exception 'event not found'; end if;
    insert into public.volunteer_hours (member_id, event_id, hours, travel_time, notes)
    values (p_member_id, p_event_id, p_hours, coalesce(p_travel,0), p_notes)
    on conflict (member_id, event_id)
    do update set hours=excluded.hours, travel_time=excluded.travel_time,
                  notes=excluded.notes, logged_at=now()
    returning * into v_row;
    return v_row;
end;
$fn$;

-- ---- RPC: ADMIN bulk logs hours for one event ---------------------
create or replace function public.admin_bulk_log_hours(p_event_id uuid, p_entries jsonb)
returns integer
language plpgsql security definer set search_path = public
as $fn$
declare
    v_max constant integer := 1000;
    v_count integer := 0; v_len integer; v_i integer;
    v_entry jsonb; v_member uuid; v_hours numeric; v_travel numeric; v_notes text;
begin
    if not public.current_user_is_admin() then raise exception 'admin privileges required'; end if;
    if not exists (select 1 from public.events e where e.id = p_event_id) then
        raise exception 'event not found'; end if;
    if p_entries is null or jsonb_typeof(p_entries) <> 'array' then
        raise exception 'entries must be a JSON array'; end if;
    v_len := jsonb_array_length(p_entries);
    if v_len > v_max then raise exception 'too many entries (max %)', v_max; end if;
    v_i := 0;
    while v_i < v_len loop
        v_entry := p_entries -> v_i;
        v_member := (v_entry ->> 'member_id')::uuid;
        v_hours := (v_entry ->> 'hours')::numeric;
        v_travel := coalesce((v_entry ->> 'travel')::numeric, 0);
        v_notes := v_entry ->> 'notes';
        if v_member is null then raise exception 'entry % is missing member_id', v_i; end if;
        if v_hours is null or v_hours <= 0 or v_hours > 24 then
            raise exception 'entry % has invalid event hours', v_i; end if;
        if v_travel < 0 or v_travel > 24 then
            raise exception 'entry % has invalid travel hours', v_i; end if;
        if not exists (select 1 from public.members m where m.id = v_member) then
            raise exception 'entry % references an unknown person', v_i; end if;
        insert into public.volunteer_hours (member_id, event_id, hours, travel_time, notes)
        values (v_member, p_event_id, v_hours, v_travel, v_notes)
        on conflict (member_id, event_id)
        do update set hours=excluded.hours, travel_time=excluded.travel_time,
                      notes=excluded.notes, logged_at=now();
        v_count := v_count + 1; v_i := v_i + 1;
    end loop;
    return v_count;
end;
$fn$;

-- ---- RPC: ADMIN creates a person/member ---------------------------
create or replace function public.admin_create_member(
    p_email text, p_first_name text, p_last_name text, p_phone text,
    p_is_member boolean, p_membership_status text, p_membership_type text,
    p_next_renewal_date date, p_tier text, p_date_shirt_sent date, p_shirt_size text,
    p_city text, p_state text, p_postal_code text, p_is_admin boolean)
returns public.members
language plpgsql security definer set search_path = public
as $fn$
declare
    v_member public.members;
    v_type text := coalesce(p_membership_type,'non-recurring');
    v_renew date := p_next_renewal_date;
    v_tier text := coalesce(p_tier,'No Shirt');
    v_sent date := p_date_shirt_sent;
begin
    if not public.current_user_is_admin() then raise exception 'admin privileges required'; end if;
    if p_email is null or position('@' in p_email) < 2 then
        raise exception 'a valid email is required'; end if;
    if exists (select 1 from public.members m where lower(m.email) = lower(p_email)) then
        raise exception 'a person with that email already exists'; end if;
    if p_membership_status is not null
       and p_membership_status not in ('pending','active','lapsed','suspended') then
        raise exception 'invalid status'; end if;
    if v_type not in ('recurring','non-recurring') then raise exception 'invalid membership type'; end if;
    if v_tier not in ('No Shirt','Shirt','Sponsor') then raise exception 'invalid tier'; end if;
    if v_type = 'non-recurring' then v_renew := null; end if;
    if v_tier = 'No Shirt' then v_sent := null; end if;
    insert into public.members (email, first_name, last_name, phone, is_member,
        membership_status, membership_type, next_renewal_date, tier, date_shirt_sent,
        shirt_size, city, state, postal_code, is_admin)
    values (lower(p_email), p_first_name, p_last_name, p_phone, coalesce(p_is_member,false),
        coalesce(p_membership_status,'pending'), v_type, v_renew, v_tier, v_sent,
        nullif(p_shirt_size,''), p_city, p_state, p_postal_code, coalesce(p_is_admin,false))
    returning * into v_member;
    return v_member;
end;
$fn$;

-- ---- RPC: ADMIN merges one profile into another --------------------
create or replace function public.admin_merge_members(
    p_target_id uuid, p_source_id uuid)
returns public.members
language plpgsql security definer set search_path = public
as $fn$
declare
    v_tgt_auth uuid;
    v_src_auth uuid;
begin
    if not public.current_user_is_admin() then raise exception 'admin privileges required'; end if;
    if p_target_id = p_source_id then raise exception 'cannot merge a profile into itself'; end if;
    if not exists (select 1 from public.members where id = p_target_id) then raise exception 'target profile not found'; end if;
    if not exists (select 1 from public.members where id = p_source_id) then raise exception 'source profile not found'; end if;

    update public.volunteer_hours s
       set member_id = p_target_id
     where s.member_id = p_source_id
       and not exists (select 1 from public.volunteer_hours t
                        where t.member_id = p_target_id and t.event_id = s.event_id);

    update public.event_attendance t
       set attended = true, updated_at = now()
      from public.event_attendance s
     where s.member_id = p_source_id and t.member_id = p_target_id
       and s.event_id = t.event_id and s.attended and not t.attended;
    update public.event_attendance s
       set member_id = p_target_id
     where s.member_id = p_source_id
       and not exists (select 1 from public.event_attendance t
                        where t.member_id = p_target_id and t.event_id = s.event_id);

    update public.event_rsvp t
       set rsvp = true, updated_at = now()
      from public.event_rsvp s
     where s.member_id = p_source_id and t.member_id = p_target_id
       and s.event_id = t.event_id and s.rsvp and not t.rsvp;
    update public.event_rsvp s
       set member_id = p_target_id
     where s.member_id = p_source_id
       and not exists (select 1 from public.event_rsvp t
                        where t.member_id = p_target_id and t.event_id = s.event_id);

    v_tgt_auth := (select auth_user_id from public.members where id = p_target_id);
    v_src_auth := (select auth_user_id from public.members where id = p_source_id);
    delete from public.members where id = p_source_id;
    if v_tgt_auth is null and v_src_auth is not null then
        update public.members set auth_user_id = v_src_auth where id = p_target_id;
    end if;

    return (select m from public.members m where m.id = p_target_id);
end;
$fn$;

-- ---- RPC: ADMIN archives / unarchives a person --------------------
create or replace function public.admin_set_archived(
    p_member_id uuid, p_archived boolean)
returns public.members
language plpgsql security definer set search_path = public
as $fn$
begin
    if not public.current_user_is_admin() then raise exception 'admin privileges required'; end if;
    if p_member_id = public.current_member_id() then
        raise exception 'you cannot archive your own account';
    end if;
    if not exists (select 1 from public.members where id = p_member_id) then
        raise exception 'person not found'; end if;
    update public.members set archived = coalesce(p_archived, false)
     where id = p_member_id;
    return (select m from public.members m where m.id = p_member_id);
end;
$fn$;

-- ---- RPC: ADMIN per-event summary ---------------------------------
create or replace function public.admin_event_hours_summary()
returns table (event_id uuid, event_name text, start_at timestamptz, location text,
    member_count bigint, attended_count bigint, rsvp_count bigint, total_hours numeric)
language plpgsql security definer set search_path = public
as $fn$
begin
    if not public.current_user_is_admin() then raise exception 'admin privileges required'; end if;
    return query
        select e.id, e.name, e.start_at, e.location,
               count(distinct vh.id)::bigint,
               count(distinct a.member_id) filter (where a.attended)::bigint,
               count(distinct r.member_id) filter (where r.rsvp)::bigint,
               coalesce(sum(vh.total_hours), 0)::numeric
          from public.events e
          left join public.volunteer_hours vh on vh.event_id = e.id
          left join public.event_attendance a on a.event_id = e.id
          left join public.event_rsvp r on r.event_id = e.id
         group by e.id, e.name, e.start_at, e.location
         order by e.start_at desc;
end;
$fn$;

-- ---- Grants ---------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete
    on public.members, public.events, public.volunteer_hours,
       public.event_attendance, public.event_rsvp
    to authenticated;
grant select on public.member_roster to authenticated;
grant execute on function public.current_member_id() to authenticated;
grant execute on function public.update_my_profile(text,text,text,text,text,text,text,text,text) to authenticated;
grant execute on function public.set_my_attendance(uuid,boolean) to authenticated;
grant execute on function public.set_my_rsvp(uuid,boolean) to authenticated;
grant execute on function public.log_volunteer_hours(uuid,numeric,numeric,text) to authenticated;
grant execute on function public.admin_log_hours(uuid,uuid,numeric,numeric,text) to authenticated;
grant execute on function public.admin_bulk_log_hours(uuid,jsonb) to authenticated;
grant execute on function public.admin_create_member(text,text,text,text,boolean,text,text,date,text,date,text,text,text,text,boolean) to authenticated;
grant execute on function public.admin_merge_members(uuid,uuid) to authenticated;
grant execute on function public.admin_set_archived(uuid,boolean) to authenticated;
grant execute on function public.admin_event_hours_summary() to authenticated;

-- ---- Bootstrap your FIRST admin (see README) -----------------------
-- 1) run this file  2) enable Email signups in Supabase Auth
-- 3) sign in once through the portal with your email (auto-creates your row)
-- 4) run (edit the email):
--    update public.members set is_admin = true, is_member = true, membership_status = 'active'
--     where lower(email) = lower('you@example.org');
-- 5) reload the portal -> the Admin tab appears.

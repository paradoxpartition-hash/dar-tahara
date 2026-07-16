-- Secure customer onboarding, role based access and database feature controls.
-- This migration extends (rather than replaces) the assessment/Stripe schema.

create extension if not exists pgcrypto;
create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Identity, roles and customer/staff profiles
-- ---------------------------------------------------------------------------

alter table public.customers
  add column if not exists first_name text,
  add column if not exists last_name text,
  add column if not exists whatsapp_number text,
  add column if not exists billing_address jsonb not null default '{}'::jsonb,
  add column if not exists country_of_residence text,
  add column if not exists status text not null default 'applicant',
  add column if not exists email_verified_at timestamptz,
  add column if not exists last_login_at timestamptz;

alter table public.customers drop constraint if exists customers_status_check;
alter table public.customers add constraint customers_status_check
  check (status in ('applicant', 'approved', 'customer', 'suspended', 'archived'));

alter table public.staff_members
  add column if not exists auth_user_id uuid unique references auth.users(id) on delete set null;

create table if not exists public.user_roles (
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('applicant', 'customer', 'staff', 'administrator')),
  granted_by uuid references auth.users(id) on delete set null,
  granted_at timestamptz not null default now(),
  primary key (user_id, role)
);

create index if not exists user_roles_role_user_idx on public.user_roles(role, user_id);
create index if not exists staff_members_auth_user_idx on public.staff_members(auth_user_id);

create or replace function private.current_user_has_role(allowed_roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.uid()) is not null and exists (
    select 1 from public.user_roles ur
    where ur.user_id = (select auth.uid())
      and ur.role = any(allowed_roles)
  );
$$;

revoke all on function private.current_user_has_role(text[]) from public, anon;
grant usage on schema private to authenticated, service_role;
grant execute on function private.current_user_has_role(text[]) to authenticated, service_role;

create or replace function private.ensure_applicant_role()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.auth_user_id is not null and
     (tg_op = 'INSERT' or old.auth_user_id is distinct from new.auth_user_id or
      (old.status is distinct from new.status and new.status = 'customer')) then
    insert into public.user_roles(user_id, role)
    values (new.auth_user_id, case when new.status = 'customer' then 'customer' else 'applicant' end)
    on conflict do nothing;
  end if;
  return new;
end;
$$;

revoke all on function private.ensure_applicant_role() from public, anon, authenticated;
grant execute on function private.ensure_applicant_role() to service_role;

drop trigger if exists customers_ensure_applicant_role on public.customers;
create trigger customers_ensure_applicant_role
after insert or update of auth_user_id, status on public.customers
for each row execute function private.ensure_applicant_role();

-- ---------------------------------------------------------------------------
-- Database feature flags and configurable business details
-- ---------------------------------------------------------------------------

create table if not exists public.feature_flags (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{2,80}$'),
  name text not null,
  description text not null,
  enabled boolean not null default false,
  starts_at timestamptz,
  ends_at timestamptz,
  public_disabled_message text,
  fallback_cta_label text,
  fallback_cta_url text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null,
  constraint feature_flags_schedule_check check (ends_at is null or starts_at is null or ends_at > starts_at),
  constraint feature_flags_fallback_url_check check (
    fallback_cta_url is null or
    fallback_cta_url ~ '^/(?!/)' or
    fallback_cta_url ~ '^https://'
  )
);

insert into public.feature_flags
  (key, name, description, enabled, public_disabled_message, fallback_cta_label, fallback_cta_url)
values
  ('initial_assessment_booking_enabled', 'Initial assessment booking', 'Allow visitors to submit a new initial home assessment application.', false, 'Initial home assessments are not yet open for direct booking. Join early access and we will contact you when assessments become available in your area.', 'Join Early Access', '/early-access'),
  ('early_access_enabled', 'Early access', 'Show and accept early-access registrations.', true, null, null, null),
  ('customer_registration_enabled', 'Customer registration', 'Allow controlled applicant account activation. Public self-assignment of roles is never allowed.', true, null, null, null),
  ('customer_portal_enabled', 'Customer portal', 'Allow applicants and customers to open their secure account portal.', false, 'The customer portal is being prepared. Please contact support if you need account information.', 'Contact Support', '/#contact'),
  ('subscription_checkout_enabled', 'Subscription checkout', 'Allow approved proposals to open secure Stripe Checkout.', false, 'Subscription checkout is temporarily unavailable. Your approved proposal remains saved.', 'Contact Support', '/#contact'),
  ('annual_subscription_enabled', 'Annual subscriptions', 'Allow annual billing proposals and checkout.', true, null, null, null),
  ('monthly_subscription_enabled', 'Monthly subscriptions', 'Allow monthly billing proposals and checkout.', true, null, null, null),
  ('whatsapp_contact_enabled', 'WhatsApp contact', 'Show public and portal WhatsApp contact actions.', true, null, null, null),
  ('newsletter_signup_enabled', 'Newsletter signup', 'Show and accept newsletter registrations.', true, null, null, null)
on conflict (key) do nothing;

create table if not exists public.platform_settings (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{2,80}$'),
  value jsonb not null default '{}'::jsonb,
  description text,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users(id) on delete set null
);

insert into public.platform_settings(key, value, description)
values ('invoice_company', '{}'::jsonb, 'Configurable legal and display details used for invoices.')
on conflict (key) do nothing;

-- ---------------------------------------------------------------------------
-- Assessment workflow extension
-- ---------------------------------------------------------------------------

alter table public.properties
  add column if not exists neighbourhood text,
  add column if not exists property_type text,
  add column if not exists floors smallint,
  add column if not exists occupancy_type text,
  add column if not exists access_method text,
  add column if not exists digital_lock_available boolean,
  add column if not exists physical_key_required boolean not null default false,
  add column if not exists parking_instructions text,
  add column if not exists selected_services jsonb not null default '[]'::jsonb,
  add column if not exists customer_cleaning_instructions text,
  add column if not exists service_schedule jsonb not null default '{}'::jsonb,
  add column if not exists operational_change_pending jsonb;

alter table public.home_assessments
  add column if not exists submitted_at timestamptz,
  add column if not exists scheduled_at timestamptz,
  add column if not exists next_action text,
  add column if not exists assigned_staff_id uuid references public.staff_members(id) on delete set null,
  add column if not exists staff_requested_actions jsonb not null default '[]'::jsonb,
  add column if not exists assessment_outcome text,
  add column if not exists verified_condition text,
  add column if not exists recurring_cleaning_duration_minutes integer,
  add column if not exists proposed_plan text,
  add column if not exists proposed_recurring_cents integer,
  add column if not exists initial_cleaning_cents integer,
  add column if not exists additional_service_fees_cents integer not null default 0,
  add column if not exists physical_key_fee_cents integer not null default 0,
  add column if not exists insurance_key_fee_cents integer not null default 0,
  add column if not exists approval_reason text,
  add column if not exists approved_at timestamptz,
  add column if not exists rejected_at timestamptz,
  add column if not exists expires_at timestamptz;

alter table public.home_assessments alter column preferred_date drop not null;
alter table public.home_assessments alter column preferred_time_slot drop not null;
alter table public.home_assessments alter column assessment_price_cents set default 0;
alter table public.home_assessments drop constraint if exists home_assessments_assessment_price_cents_check;
alter table public.home_assessments add constraint home_assessments_assessment_price_cents_check
  check (assessment_price_cents >= 0);
alter table public.home_assessments drop constraint if exists home_assessments_status_check;
alter table public.home_assessments add constraint home_assessments_status_check check (status in (
  'draft', 'submitted', 'under_review', 'contacted', 'assessment_scheduled',
  'assessment_completed', 'additional_information_required', 'approved', 'rejected',
  'cancelled', 'expired',
  -- Legacy states remain valid during the backwards-compatible rollout.
  'awaiting_payment', 'assessment', 'pending_review', 'needs_revised_quote',
  'subscription_active', 'paused'
));
alter table public.home_assessments alter column status set default 'submitted';

create or replace function private.validate_assessment_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if old.status = new.status then return new; end if;
  if not (
    (old.status = 'draft' and new.status in ('submitted', 'cancelled')) or
    (old.status = 'submitted' and new.status in ('under_review', 'contacted', 'cancelled', 'expired')) or
    (old.status = 'under_review' and new.status in ('contacted', 'assessment_scheduled', 'additional_information_required', 'approved', 'rejected', 'cancelled')) or
    (old.status = 'contacted' and new.status in ('assessment_scheduled', 'additional_information_required', 'rejected', 'cancelled')) or
    (old.status = 'assessment_scheduled' and new.status in ('assessment_completed', 'cancelled')) or
    (old.status = 'assessment_completed' and new.status in ('under_review', 'approved', 'rejected')) or
    (old.status = 'additional_information_required' and new.status in ('under_review', 'contacted', 'cancelled', 'expired')) or
    (old.status = 'approved' and new.status in ('subscription_active', 'cancelled')) or
    (old.status = 'awaiting_payment' and new.status in ('assessment', 'cancelled')) or
    (old.status = 'assessment' and new.status in ('pending_review', 'cancelled')) or
    (old.status = 'pending_review' and new.status in ('approved', 'needs_revised_quote', 'rejected', 'cancelled')) or
    (old.status = 'needs_revised_quote' and new.status in ('approved', 'rejected', 'cancelled')) or
    (old.status = 'subscription_active' and new.status in ('paused', 'cancelled')) or
    (old.status = 'paused' and new.status in ('subscription_active', 'cancelled'))
  ) then
    raise exception 'invalid_assessment_transition:%->%', old.status, new.status;
  end if;
  return new;
end;
$$;

-- Customer-visible proposals are separate from subscriptions. Approval alone
-- never charges the customer or activates recurring service.
create table if not exists public.subscription_proposals (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.home_assessments(id) on delete restrict,
  customer_id uuid not null references public.customers(id) on delete restrict,
  property_id uuid not null references public.properties(id) on delete restrict,
  status text not null default 'draft' check (status in ('draft', 'ready', 'accepted', 'declined', 'expired', 'withdrawn')),
  billing_interval text not null check (billing_interval in ('monthly', 'annual')),
  frequency text not null check (frequency in ('monthly', 'biweekly', 'weekly', 'irregular')),
  recurring_amount_cents integer not null check (recurring_amount_cents >= 0),
  initial_amount_cents integer not null default 0 check (initial_amount_cents >= 0),
  additional_fees_cents integer not null default 0 check (additional_fees_cents >= 0),
  discount_basis_points integer not null default 0 check (discount_basis_points between 0 and 10000),
  currency text not null default 'eur' check (char_length(currency) = 3),
  terms_version text not null,
  terms_summary text,
  expires_at timestamptz,
  accepted_at timestamptz,
  declined_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payments (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete restrict,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  invoice_id uuid references public.invoices(id) on delete set null,
  proposal_id uuid references public.subscription_proposals(id) on delete set null,
  provider text not null default 'stripe',
  provider_payment_id text unique,
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null default 'eur' check (char_length(currency) = 3),
  status text not null check (status in ('pending', 'processing', 'succeeded', 'failed', 'refunded', 'partially_refunded', 'cancelled')),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.invoices add column if not exists invoice_number text;
alter table public.invoices add column if not exists due_at timestamptz;
alter table public.invoices add column if not exists paid_at timestamptz;
alter table public.invoices add column if not exists subtotal_cents integer not null default 0;
alter table public.invoices add column if not exists tax_cents integer not null default 0;
alter table public.invoices add column if not exists receipt_url text;
alter table public.invoices drop constraint if exists invoices_status_check;
alter table public.invoices add constraint invoices_status_check
  check (status in ('draft', 'open', 'paid', 'overdue', 'void', 'refunded', 'partially_refunded', 'uncollectible'));

create table if not exists public.assessment_attachments (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid not null references public.home_assessments(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  storage_path text not null unique,
  original_filename text not null,
  mime_type text not null check (mime_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes bigint not null check (size_bytes between 1 and 10485760),
  visibility text not null default 'customer' check (visibility in ('customer', 'internal')),
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.support_requests (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  subject text not null,
  message text not null,
  status text not null default 'open' check (status in ('open', 'in_progress', 'resolved', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.customer_activity (
  id bigint generated always as identity primary key,
  customer_id uuid not null references public.customers(id) on delete cascade,
  event_type text not null,
  resource_type text,
  resource_id uuid,
  public_summary text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table if not exists public.audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  resource_type text not null,
  resource_id text,
  previous_value jsonb,
  new_value jsonb,
  ip_address inet,
  user_agent text,
  created_at timestamptz not null default now()
);

create table if not exists public.notification_outbox (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid references public.customers(id) on delete set null,
  template_key text not null,
  locale text not null default 'en' check (locale in ('en','nl','fr','ar','es','de','pt')),
  channel text not null check (channel in ('email', 'whatsapp')),
  recipient text not null,
  payload jsonb not null default '{}'::jsonb,
  consent_confirmed boolean not null default false,
  status text not null default 'pending' check (status in ('pending', 'processing', 'sent', 'failed', 'cancelled')),
  attempts smallint not null default 0,
  available_at timestamptz not null default now(),
  sent_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists assessments_assigned_status_idx on public.home_assessments(assigned_staff_id, status);
create index if not exists assessments_submitted_idx on public.home_assessments(submitted_at desc);
create index if not exists proposals_customer_status_idx on public.subscription_proposals(customer_id, status);
create unique index if not exists proposals_one_actionable_per_assessment_idx
  on public.subscription_proposals(assessment_id)
  where status in ('draft','ready','accepted');
create index if not exists payments_customer_created_idx on public.payments(customer_id, created_at desc);
create index if not exists attachments_assessment_idx on public.assessment_attachments(assessment_id, created_at desc);
create index if not exists support_customer_status_idx on public.support_requests(customer_id, status);
create index if not exists activity_customer_created_idx on public.customer_activity(customer_id, created_at desc);
create index if not exists audit_resource_created_idx on public.audit_logs(resource_type, resource_id, created_at desc);
create index if not exists notifications_pending_idx on public.notification_outbox(status, available_at);

drop trigger if exists feature_flags_set_updated_at on public.feature_flags;
create trigger feature_flags_set_updated_at before update on public.feature_flags
for each row execute function private.set_updated_at();
drop trigger if exists platform_settings_set_updated_at on public.platform_settings;
create trigger platform_settings_set_updated_at before update on public.platform_settings
for each row execute function private.set_updated_at();
drop trigger if exists proposals_set_updated_at on public.subscription_proposals;
create trigger proposals_set_updated_at before update on public.subscription_proposals
for each row execute function private.set_updated_at();
drop trigger if exists payments_set_updated_at on public.payments;
create trigger payments_set_updated_at before update on public.payments
for each row execute function private.set_updated_at();
drop trigger if exists support_requests_set_updated_at on public.support_requests;
create trigger support_requests_set_updated_at before update on public.support_requests
for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------------------
-- Least-privilege grants and RLS
-- ---------------------------------------------------------------------------

alter table public.user_roles enable row level security;
alter table public.feature_flags enable row level security;
alter table public.platform_settings enable row level security;
alter table public.subscription_proposals enable row level security;
alter table public.payments enable row level security;
alter table public.assessment_attachments enable row level security;
alter table public.support_requests enable row level security;
alter table public.customer_activity enable row level security;
alter table public.audit_logs enable row level security;
alter table public.notification_outbox enable row level security;

revoke all on table public.user_roles, public.feature_flags, public.platform_settings,
  public.subscription_proposals, public.payments, public.assessment_attachments,
  public.support_requests, public.customer_activity, public.audit_logs,
  public.notification_outbox from anon, authenticated;

grant select, insert, update, delete on table public.user_roles, public.feature_flags,
  public.platform_settings, public.subscription_proposals, public.payments,
  public.assessment_attachments, public.support_requests, public.customer_activity,
  public.audit_logs, public.notification_outbox to service_role;
grant usage, select on sequence public.customer_activity_id_seq to service_role;

grant select on table public.user_roles, public.feature_flags, public.subscription_proposals,
  public.payments, public.assessment_attachments, public.support_requests,
  public.customer_activity to authenticated;
grant insert on table public.assessment_attachments, public.support_requests to authenticated;

-- Remove the old broad profile/property update grants. Direct authenticated
-- clients may update only explicitly safe customer-owned columns.
revoke update on table public.customers, public.properties from authenticated;
revoke insert, delete on table public.properties from authenticated;
grant update (first_name, last_name, full_name, phone, whatsapp_number,
  preferred_language, billing_address, country_of_residence, marketing_consent,
  updated_at) on table public.customers to authenticated;
grant update (address_line1, address_line2, city, neighbourhood, postal_code,
  pets, pet_details, access_notes, parking_instructions,
  customer_cleaning_instructions, operational_change_pending, updated_at)
  on table public.properties to authenticated;

create policy user_roles_read_own on public.user_roles for select to authenticated
using (user_id = (select auth.uid()));

create policy feature_flags_read_authenticated on public.feature_flags for select to authenticated
using (true);

create policy proposals_read_own on public.subscription_proposals for select to authenticated
using (customer_id in (select id from public.customers where auth_user_id = (select auth.uid())));

create policy payments_read_own on public.payments for select to authenticated
using (customer_id in (select id from public.customers where auth_user_id = (select auth.uid())));

create policy attachments_read_own on public.assessment_attachments for select to authenticated
using (
  visibility = 'customer' and
  customer_id in (select id from public.customers where auth_user_id = (select auth.uid()))
);
create policy attachments_insert_own on public.assessment_attachments for insert to authenticated
with check (
  visibility = 'customer' and
  uploaded_by = (select auth.uid()) and
  customer_id in (select id from public.customers where auth_user_id = (select auth.uid()))
);

create policy support_read_own on public.support_requests for select to authenticated
using (customer_id in (select id from public.customers where auth_user_id = (select auth.uid())));
create policy support_insert_own on public.support_requests for insert to authenticated
with check (customer_id in (select id from public.customers where auth_user_id = (select auth.uid())));

create policy activity_read_own on public.customer_activity for select to authenticated
using (customer_id in (select id from public.customers where auth_user_id = (select auth.uid())));

-- Staff/admin defense-in-depth policies. The application still performs
-- server-side role and assignment checks before using the elevated client.
create policy assessments_staff_read on public.home_assessments for select to authenticated
using (
  (select private.current_user_has_role(array['administrator'])) or
  ((select private.current_user_has_role(array['staff'])) and assigned_staff_id in (
    select id from public.staff_members where auth_user_id = (select auth.uid())
  ))
);
create policy audit_admin_read on public.audit_logs for select to authenticated
using ((select private.current_user_has_role(array['administrator'])));

-- Private assessment upload bucket. Object paths must begin with the uploader's
-- auth UUID. Downloads remain authenticated/RLS-controlled or use short signed URLs.
insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('assessment-attachments', 'assessment-attachments', false, 10485760,
  array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists assessment_storage_insert_own on storage.objects;
create policy assessment_storage_insert_own on storage.objects for insert to authenticated
with check (
  bucket_id = 'assessment-attachments' and
  (storage.foldername(name))[1] = (select auth.uid())::text
);
drop policy if exists assessment_storage_read_own on storage.objects;
create policy assessment_storage_read_own on storage.objects for select to authenticated
using (
  bucket_id = 'assessment-attachments' and
  ((storage.foldername(name))[1] = (select auth.uid())::text or
   (select private.current_user_has_role(array['staff','administrator'])))
);

notify pgrst, 'reload schema';

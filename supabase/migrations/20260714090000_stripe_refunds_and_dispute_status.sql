-- Refund tracking + extended payment statuses for disputes / partial refunds.

-- 1. Allow 'partially_refunded' and 'disputed' on assessments.
alter table public.home_assessments drop constraint if exists home_assessments_payment_status_check;
alter table public.home_assessments add constraint home_assessments_payment_status_check
  check (payment_status in (
    'unpaid', 'processing', 'paid', 'failed',
    'refunded', 'partially_refunded', 'disputed', 'expired'
  ));

-- 2. Refunds ledger (admin-initiated and webhook-recorded).
create table if not exists public.refunds (
  id uuid primary key default gen_random_uuid(),
  assessment_id uuid references public.home_assessments(id) on delete set null,
  subscription_id uuid references public.subscriptions(id) on delete set null,
  customer_id uuid references public.customers(id) on delete set null,
  stripe_refund_id text unique,
  stripe_charge_id text,
  stripe_payment_intent_id text,
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null default 'eur' check (char_length(currency) = 3),
  reason text,
  internal_note text,
  status text not null default 'pending'
    check (status in ('pending', 'succeeded', 'failed', 'canceled')),
  source text not null default 'admin' check (source in ('admin', 'stripe_webhook')),
  created_by text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists refunds_assessment_idx on public.refunds(assessment_id);
create index if not exists refunds_customer_idx on public.refunds(customer_id);

drop trigger if exists refunds_set_updated_at on public.refunds;
create trigger refunds_set_updated_at before update on public.refunds
for each row execute function private.set_updated_at();

alter table public.refunds enable row level security;
revoke all on table public.refunds from anon, authenticated;
grant select, insert, update on table public.refunds to service_role;
grant select on table public.refunds to authenticated;

create policy refunds_read_own on public.refunds for select to authenticated
using (customer_id in (
  select id from public.customers where auth_user_id = (select auth.uid())
));

notify pgrst, 'reload schema';

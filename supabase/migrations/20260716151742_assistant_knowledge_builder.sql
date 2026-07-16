-- Dar Tahara Automated Assistant knowledge-building and retrieval foundation.
-- Rollback instructions are documented in docs/assistant/README.md.

alter table public.knowledge_articles
  add column if not exists subcategory text,
  add column if not exists canonical_language text not null default 'en'
    check (canonical_language in ('en', 'nl', 'fr', 'ar', 'es', 'de', 'pt')),
  add column if not exists applicable_domains text[] not null default '{}'::text[],
  add column if not exists applicable_cities text[] not null default '{}'::text[],
  add column if not exists applicable_service_types text[] not null default '{}'::text[],
  add column if not exists applicable_languages text[] not null default '{}'::text[],
  add column if not exists synonyms text[] not null default '{}'::text[],
  add column if not exists escalation_relevance text,
  add column if not exists internal_notes text,
  add column if not exists approval_date timestamptz,
  add column if not exists superseded_by uuid references public.knowledge_articles(id) on delete set null;

alter table public.knowledge_article_versions
  add column if not exists short_answer text,
  add column if not exists detailed_answer text,
  add column if not exists change_note text,
  add column if not exists source_answer text;

alter table public.knowledge_entries
  add column if not exists keywords text[] not null default '{}'::text[],
  add column if not exists synonyms text[] not null default '{}'::text[],
  add column if not exists applicable_cities text[] not null default '{}'::text[],
  add column if not exists applicable_service_types text[] not null default '{}'::text[],
  add column if not exists source text not null default 'approved_admin',
  add column if not exists reviewed_at timestamptz,
  add column if not exists search_document tsvector;

create or replace function private.set_knowledge_entry_search_document()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.search_document := to_tsvector(
    'simple',
    coalesce(new.title, '') || ' ' || coalesce(new.content, '') || ' ' ||
      array_to_string(coalesce(new.keywords, '{}'::text[]), ' ') || ' ' ||
      array_to_string(coalesce(new.synonyms, '{}'::text[]), ' ')
  );
  return new;
end;
$$;

update public.knowledge_entries
set search_document = to_tsvector(
  'simple',
  coalesce(title, '') || ' ' || coalesce(content, '') || ' ' ||
    array_to_string(coalesce(keywords, '{}'::text[]), ' ') || ' ' ||
    array_to_string(coalesce(synonyms, '{}'::text[]), ' ')
);

drop trigger if exists knowledge_entries_search_document_update on public.knowledge_entries;
create trigger knowledge_entries_search_document_update
before insert or update of title, content, keywords, synonyms on public.knowledge_entries
for each row execute function private.set_knowledge_entry_search_document();

create table if not exists public.knowledge_builder_questions (
  id uuid primary key default gen_random_uuid(),
  question_key text not null unique,
  question text not null,
  why_it_matters text not null,
  current_knowledge text not null default '',
  missing_information text not null,
  suggested_answer_format text not null,
  category text not null,
  subcategory text,
  priority integer not null default 50 check (priority between 0 and 100),
  blocks_customer_support boolean not null default false,
  status text not null default 'awaiting_owner_answer' check (status in (
    'draft_question', 'awaiting_owner_answer', 'owner_answered', 'needs_clarification',
    'pending_approval', 'approved', 'rejected', 'superseded', 'archived'
  )),
  owner_answer text,
  normalized_short_answer text,
  normalized_detailed_answer text,
  owner_answered_by uuid references auth.users(id) on delete set null,
  reviewer_id uuid references auth.users(id) on delete set null,
  related_question_ids uuid[] not null default '{}'::uuid[],
  source_gap_ids uuid[] not null default '{}'::uuid[],
  internal_notes text,
  answer_language text not null default 'en'
    check (answer_language in ('en', 'nl', 'fr', 'ar', 'es', 'de', 'pt')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  answered_at timestamptz,
  approved_at timestamptz
);

create table if not exists public.assistant_knowledge_gaps (
  id uuid primary key default gen_random_uuid(),
  fingerprint text not null unique,
  normalized_question text not null,
  sample_questions jsonb not null default '[]'::jsonb,
  language text not null default 'en'
    check (language in ('en', 'nl', 'fr', 'ar', 'es', 'de', 'pt')),
  intent text,
  category text,
  occurrence_count integer not null default 1 check (occurrence_count > 0),
  status text not null default 'open' check (status in ('open', 'linked', 'resolved', 'ignored', 'archived')),
  linked_question_id uuid references public.knowledge_builder_questions(id) on delete set null,
  last_conversation_id uuid references public.assistant_conversations(id) on delete set null,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.assistant_provider_events (
  id bigint generated always as identity primary key,
  conversation_id uuid references public.assistant_conversations(id) on delete set null,
  provider text not null,
  operation text not null,
  model text,
  success boolean not null,
  latency_ms integer not null default 0 check (latency_ms >= 0),
  prompt_tokens integer,
  completion_tokens integer,
  total_tokens integer,
  failure_code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists knowledge_entries_search_document_idx
  on public.knowledge_entries using gin (search_document);
create index if not exists knowledge_entries_approved_filter_idx
  on public.knowledge_entries (status, language, category, version desc);
create index if not exists knowledge_builder_questions_queue_idx
  on public.knowledge_builder_questions (status, blocks_customer_support desc, priority desc, updated_at);
create index if not exists assistant_knowledge_gaps_priority_idx
  on public.assistant_knowledge_gaps (status, occurrence_count desc, last_seen_at desc);
create index if not exists assistant_provider_events_created_idx
  on public.assistant_provider_events (provider, operation, created_at desc);

drop trigger if exists knowledge_builder_questions_set_updated_at on public.knowledge_builder_questions;
create trigger knowledge_builder_questions_set_updated_at before update on public.knowledge_builder_questions
for each row execute function private.set_updated_at();

alter table public.knowledge_builder_questions enable row level security;
alter table public.assistant_knowledge_gaps enable row level security;
alter table public.assistant_provider_events enable row level security;

revoke all on table public.knowledge_builder_questions, public.assistant_knowledge_gaps,
  public.assistant_provider_events from public, anon, authenticated;
grant select, insert, update, delete on table public.knowledge_builder_questions,
  public.assistant_knowledge_gaps, public.assistant_provider_events to service_role;
grant usage, select on sequence public.assistant_provider_events_id_seq to service_role;

create or replace function public.approve_knowledge_builder_question(
  p_question_id uuid,
  p_reviewer_id uuid
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  q public.knowledge_builder_questions%rowtype;
  v_article_id uuid;
  next_version integer;
  article_category text;
  article_slug text;
  approved_answer text;
begin
  select * into q
  from public.knowledge_builder_questions
  where id = p_question_id
  for update;

  if not found then raise exception 'knowledge_question_not_found'; end if;
  if q.status <> 'pending_approval' then raise exception 'knowledge_question_not_pending_approval'; end if;
  approved_answer := coalesce(nullif(q.normalized_detailed_answer, ''), nullif(q.owner_answer, ''));
  if approved_answer is null then raise exception 'knowledge_answer_required'; end if;

  article_category := case
    when lower(q.category) like '%price%' then 'pricing'
    when lower(q.category) similar to '%(payment|refund)%' then 'payments'
    when lower(q.category) similar to '%(subscription|billing)%' then 'billing'
    when lower(q.category) similar to '%(access|key|lock)%' then 'access'
    when lower(q.category) similar to '%(assessment|first cleaning)%' then 'assessment'
    when lower(q.category) similar to '%(service|clean)%' then 'services'
    when lower(q.category) similar to '%(company|area|cities)%' then 'company'
    else 'policies'
  end;
  article_slug := left('owner-' || q.question_key, 180);

  insert into public.knowledge_articles (
    slug, category, subcategory, status, visibility, canonical_language,
    effective_date, last_reviewed_date, approval_date, keywords,
    applicable_languages, escalation_relevance, metadata
  ) values (
    article_slug, article_category, q.subcategory, 'approved', 'public', q.answer_language,
    current_date, current_date, now(),
    array_remove(array[lower(q.category), lower(coalesce(q.subcategory, ''))], ''),
    array[q.answer_language], 'owner_approved',
    jsonb_build_object('knowledge_builder_question_id', q.id)
  )
  on conflict (slug) do update set
    category = excluded.category,
    subcategory = excluded.subcategory,
    status = 'approved',
    visibility = 'public',
    canonical_language = excluded.canonical_language,
    effective_date = excluded.effective_date,
    last_reviewed_date = excluded.last_reviewed_date,
    approval_date = excluded.approval_date,
    keywords = excluded.keywords,
    applicable_languages = excluded.applicable_languages,
    escalation_relevance = excluded.escalation_relevance,
    metadata = public.knowledge_articles.metadata || excluded.metadata,
    updated_at = now()
  returning id into v_article_id;

  select coalesce(max(version), 0) + 1 into next_version
  from public.knowledge_article_versions
  where article_id = v_article_id;

  insert into public.knowledge_article_versions (
    article_id, version, title, summary, body, short_answer,
    detailed_answer, source_answer, change_note, approved_at
  ) values (
    v_article_id, next_version, q.question,
    coalesce(nullif(q.normalized_short_answer, ''), left(approved_answer, 500)),
    approved_answer,
    coalesce(nullif(q.normalized_short_answer, ''), left(approved_answer, 500)),
    approved_answer, q.owner_answer,
    'Approved from Knowledge Builder question ' || q.question_key, now()
  );

  update public.knowledge_entries
  set status = 'archived', updated_at = now()
  where slug = article_slug
    and language = q.answer_language
    and status = 'published';

  insert into public.knowledge_entries (
    slug, category, title, language, content, status, version,
    effective_from, keywords, source, reviewed_at
  ) values (
    article_slug, article_category, q.question, q.answer_language, approved_answer,
    'published', next_version, now(),
    array_remove(array[lower(q.category), lower(coalesce(q.subcategory, ''))], ''),
    'knowledge_builder:' || q.id::text, now()
  )
  on conflict (slug, language, version) do update set
    category = excluded.category,
    title = excluded.title,
    content = excluded.content,
    status = 'published',
    effective_from = excluded.effective_from,
    keywords = excluded.keywords,
    source = excluded.source,
    reviewed_at = excluded.reviewed_at,
    updated_at = now();

  update public.knowledge_builder_questions
  set status = 'approved', reviewer_id = p_reviewer_id, approved_at = now()
  where id = q.id;

  update public.assistant_knowledge_gaps
  set status = 'resolved', metadata = metadata || jsonb_build_object('resolved_article_id', v_article_id)
  where id = any(q.source_gap_ids);

  insert into public.assistant_audit_logs (
    actor_type, actor_reference, action, subject_table, subject_id, metadata
  ) values (
    'admin', p_reviewer_id::text, 'knowledge_answer_approved',
    'knowledge_articles', v_article_id::text,
    jsonb_build_object('question_id', q.id, 'version', next_version)
  );
end;
$$;

revoke all on function public.approve_knowledge_builder_question(uuid, uuid) from public, anon, authenticated;
grant execute on function public.approve_knowledge_builder_question(uuid, uuid) to service_role;

create or replace function public.cleanup_assistant_knowledge_retention(
  knowledge_gap_retention_days integer,
  provider_event_retention_days integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  deleted_gaps integer := 0;
  deleted_provider_events integer := 0;
begin
  if knowledge_gap_retention_days < 1 or provider_event_retention_days < 1 then
    raise exception 'retention days must be positive';
  end if;
  delete from public.assistant_knowledge_gaps
  where last_seen_at < now() - make_interval(days => knowledge_gap_retention_days);
  get diagnostics deleted_gaps = row_count;
  delete from public.assistant_provider_events
  where created_at < now() - make_interval(days => provider_event_retention_days);
  get diagnostics deleted_provider_events = row_count;
  return jsonb_build_object('knowledge_gaps', deleted_gaps, 'provider_events', deleted_provider_events);
end;
$$;

revoke all on function public.cleanup_assistant_knowledge_retention(integer, integer) from public, anon, authenticated;
grant execute on function public.cleanup_assistant_knowledge_retention(integer, integer) to service_role;

insert into public.knowledge_builder_questions (
  question_key, question, why_it_matters, current_knowledge, missing_information,
  suggested_answer_format, category, subcategory, priority, blocks_customer_support
) values
  ('pricing-custom-over-250', 'How should Dar Tahara price properties larger than 250 m²?', 'The calculator currently requires a tailored quotation above its supported range.', 'Properties up to 250 m² can be estimated by the approved calculator; larger homes receive a tailored quotation.', 'The pricing method, minimum charge, and who may approve the quotation.', '- Pricing method:\n- Minimum charge:\n- Approval role:\n- City exceptions:', 'Pricing', 'Large properties', 100, true),
  ('included-windows', 'Are interior and exterior window cleaning included in each standard subscription tier?', 'Window cleaning is a frequent inclusion question and the current knowledge only says it may require separate confirmation or pricing.', 'Window cleaning can require separate confirmation or pricing.', 'Which sides are included, frequency, safety/height limits, and any extra fee.', '- Interior windows:\n- Exterior windows:\n- Frequency:\n- Height/safety limit:\n- Extra fee:', 'Included services', 'Window cleaning', 98, true),
  ('first-cleaning-scope', 'What exactly is completed during the first paid cleaning after the Initial Home Assessment?', 'Customers need to understand the difference between assessment, first cleaning, and recurring service.', 'The assessment is prepaid and the ongoing subscription may be adjusted afterward.', 'The first-cleaning checklist, duration rule, exclusions, and whether deep cleaning is automatic.', '- Included tasks:\n- Deep cleaning included?\n- Duration rule:\n- Exclusions:', 'First cleaning', 'Scope', 96, true),
  ('subscription-pause', 'May a customer pause a monthly or annual subscription, and under what conditions?', 'Customers commonly need temporary travel or vacancy arrangements.', 'Dar Tahara supports recurring subscriptions and annual billing, but no approved pause policy is present.', 'Minimum pause, maximum pause, notice period, fees, and annual-term effect.', '- Notice period:\n- Min/max pause:\n- Fee:\n- Effect on annual term:', 'Subscription rules', 'Pausing', 94, true),
  ('physical-key-fee', 'What extra fee applies when Dar Tahara stores a physical key?', 'Customers are told a management fee may apply, but no approved amount or billing frequency is defined.', 'A physical key can be logged and stored when agreed; an extra management fee and conditions may apply.', 'Amount, monthly or per-visit billing, insurance condition, and city differences.', '- Amount:\n- Per month or per visit:\n- Insurance requirement:\n- City differences:', 'Property access', 'Physical keys', 100, true),
  ('digital-lock-policy', 'Which digital-lock models are supported and what does the approximately €200 installation include?', 'Customers need a precise, non-invented compatibility and installation answer.', 'A TTLock-compatible Wi-Fi smart lock installation is approximately €200 and needs internet.', 'Approved models, hardware/labour inclusion, warranty, internet requirements, and city coverage.', '- Models:\n- €200 includes:\n- Warranty:\n- Internet requirement:\n- Cities:', 'Property access', 'Digital locks', 99, true),
  ('cancellation-notice', 'How many hours before a confirmed cleaning may a customer cancel without a fee?', 'Cancellation questions require a precise contractual rule and should not be improvised.', 'Confirmed bookings require staff action to cancel; no complete fee schedule is approved.', '- Notice period, late-cancellation fee, no-show fee, and exceptions.', '- Free cancellation until:\n- Late fee:\n- No-show fee:\n- Exceptions:', 'Cancellations', 'Notice and fees', 100, true),
  ('refund-policy', 'Which payments are refundable, within what period, and who approves a refund?', 'Refund rights are legally and financially sensitive and currently require manual review.', 'Refund transactions are validated server-side and disputes are escalated for account review.', 'Eligible payment types, time limit, partial-refund rules, processing time, and approver.', '- Eligible payments:\n- Request deadline:\n- Partial refunds:\n- Processing time:\n- Approver:', 'Refunds', 'Eligibility', 100, true),
  ('supported-cities-boundaries', 'What exact service boundaries and launch status apply in Tangier, Casablanca, Rabat, and Marrakech?', 'The website names focus cities but customers need reliable neighborhood and availability information.', 'Dar Tahara currently focuses on Tangier, Casablanca, Rabat, and Marrakech, with expansion over time.', 'Live launch status, included districts, travel surcharges, and areas not served.', '- City/status:\n- Included districts:\n- Surcharge areas:\n- Not served:', 'Service areas', 'Launch cities', 97, true),
  ('human-escalation-sla', 'During which hours is human support available and what response time may the assistant promise?', 'Escalation messages must set accurate expectations without inventing availability.', 'Support cases and FreeScout escalation exist, but no approved customer-facing SLA is present.', 'Working hours, timezone, normal response target, urgent response target, and holidays.', '- Working hours/timezone:\n- Normal response target:\n- Urgent response target:\n- Holiday coverage:', 'Human escalation', 'Availability and SLA', 100, true)
on conflict (question_key) do nothing;

notify pgrst, 'reload schema';

-- Merge conceptually equivalent Knowledge Builder owner questions onto one canonical question per
-- business policy. Nothing is deleted: source gap ids, occurrence counts and audit history are
-- preserved, and the duplicate is retained in the 'superseded' state with a link to the canonical.

create or replace function public.merge_knowledge_builder_question(
  p_duplicate_id uuid,
  p_canonical_id uuid,
  p_actor uuid default null
) returns void
language plpgsql
security definer
set search_path = public, private
as $$
declare
  d public.knowledge_builder_questions;
  c public.knowledge_builder_questions;
begin
  if p_duplicate_id = p_canonical_id then
    raise exception 'merge_requires_distinct_questions';
  end if;

  select * into d from public.knowledge_builder_questions where id = p_duplicate_id for update;
  if not found then raise exception 'merge_duplicate_not_found'; end if;

  select * into c from public.knowledge_builder_questions where id = p_canonical_id for update;
  if not found then raise exception 'merge_canonical_not_found'; end if;

  if d.status = 'approved' then
    raise exception 'merge_cannot_supersede_approved_question';
  end if;

  -- Canonical question absorbs the duplicate's gap evidence and records the relationship.
  update public.knowledge_builder_questions set
    source_gap_ids = (
      select coalesce(array_agg(distinct gap_id), '{}'::uuid[])
      from unnest(c.source_gap_ids || d.source_gap_ids) as gap_id
    ),
    related_question_ids = (
      select coalesce(array_agg(distinct question_id), '{}'::uuid[])
      from unnest(c.related_question_ids || array[d.id]) as question_id
    ),
    updated_at = now()
  where id = c.id;

  -- Gaps keep their occurrence counts and conversation links, and now point at the canonical.
  update public.assistant_knowledge_gaps set
    linked_question_id = c.id,
    status = 'linked',
    metadata = metadata || jsonb_build_object('merged_from_question_id', d.id)
  where linked_question_id = d.id;

  -- The duplicate is kept for audit purposes rather than deleted.
  update public.knowledge_builder_questions set
    status = 'superseded',
    related_question_ids = (
      select coalesce(array_agg(distinct question_id), '{}'::uuid[])
      from unnest(d.related_question_ids || array[c.id]) as question_id
    ),
    internal_notes = concat_ws(
      E'\n', d.internal_notes,
      'Superseded by canonical owner question ' || c.question_key || ' on ' || now()::date || '.'
    ),
    reviewer_id = coalesce(p_actor, d.reviewer_id),
    updated_at = now()
  where id = d.id;

  insert into public.assistant_audit_logs (
    actor_type, actor_reference, action, subject_table, subject_id, metadata
  ) values (
    'system', coalesce(p_actor::text, 'migration'), 'knowledge_question_merged',
    'knowledge_builder_questions', d.id::text,
    jsonb_build_object(
      'canonical_question_id', c.id,
      'canonical_question_key', c.question_key,
      'duplicate_question_key', d.question_key,
      'moved_gap_ids', to_jsonb(d.source_gap_ids),
      'content_logged', false
    )
  );
end;
$$;

revoke all on function public.merge_knowledge_builder_question(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.merge_knowledge_builder_question(uuid, uuid, uuid) to service_role;

-- Physical-key storage fee was captured in Dutch as its own owner question because concept
-- clustering was English-only. Fold any language variant onto the seeded 'physical-key-fee'
-- question. Idempotent: merged duplicates become 'superseded' and stop matching.
do $$
declare
  v_canonical uuid;
  v_duplicate uuid;
begin
  select id into v_canonical
  from public.knowledge_builder_questions
  where question_key = 'physical-key-fee';
  if v_canonical is null then return; end if;

  for v_duplicate in
    select q.id
    from public.knowledge_builder_questions q
    where q.question_key like 'gap-%'
      and q.status not in ('superseded', 'approved', 'archived')
      and q.id <> v_canonical
      and exists (
        select 1 from public.assistant_knowledge_gaps g
        where g.linked_question_id = q.id
          and g.normalized_question ~ '(key|keys|sleutel|cle|clef|llave|schlussel|chave|مفتاح)'
          and g.normalized_question ~ '(fee|cost|charge|price|kost|prijs|tarief|frais|cout|prix|precio|coste|gebuhr|preis|taxa|custo|preco|رسوم|تكلفة|سعر)'
      )
  loop
    perform public.merge_knowledge_builder_question(v_duplicate, v_canonical, null);
  end loop;
end;
$$;

notify pgrst, 'reload schema';

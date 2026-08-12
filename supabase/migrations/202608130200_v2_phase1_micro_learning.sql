-- =============================================================================
-- v2 Phase 1: micro-learning schema
-- Branch: feature/v2-micro-learning
--
-- UP:   create source_contents, generated_courses, lessons, lesson_tasks,
--       user_lesson_progress (+ indexes, RLS, policies,
--       identity-guard trigger, status/task_flags comments)
-- DOWN: see rollback section at bottom (drop new objects only)
--
-- Constraints:
--   - Does NOT alter existing tables: profiles, point_logs, activation_codes, courses
--   - Does NOT modify existing RPCs
--   - No data backfill / legacy course conversion
--   - No Phase 2 tables (user_daily_state / user_vocab / task_events / streak)
--
-- Self-check:
--   Create order: source_contents -> generated_courses -> lessons
--                 -> lesson_tasks -> user_lesson_progress
--   FK targets: auth.users, public.courses (v1 read-only ref), then new tables
--   Function names prefixed set_v2_* / prevent_user_lesson_progress_* (avoid v1 clash)
--   Policies: drop if exists + create (safe re-apply of policy section)
--   Tables: create if not exists (schema drift not auto-fixed on re-run)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1) source_contents — original media / transcript warehouse
-- -----------------------------------------------------------------------------
create table if not exists public.source_contents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references auth.users (id) on delete cascade,
  title text not null default '未命名素材',
  source_type text not null
    check (source_type in (
      'audio',
      'video',
      'podcast',
      'youtube_subs',
      'article',
      'upload',
      'legacy_course'
    )),
  origin_url text,
  audio_source_type text
    check (audio_source_type is null or audio_source_type in ('local', 'url')),
  audio_url text,
  duration_sec integer check (duration_sec is null or duration_sec >= 0),
  language text not null default 'en',
  -- Raw full subtitle / transcript sentences (source of truth)
  subtitle_data jsonb not null default '[]'::jsonb,
  raw_transcript text,
  visibility text not null default 'private'
    check (visibility in ('private', 'platform_curated')),
  status text not null default 'ready'
    check (status in (
      'uploaded',
      'transcribing',
      'transcribed',
      'ready',
      'failed'
    )),
  error_message text,
  -- Trace only; does not alter public.courses
  legacy_course_id uuid references public.courses (id) on delete set null,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint source_contents_visibility_owner_chk check (
    (visibility = 'private' and user_id is not null)
    or (visibility = 'platform_curated')
  )
);

create index if not exists source_contents_user_id_idx
  on public.source_contents (user_id);
create index if not exists source_contents_visibility_idx
  on public.source_contents (visibility);
create index if not exists source_contents_status_idx
  on public.source_contents (status);
create index if not exists source_contents_legacy_course_id_idx
  on public.source_contents (legacy_course_id)
  where legacy_course_id is not null;
create index if not exists source_contents_created_at_idx
  on public.source_contents (created_at desc);

comment on table public.source_contents is
  'v2: original content warehouse. subtitle_data = full raw captions.';
comment on column public.source_contents.subtitle_data is
  'Original full sentence array; not lesson-sliced training captions.';
comment on column public.source_contents.duration_sec is
  'Total duration in whole seconds (rounded).';

-- -----------------------------------------------------------------------------
-- 2) generated_courses — learnable course packs (private or official)
-- -----------------------------------------------------------------------------
create table if not exists public.generated_courses (
  id uuid primary key default gen_random_uuid(),
  -- NULL only when visibility = platform_curated (official packs)
  user_id uuid references auth.users (id) on delete cascade,
  source_content_id uuid not null
    references public.source_contents (id) on delete cascade,
  title text not null default '未命名课程',
  summary text,
  visibility text not null default 'private'
    check (visibility in ('private', 'platform_curated')),
  recommended_lesson_count integer not null default 1
    check (recommended_lesson_count >= 1),
  target_lesson_minutes integer not null default 10
    check (target_lesson_minutes between 5 and 30),
  actual_lesson_count integer not null default 0
    check (actual_lesson_count >= 0),
  status text not null default 'ready'
    check (status in (
      'draft',
      'generating',
      'ready',
      'failed',
      'archived'
    )),
  generation_meta jsonb not null default '{}'::jsonb,
  legacy_course_id uuid references public.courses (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint generated_courses_visibility_owner_chk check (
    (visibility = 'private' and user_id is not null)
    or (visibility = 'platform_curated' and user_id is null)
  )
);

create index if not exists generated_courses_user_id_idx
  on public.generated_courses (user_id);
create index if not exists generated_courses_source_content_id_idx
  on public.generated_courses (source_content_id);
create index if not exists generated_courses_visibility_idx
  on public.generated_courses (visibility);
create index if not exists generated_courses_status_idx
  on public.generated_courses (status);
create index if not exists generated_courses_legacy_course_id_idx
  on public.generated_courses (legacy_course_id)
  where legacy_course_id is not null;
create index if not exists generated_courses_created_at_idx
  on public.generated_courses (created_at desc);

comment on table public.generated_courses is
  'v2: course pack. private => user_id set; platform_curated => user_id null.';

-- -----------------------------------------------------------------------------
-- 3) lessons — ~10 min micro-lessons
-- -----------------------------------------------------------------------------
create table if not exists public.lessons (
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null
    references public.generated_courses (id) on delete cascade,
  index_no integer not null check (index_no >= 1),
  title text not null default 'Lesson',
  start_sec integer not null default 0 check (start_sec >= 0),
  end_sec integer not null,
  estimated_minutes integer check (estimated_minutes is null or estimated_minutes >= 1),
  -- Training slice captions for this lesson window only
  subtitle_data jsonb not null default '[]'::jsonb,
  difficulty_level text
    check (
      difficulty_level is null
      or difficulty_level in (
        'A1', 'A2', 'B1', 'B2', 'C1', 'C2',
        'IELTS', 'TOEFL', 'BUSINESS', 'NEWS', 'GENERAL'
      )
    ),
  status text not null default 'ready'
    check (status in ('ready', 'hidden', 'draft')),
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lessons_time_window_chk check (end_sec > start_sec),
  constraint lessons_course_index_uniq unique (course_id, index_no)
);

create index if not exists lessons_course_id_idx
  on public.lessons (course_id);
create index if not exists lessons_course_index_idx
  on public.lessons (course_id, index_no);
create index if not exists lessons_difficulty_level_idx
  on public.lessons (difficulty_level)
  where difficulty_level is not null;

comment on table public.lessons is
  'v2: micro-lesson. subtitle_data = training slice only; rebuildable from source.';
comment on column public.lessons.subtitle_data is
  'Sliced captions within [start_sec, end_sec]; not the full source transcript.';
comment on column public.lessons.start_sec is
  'Virtual audio window start (whole seconds).';
comment on column public.lessons.end_sec is
  'Virtual audio window end (whole seconds).';

-- -----------------------------------------------------------------------------
-- 4) lesson_tasks — per-lesson task templates (not per-user completion)
-- -----------------------------------------------------------------------------
create table if not exists public.lesson_tasks (
  id uuid primary key default gen_random_uuid(),
  lesson_id uuid not null
    references public.lessons (id) on delete cascade,
  task_key text not null
    check (task_key in (
      'listen',
      'ai_analyze',
      'vocab',
      'shadowing',
      'dictation',
      'review',
      'complete'
    )),
  title text not null,
  sort_order integer not null default 0,
  is_required boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint lesson_tasks_lesson_key_uniq unique (lesson_id, task_key)
);

create index if not exists lesson_tasks_lesson_id_idx
  on public.lesson_tasks (lesson_id);
create index if not exists lesson_tasks_lesson_sort_idx
  on public.lesson_tasks (lesson_id, sort_order);

comment on table public.lesson_tasks is
  'v2: lesson task templates. Completion lives in user_lesson_progress.task_flags.';

-- -----------------------------------------------------------------------------
-- 5) user_lesson_progress — learner progress (private or curated courses)
-- -----------------------------------------------------------------------------
create table if not exists public.user_lesson_progress (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  course_id uuid not null
    references public.generated_courses (id) on delete cascade,
  lesson_id uuid not null
    references public.lessons (id) on delete cascade,
  status text not null default 'not_started'
    check (status in ('not_started', 'in_progress', 'completed')),
  -- e.g. {"listen": true, "complete": true}
  task_flags jsonb not null default '{}'::jsonb,
  study_seconds integer not null default 0 check (study_seconds >= 0),
  sentences_done integer not null default 0 check (sentences_done >= 0),
  started_at timestamptz,
  completed_at timestamptz,
  last_studied_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint user_lesson_progress_user_lesson_uniq unique (user_id, lesson_id)
);

create index if not exists user_lesson_progress_user_id_idx
  on public.user_lesson_progress (user_id);
create index if not exists user_lesson_progress_course_id_idx
  on public.user_lesson_progress (course_id);
create index if not exists user_lesson_progress_lesson_id_idx
  on public.user_lesson_progress (lesson_id);
create index if not exists user_lesson_progress_user_status_idx
  on public.user_lesson_progress (user_id, status);
create index if not exists user_lesson_progress_completed_at_idx
  on public.user_lesson_progress (user_id, completed_at desc)
  where completed_at is not null;

comment on table public.user_lesson_progress is
  'v2: per-user lesson progress for own private courses or platform_curated courses. Phase 1 has no task engine: completion is a simple flag pair (see status / task_flags).';
comment on column public.user_lesson_progress.status is
  'not_started | in_progress | completed. Phase 1 contract: status=completed means the lesson is done for daily progress. App MUST set task_flags.complete=true (and usually completed_at) in the same update. No server-side task-graph validation in Phase 1.';
comment on column public.user_lesson_progress.task_flags is
  'Optional per-task booleans keyed by lesson_tasks.task_key. Contract: task_flags.complete=true corresponds to status=completed. Other keys (listen/shadowing/...) are soft progress only; Phase 1 does not enforce them.';
comment on column public.user_lesson_progress.user_id is
  'Immutable after insert (trigger prevent_user_lesson_progress_identity_change).';
comment on column public.user_lesson_progress.course_id is
  'Immutable after insert (trigger). Must equal lessons.course_id at insert.';
comment on column public.user_lesson_progress.lesson_id is
  'Immutable after insert (trigger).';

-- -----------------------------------------------------------------------------
-- updated_at helper (new function only; does not touch existing RPCs)
-- -----------------------------------------------------------------------------
create or replace function public.set_v2_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

revoke all on function public.set_v2_updated_at() from public;
revoke all on function public.set_v2_updated_at() from anon, authenticated;

drop trigger if exists trg_source_contents_updated_at on public.source_contents;
create trigger trg_source_contents_updated_at
  before update on public.source_contents
  for each row execute function public.set_v2_updated_at();

drop trigger if exists trg_generated_courses_updated_at on public.generated_courses;
create trigger trg_generated_courses_updated_at
  before update on public.generated_courses
  for each row execute function public.set_v2_updated_at();

drop trigger if exists trg_lessons_updated_at on public.lessons;
create trigger trg_lessons_updated_at
  before update on public.lessons
  for each row execute function public.set_v2_updated_at();

drop trigger if exists trg_lesson_tasks_updated_at on public.lesson_tasks;
create trigger trg_lesson_tasks_updated_at
  before update on public.lesson_tasks
  for each row execute function public.set_v2_updated_at();

drop trigger if exists trg_user_lesson_progress_updated_at on public.user_lesson_progress;
create trigger trg_user_lesson_progress_updated_at
  before update on public.user_lesson_progress
  for each row execute function public.set_v2_updated_at();

-- -----------------------------------------------------------------------------
-- Identity lock: user_lesson_progress.user_id / course_id / lesson_id
-- RLS WITH CHECK alone cannot compare NEW to OLD for course_id/lesson_id.
-- -----------------------------------------------------------------------------
create or replace function public.prevent_user_lesson_progress_identity_change()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- Allowed updates: status, task_flags, study_seconds, sentences_done,
  -- started_at, completed_at, last_studied_at, updated_at (via other trigger).
  -- Blocked: user_id, course_id, lesson_id (and primary key id).
  if new.id is distinct from old.id
     or new.user_id is distinct from old.user_id
     or new.course_id is distinct from old.course_id
     or new.lesson_id is distinct from old.lesson_id then
    raise exception 'user_lesson_progress identity fields are immutable (id, user_id, course_id, lesson_id)'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke all on function public.prevent_user_lesson_progress_identity_change() from public;
revoke all on function public.prevent_user_lesson_progress_identity_change() from anon, authenticated;

drop trigger if exists trg_user_lesson_progress_identity_guard on public.user_lesson_progress;
create trigger trg_user_lesson_progress_identity_guard
  before update on public.user_lesson_progress
  for each row execute function public.prevent_user_lesson_progress_identity_change();

-- -----------------------------------------------------------------------------
-- RLS: source_contents
-- -----------------------------------------------------------------------------
alter table public.source_contents enable row level security;

drop policy if exists "source_contents_select_own_or_curated" on public.source_contents;
create policy "source_contents_select_own_or_curated"
  on public.source_contents for select
  to authenticated
  using (
    visibility = 'platform_curated'
    or (visibility = 'private' and user_id = auth.uid())
  );

drop policy if exists "source_contents_insert_own_private" on public.source_contents;
create policy "source_contents_insert_own_private"
  on public.source_contents for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and visibility = 'private'
  );

drop policy if exists "source_contents_update_own_private" on public.source_contents;
create policy "source_contents_update_own_private"
  on public.source_contents for update
  to authenticated
  using (user_id = auth.uid() and visibility = 'private')
  with check (user_id = auth.uid() and visibility = 'private');

drop policy if exists "source_contents_delete_own_private" on public.source_contents;
create policy "source_contents_delete_own_private"
  on public.source_contents for delete
  to authenticated
  using (user_id = auth.uid() and visibility = 'private');

-- -----------------------------------------------------------------------------
-- RLS: generated_courses
--   platform_curated => any authenticated user can read
--   private => owner only read/write
-- -----------------------------------------------------------------------------
alter table public.generated_courses enable row level security;

drop policy if exists "generated_courses_select_own_or_curated" on public.generated_courses;
create policy "generated_courses_select_own_or_curated"
  on public.generated_courses for select
  to authenticated
  using (
    visibility = 'platform_curated'
    or (visibility = 'private' and user_id = auth.uid())
  );

-- Private pack only; source must be own private OR platform_curated (no hijack).
drop policy if exists "generated_courses_insert_own_private" on public.generated_courses;
create policy "generated_courses_insert_own_private"
  on public.generated_courses for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and visibility = 'private'
    and exists (
      select 1
      from public.source_contents sc
      where sc.id = source_content_id
        and (
          sc.visibility = 'platform_curated'
          or (sc.visibility = 'private' and sc.user_id = auth.uid())
        )
    )
  );

drop policy if exists "generated_courses_update_own_private" on public.generated_courses;
create policy "generated_courses_update_own_private"
  on public.generated_courses for update
  to authenticated
  using (user_id = auth.uid() and visibility = 'private')
  with check (
    user_id = auth.uid()
    and visibility = 'private'
    and exists (
      select 1
      from public.source_contents sc
      where sc.id = source_content_id
        and (
          sc.visibility = 'platform_curated'
          or (sc.visibility = 'private' and sc.user_id = auth.uid())
        )
    )
  );

drop policy if exists "generated_courses_delete_own_private" on public.generated_courses;
create policy "generated_courses_delete_own_private"
  on public.generated_courses for delete
  to authenticated
  using (user_id = auth.uid() and visibility = 'private');

-- -----------------------------------------------------------------------------
-- RLS: lessons
--   read: parent course owner OR platform_curated
--   write: private course owner only
-- -----------------------------------------------------------------------------
alter table public.lessons enable row level security;

drop policy if exists "lessons_select_own_or_curated_course" on public.lessons;
create policy "lessons_select_own_or_curated_course"
  on public.lessons for select
  to authenticated
  using (
    exists (
      select 1
      from public.generated_courses gc
      where gc.id = lessons.course_id
        and (
          (gc.visibility = 'private' and gc.user_id = auth.uid())
          or gc.visibility = 'platform_curated'
        )
    )
  );

drop policy if exists "lessons_insert_own_private_course" on public.lessons;
create policy "lessons_insert_own_private_course"
  on public.lessons for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.generated_courses gc
      where gc.id = lessons.course_id
        and gc.user_id = auth.uid()
        and gc.visibility = 'private'
    )
  );

drop policy if exists "lessons_update_own_private_course" on public.lessons;
create policy "lessons_update_own_private_course"
  on public.lessons for update
  to authenticated
  using (
    exists (
      select 1
      from public.generated_courses gc
      where gc.id = lessons.course_id
        and gc.user_id = auth.uid()
        and gc.visibility = 'private'
    )
  )
  with check (
    exists (
      select 1
      from public.generated_courses gc
      where gc.id = lessons.course_id
        and gc.user_id = auth.uid()
        and gc.visibility = 'private'
    )
  );

drop policy if exists "lessons_delete_own_private_course" on public.lessons;
create policy "lessons_delete_own_private_course"
  on public.lessons for delete
  to authenticated
  using (
    exists (
      select 1
      from public.generated_courses gc
      where gc.id = lessons.course_id
        and gc.user_id = auth.uid()
        and gc.visibility = 'private'
    )
  );

-- -----------------------------------------------------------------------------
-- RLS: lesson_tasks (same ownership rules as lessons)
-- -----------------------------------------------------------------------------
alter table public.lesson_tasks enable row level security;

drop policy if exists "lesson_tasks_select_own_or_curated" on public.lesson_tasks;
create policy "lesson_tasks_select_own_or_curated"
  on public.lesson_tasks for select
  to authenticated
  using (
    exists (
      select 1
      from public.lessons l
      join public.generated_courses gc on gc.id = l.course_id
      where l.id = lesson_tasks.lesson_id
        and (
          (gc.visibility = 'private' and gc.user_id = auth.uid())
          or gc.visibility = 'platform_curated'
        )
    )
  );

drop policy if exists "lesson_tasks_insert_own_private" on public.lesson_tasks;
create policy "lesson_tasks_insert_own_private"
  on public.lesson_tasks for insert
  to authenticated
  with check (
    exists (
      select 1
      from public.lessons l
      join public.generated_courses gc on gc.id = l.course_id
      where l.id = lesson_tasks.lesson_id
        and gc.user_id = auth.uid()
        and gc.visibility = 'private'
    )
  );

drop policy if exists "lesson_tasks_update_own_private" on public.lesson_tasks;
create policy "lesson_tasks_update_own_private"
  on public.lesson_tasks for update
  to authenticated
  using (
    exists (
      select 1
      from public.lessons l
      join public.generated_courses gc on gc.id = l.course_id
      where l.id = lesson_tasks.lesson_id
        and gc.user_id = auth.uid()
        and gc.visibility = 'private'
    )
  )
  with check (
    exists (
      select 1
      from public.lessons l
      join public.generated_courses gc on gc.id = l.course_id
      where l.id = lesson_tasks.lesson_id
        and gc.user_id = auth.uid()
        and gc.visibility = 'private'
    )
  );

drop policy if exists "lesson_tasks_delete_own_private" on public.lesson_tasks;
create policy "lesson_tasks_delete_own_private"
  on public.lesson_tasks for delete
  to authenticated
  using (
    exists (
      select 1
      from public.lessons l
      join public.generated_courses gc on gc.id = l.course_id
      where l.id = lesson_tasks.lesson_id
        and gc.user_id = auth.uid()
        and gc.visibility = 'private'
    )
  );

-- -----------------------------------------------------------------------------
-- RLS: user_lesson_progress
--   learn own private courses OR platform_curated courses
-- -----------------------------------------------------------------------------
alter table public.user_lesson_progress enable row level security;

drop policy if exists "user_lesson_progress_select_own" on public.user_lesson_progress;
create policy "user_lesson_progress_select_own"
  on public.user_lesson_progress for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "user_lesson_progress_insert_own_learnable" on public.user_lesson_progress;
create policy "user_lesson_progress_insert_own_learnable"
  on public.user_lesson_progress for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1
      from public.generated_courses gc
      where gc.id = course_id
        and (
          (gc.visibility = 'private' and gc.user_id = auth.uid())
          or gc.visibility = 'platform_curated'
        )
    )
    and exists (
      select 1
      from public.lessons l
      where l.id = lesson_id
        and l.course_id = course_id
    )
  );

-- UPDATE may change: status, task_flags, study_seconds, sentences_done,
-- started_at, completed_at, last_studied_at (and updated_at via trigger).
-- Identity (id/user_id/course_id/lesson_id) blocked by trigger.
drop policy if exists "user_lesson_progress_update_own" on public.user_lesson_progress;
create policy "user_lesson_progress_update_own"
  on public.user_lesson_progress for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

drop policy if exists "user_lesson_progress_delete_own" on public.user_lesson_progress;
create policy "user_lesson_progress_delete_own"
  on public.user_lesson_progress for delete
  to authenticated
  using (user_id = auth.uid());

-- =============================================================================
-- ROLLBACK (manual)
-- Run the following ONLY to undo this migration. Does not touch v1 tables/RPCs.
-- =============================================================================
--
-- drop policy if exists "user_lesson_progress_delete_own" on public.user_lesson_progress;
-- drop policy if exists "user_lesson_progress_update_own" on public.user_lesson_progress;
-- drop policy if exists "user_lesson_progress_insert_own_learnable" on public.user_lesson_progress;
-- drop policy if exists "user_lesson_progress_select_own" on public.user_lesson_progress;
--
-- drop policy if exists "lesson_tasks_delete_own_private" on public.lesson_tasks;
-- drop policy if exists "lesson_tasks_update_own_private" on public.lesson_tasks;
-- drop policy if exists "lesson_tasks_insert_own_private" on public.lesson_tasks;
-- drop policy if exists "lesson_tasks_select_own_or_curated" on public.lesson_tasks;
--
-- drop policy if exists "lessons_delete_own_private_course" on public.lessons;
-- drop policy if exists "lessons_update_own_private_course" on public.lessons;
-- drop policy if exists "lessons_insert_own_private_course" on public.lessons;
-- drop policy if exists "lessons_select_own_or_curated_course" on public.lessons;
--
-- drop policy if exists "generated_courses_delete_own_private" on public.generated_courses;
-- drop policy if exists "generated_courses_update_own_private" on public.generated_courses;
-- drop policy if exists "generated_courses_insert_own_private" on public.generated_courses;
-- drop policy if exists "generated_courses_select_own_or_curated" on public.generated_courses;
--
-- drop policy if exists "source_contents_delete_own_private" on public.source_contents;
-- drop policy if exists "source_contents_update_own_private" on public.source_contents;
-- drop policy if exists "source_contents_insert_own_private" on public.source_contents;
-- drop policy if exists "source_contents_select_own_or_curated" on public.source_contents;
--
-- drop trigger if exists trg_user_lesson_progress_identity_guard on public.user_lesson_progress;
-- drop trigger if exists trg_user_lesson_progress_updated_at on public.user_lesson_progress;
-- drop trigger if exists trg_lesson_tasks_updated_at on public.lesson_tasks;
-- drop trigger if exists trg_lessons_updated_at on public.lessons;
-- drop trigger if exists trg_generated_courses_updated_at on public.generated_courses;
-- drop trigger if exists trg_source_contents_updated_at on public.source_contents;
--
-- drop table if exists public.user_lesson_progress;
-- drop table if exists public.lesson_tasks;
-- drop table if exists public.lessons;
-- drop table if exists public.generated_courses;
-- drop table if exists public.source_contents;
--
-- drop function if exists public.prevent_user_lesson_progress_identity_change();
-- drop function if exists public.set_v2_updated_at();
--
-- =============================================================================

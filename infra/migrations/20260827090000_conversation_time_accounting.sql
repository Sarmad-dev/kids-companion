-- -----------------------------------------------------------------------------
-- Conversation time counts TALKING, not wall clock
-- -----------------------------------------------------------------------------
-- `app.child_seconds_today` charged `coalesce(ended_at, now()) - started_at`.
-- For a conversation that ends properly that is right. For one that does not, it
-- charges a child for time nobody was present for:
--
--   A session abandoned at 16:54 — the app killed from the task switcher, a flat
--   battery, a dev server dying — was still accruing the next morning. It had
--   charged 54,140 seconds, just over fifteen hours, against a twenty-minute
--   daily limit. The limit was exhausted about twenty minutes after the phone
--   was put down, and every attempt to talk for the rest of the day was refused
--   with `daily_limit_reached`. Nothing swept the row, so nothing ever repaired
--   it. The same number is what a parent's dashboard reports as time their child
--   spent, which made the dashboard wrong in the same direction.
--
-- WHAT IS DELIBERATELY KEPT: an in-flight conversation still counts. That was
-- the original reason for measuring from `started_at` rather than from a
-- counter — "a child cannot sit just under the limit by never ending a session"
-- — and it survives here. A child who keeps talking keeps moving the last
-- message forward and keeps being charged for the whole span; only the tail
-- after talking STOPS is capped.
--
-- WHY THE LAST MESSAGE AND NOT `updated_at`: ending a conversation is itself a
-- row update, so the touch trigger moves `updated_at` to the moment of the end.
-- Capping on that would charge the full abandoned span at the instant anything
-- closed the row — exactly the case this exists to fix. A message is the child
-- actually saying something, and cannot be moved by bookkeeping.
--
-- THE GRACE covers the ordinary gap inside a live conversation: the reply
-- playing, then a child thinking before pressing the button again. Anything
-- longer is not a conversation in progress.
-- -----------------------------------------------------------------------------

create or replace function app.conversation_charged_until(p_conversation_id uuid)
returns timestamptz
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select least(
           coalesce(c.ended_at, now()),
           coalesce(
             (select max(m.created_at) from messages m where m.conversation_id = c.id),
             c.started_at
           ) + interval '2 minutes'
         )
    from conversations c
   where c.id = p_conversation_id;
$$;

comment on function app.conversation_charged_until(uuid) is
  'The instant a conversation stops costing time: it ended, or talking stopped and the grace elapsed.';

create or replace function app.conversation_seconds(p_conversation_id uuid)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (select greatest(
              0,
              extract(epoch from (
                app.conversation_charged_until(c.id) - c.started_at
              ))::int
            )
       from conversations c where c.id = p_conversation_id),
    0
  );
$$;

create or replace function app.child_seconds_today(p_child_id uuid)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(sum(
    greatest(
      0,
      extract(epoch from (app.conversation_charged_until(c.id) - c.started_at))::int
    )
  ), 0)::int
  from conversations c
  where c.child_id = p_child_id
    and c.started_at >= date_trunc('day', now() at time zone 'utc');
$$;

comment on function app.child_seconds_today(uuid) is
  'Time talking today, INCLUDING an in-flight session. Derived, so it cannot drift, and capped at the last message so an abandoned session cannot spend a child''s day.';

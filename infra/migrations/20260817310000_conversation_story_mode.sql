-- =============================================================================
-- Stories become a thing the server knows about
-- =============================================================================
--
-- "Stories" was a label. `StoryScreen` was `<ConversationScreen mode="story" />`
-- and `mode` changed exactly two things in the mobile app: a testID and one line
-- of body text. It did not change the prompt, it did not tell the API anything,
-- and it did not record a story.
--
-- Meanwhile `weekly_story_limit` was a column on every plan that nothing read,
-- and `story_completed` was a catalogued event type that nothing emitted — so
-- the plan table advertised a limit that was never enforced, next to a progress
-- counter that never moved.
--
-- A conversation now carries its mode, which is what makes the rest possible:
-- the prompt can ask for a story, the plan limit has something to count, and
-- ending one can record that it happened.
--
-- ═══════════════════════════════════════════════════════════════════════════
-- WHY A COLUMN AND NOT A SEPARATE TABLE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- A story IS a conversation: same messages, same safety pipeline, same
-- retention, same RLS. A `stories` table would duplicate every one of those
-- rules and give a future change two places to be applied and one place to be
-- forgotten. The mode is an attribute of the session, so it lives on it.
-- =============================================================================

alter table conversations add column mode text not null default 'chat';

alter table conversations add constraint ck_conversations_mode
  check (mode in ('chat', 'story'));

comment on column conversations.mode is
  'What kind of session this is. Drives the prompt, the weekly story limit, and whether finishing records a story.';

-- The weekly limit counts a child's story sessions since the start of the week,
-- and runs on the start path a child is standing in front of.
create index idx_conversations_story_week
  on conversations (child_id, started_at desc)
  where mode = 'story';

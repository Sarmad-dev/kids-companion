-- =============================================================================
-- Seed: reference data that belongs in EVERY environment.
-- =============================================================================
-- Languages, plans, and characters are product content, not user data, so they
-- ship with the schema. Development-only fixtures are NOT here — they live in
-- infra/scripts/seed-dev.mjs, which refuses to run outside local and ci.
--
-- Idempotent throughout, so re-running migrations against an existing database
-- is safe.

-- -----------------------------------------------------------------------------
-- Languages
-- -----------------------------------------------------------------------------
-- `stt_supported` is false for Urdu on purpose. Child-speech recognition for
-- Urdu is the largest technical risk in this product and is unproven until the
-- S-1 spike reports (docs/OPEN_QUESTIONS.md Q-01). Marking it supported here
-- before it is measured would be the schema asserting something we do not know.
insert into supported_languages
  (code, english_name, native_name, direction, stt_supported, tts_supported, is_active, sort_order)
values
  ('en', 'English', 'English',  'ltr', true,  true,  true,  10),
  ('ur', 'Urdu',    'اردو',      'rtl', false, true,  true,  20),
  ('pa', 'Punjabi', 'ਪੰਜਾਬੀ',     'ltr', false, false, false, 30),
  ('sd', 'Sindhi',  'سنڌي',      'rtl', false, false, false, 40),
  ('ps', 'Pashto',  'پښتو',      'rtl', false, false, false, 50),
  ('ar', 'Arabic',  'العربية',    'rtl', false, false, false, 60)
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- Subscription plans
-- -----------------------------------------------------------------------------
-- Prices are placeholders pending the S-2 unit-economics spike. Per-minute AI +
-- STT + TTS cost against Pakistani price points is an open question that could
-- invalidate the model entirely (DEVELOPMENT_PLAN.md R-02), so these are a
-- starting point for development, not a pricing decision.
insert into subscription_plans
  (code, display_name, description, tier, price_minor, currency, billing_interval,
   daily_minute_limit, child_profile_limit, weekly_story_limit, available_rails, sort_order, features)
values
  ('free',
   'Free',
   'Try the companion with a short daily session.',
   'free', 0, 'PKR', 'none',
   10, 1, 3,
   array['mock'],
   10,
   '{"characters": "limited", "parent_dashboard": true, "transcript_history_days": 7}'::jsonb),

  ('family_monthly',
   'Family Monthly',
   'Longer sessions, every character, up to four children.',
   'paid', 49900, 'PKR', 'month',
   60, 4, null,
   array['jazzcash', 'easypaisa', 'stripe', 'apple_iap', 'google_play'],
   20,
   '{"characters": "all", "parent_dashboard": true, "transcript_history_days": 90, "speech_practice": true}'::jsonb),

  ('family_annual',
   'Family Annual',
   'The monthly plan, billed yearly.',
   'paid', 499000, 'PKR', 'year',
   60, 4, null,
   array['jazzcash', 'easypaisa', 'stripe', 'apple_iap', 'google_play'],
   30,
   '{"characters": "all", "parent_dashboard": true, "transcript_history_days": 90, "speech_practice": true}'::jsonb)
on conflict (code) do nothing;

-- -----------------------------------------------------------------------------
-- Characters
-- -----------------------------------------------------------------------------
-- Personas differ in VOICE AND MANNER ONLY. None relaxes a safety rule, none
-- carries prompt text here — `prompt_version` pins the reviewed prompt that
-- lives in services/ai under review (docs/CHILD_SAFETY.md §7).
insert into ai_characters
  (slug, display_name, tagline, description, prompt_version, allowed_bands, status, sort_order)
values
  ('pip-the-fox',
   'Pip the Fox',
   'A curious little fox who loves questions and short stories.',
   'Pip asks more than they answer, and celebrates every attempt. Best for children who are just starting to talk in sentences.',
   'v1.character.pip',
   array['early', 'emerging', 'developing', 'fluent'],
   'active', 10),

  ('nano-the-robot',
   'Nano the Robot',
   'A friendly robot fascinated by how things work.',
   'Nano explains everyday things simply and is delighted to be corrected by a child.',
   'v1.character.nano',
   array['emerging', 'developing', 'fluent'],
   'active', 20),

  ('mira-the-moon',
   'Mira the Moon',
   'A calm companion for winding down and bedtime stories.',
   'Mira speaks slowly and quietly, and always ends a session gently rather than inviting another.',
   'v1.character.mira',
   array['early', 'emerging', 'developing', 'fluent'],
   'active', 30),

  ('captain-zia',
   'Captain Zia',
   'An adventurous explorer for longer stories and role-play.',
   'Zia runs gentle adventures with a problem and a resolution inside the same session.',
   'v1.character.zia',
   -- Not offered to the youngest band: sustained narrative and mild story
   -- tension do not suit a 3-year-old's turn length or content policy.
   array['developing', 'fluent'],
   'active', 40),

  ('dada-jee',
   'Dada Jee',
   'A warm grandfather who tells folk tales.',
   'Dada Jee tells short traditional stories. Urdu-first, and the reason the Urdu voice pipeline has to be good before this ships.',
   'v1.character.dadajee',
   array['emerging', 'developing', 'fluent'],
   -- Beta until Urdu safety classification reaches parity with English. A
   -- classifier weaker in Urdu than in English is a safety gap, not a
   -- localisation gap (docs/CHILD_SAFETY.md §9.1).
   'beta', 50)
on conflict (slug) do nothing;

-- Which character speaks which language.
insert into character_languages (character_id, language_code)
select c.id, l.code
from ai_characters c
cross join (values ('en')) as l(code)
where c.slug in ('pip-the-fox', 'nano-the-robot', 'mira-the-moon', 'captain-zia')
on conflict do nothing;

insert into character_languages (character_id, language_code)
select c.id, l.code
from ai_characters c
cross join (values ('en'), ('ur')) as l(code)
where c.slug in ('pip-the-fox', 'mira-the-moon', 'captain-zia', 'dada-jee')
on conflict do nothing;

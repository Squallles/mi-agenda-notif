-- ═══════════════════════════════════════════════════════════════
-- Mi Agenda Notif — Tablas en Supabase (control-instalaciones)
-- Prefijo agenda_ para evitar conflictos con otras tablas
-- ═══════════════════════════════════════════════════════════════

-- Suscripciones push
CREATE TABLE IF NOT EXISTS agenda_push_subscriptions (
  player_id   TEXT PRIMARY KEY,
  subscription JSONB NOT NULL,
  created_at  TIMESTAMPTZ DEFAULT now(),
  updated_at  TIMESTAMPTZ DEFAULT now()
);

-- Notificaciones programadas
CREATE TABLE IF NOT EXISTS agenda_scheduled_notifications (
  id          TEXT PRIMARY KEY,
  player_id   TEXT NOT NULL REFERENCES agenda_push_subscriptions(player_id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  body        TEXT,
  fire_at     BIGINT NOT NULL,
  event_id    TEXT,
  rem_index   INTEGER,
  fired       BOOLEAN DEFAULT false,
  sent_ok     BOOLEAN,
  retries     INTEGER DEFAULT 0,
  created_at  BIGINT NOT NULL
);

-- Índices para el polling
CREATE INDEX IF NOT EXISTS idx_agenda_notif_pending ON agenda_scheduled_notifications (fire_at) WHERE fired = false;
CREATE INDEX IF NOT EXISTS idx_agenda_notif_event   ON agenda_scheduled_notifications (event_id);
CREATE INDEX IF NOT EXISTS idx_agenda_notif_player  ON agenda_scheduled_notifications (player_id);

-- Unique para deduplicación
CREATE UNIQUE INDEX IF NOT EXISTS idx_agenda_notif_dedup
  ON agenda_scheduled_notifications (event_id, rem_index)
  WHERE event_id IS NOT NULL AND rem_index IS NOT NULL;

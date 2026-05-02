const express = require('express');
const cors    = require('cors');
const webpush = require('web-push');
const path    = require('path');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Config from env vars ────────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const API_KEY       = process.env.API_KEY;
const SUPABASE_URL  = process.env.SUPABASE_URL;
const SUPABASE_KEY  = process.env.SUPABASE_SERVICE_KEY;

if (!VAPID_PUBLIC || !VAPID_PRIVATE) throw new Error('Missing VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY env vars');
if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error('Missing SUPABASE_URL / SUPABASE_SERVICE_KEY env vars');
if (!API_KEY) throw new Error('Missing API_KEY env var');

webpush.setVapidDetails('mailto:ediciones.c@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Metrics ─────────────────────────────────────────────────────────────
const startedAt = Date.now();
let lastPushAt = null;
let pushCount  = 0;
let errorCount = 0;

// ── Auth middleware ─────────────────────────────────────────────────────
function requireKey(req, res, next) {
  // Public endpoints skip auth
  if (req.path === '/vapid-public' || req.path === '/health') return next();
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).json({ error: 'Invalid or missing API key' });
  next();
}
app.use('/api', requireKey);

// ── Send push with retry (max 2 retries) ───────────────────────────────
async function sendPush(playerId, title, body, attempt = 0) {
  const { data: row } = await supabase
    .from('agenda_push_subscriptions')
    .select('subscription')
    .eq('player_id', playerId)
    .single();

  if (!row) { console.warn('No subscription for player:', playerId); return false; }

  try {
    await webpush.sendNotification(row.subscription, JSON.stringify({ title, body }));
    console.log(`Sent to ${playerId}: ${title}`);
    pushCount++;
    lastPushAt = Date.now();
    return true;
  } catch (e) {
    console.error(`Push failed for ${playerId} (attempt ${attempt}):`, e.statusCode, e.body);
    errorCount++;

    // Subscription expired — remove it
    if (e.statusCode === 410 || e.statusCode === 404) {
      await supabase.from('agenda_push_subscriptions').delete().eq('player_id', playerId);
      return false;
    }

    // Transient error — retry up to 2 times
    if (attempt < 2 && (e.statusCode >= 500 || !e.statusCode)) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      return sendPush(playerId, title, body, attempt + 1);
    }

    return false;
  }
}

// ── Smart polling loop ──────────────────────────────────────────────────
async function pollAndFire() {
  try {
    const now = Date.now();

    // Get due notifications
    const { data: due, error } = await supabase
      .from('agenda_scheduled_notifications')
      .select('*')
      .eq('fired', false)
      .lte('fire_at', now)
      .order('fire_at', { ascending: true })
      .limit(50);

    if (error) { console.error('Poll error:', error.message); return scheduleNext(10000); }

    for (const n of due) {
      console.log(`Firing: "${n.title}" for ${n.player_id}`);
      const ok = await sendPush(n.player_id, n.title, n.body);
      await supabase
        .from('agenda_scheduled_notifications')
        .update({ fired: true, sent_ok: ok, retries: n.retries + (ok ? 0 : 1) })
        .eq('id', n.id);
    }

    // Cleanup: delete fired notifications older than 2 days
    if (due.length > 0) {
      await supabase
        .from('agenda_scheduled_notifications')
        .delete()
        .eq('fired', true)
        .lt('fire_at', now - 172800000);
    }

    // Calculate time until next notification
    const { data: nextRow } = await supabase
      .from('agenda_scheduled_notifications')
      .select('fire_at')
      .eq('fired', false)
      .order('fire_at', { ascending: true })
      .limit(1)
      .single();

    if (nextRow) {
      const delay = Math.max(1000, nextRow.fire_at - Date.now());
      // Cap at 30s so new schedules are picked up reasonably fast
      scheduleNext(Math.min(delay, 30000));
    } else {
      // Nothing pending — check again in 30s
      scheduleNext(30000);
    }
  } catch (e) {
    console.error('Poll exception:', e.message);
    scheduleNext(10000);
  }
}

function scheduleNext(ms) {
  setTimeout(pollAndFire, ms);
}

// Start polling
pollAndFire();

// ── API ─────────────────────────────────────────────────────────────────

// Return VAPID public key (no auth needed)
app.get('/api/vapid-public', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC });
});

// Save push subscription from browser
// Client sends { playerId, subscription } — playerId is a UUID stored in localStorage
app.post('/api/subscribe', async (req, res) => {
  const { playerId, subscription } = req.body;
  if (!playerId || !subscription || !subscription.endpoint)
    return res.status(400).json({ error: 'Missing playerId or invalid subscription' });

  const { error } = await supabase
    .from('agenda_push_subscriptions')
    .upsert({ player_id: playerId, subscription, updated_at: new Date().toISOString() },
             { onConflict: 'player_id' });

  if (error) return res.status(500).json({ error: error.message });
  console.log(`Subscription: ${playerId}`);
  res.json({ ok: true, playerId });
});

// Schedule a notification
app.post('/api/schedule', async (req, res) => {
  const { playerId, title, body, fireAt, eventId, remIndex } = req.body;
  if (!playerId || !title || !fireAt)
    return res.status(400).json({ error: 'Missing: playerId, title, fireAt' });

  const fireMs = new Date(fireAt).getTime();
  if (isNaN(fireMs)) return res.status(400).json({ error: 'Invalid fireAt' });

  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

  // Deduplicate: remove existing with same eventId + remIndex
  if (eventId != null && remIndex != null) {
    await supabase
      .from('agenda_scheduled_notifications')
      .delete()
      .eq('event_id', eventId)
      .eq('rem_index', remIndex);
  }

  const { error } = await supabase
    .from('agenda_scheduled_notifications')
    .insert({
      id, player_id: playerId, title, body,
      fire_at: fireMs, event_id: eventId || null,
      rem_index: remIndex ?? null, fired: false, created_at: Date.now()
    });

  if (error) return res.status(500).json({ error: error.message });
  console.log(`Scheduled: "${title}" at ${new Date(fireMs).toISOString()}`);
  res.json({ ok: true, id, fireAt: new Date(fireMs).toISOString() });
});

// Cancel all notifications for an event
app.delete('/api/cancel/:eventId', async (req, res) => {
  const { data, error } = await supabase
    .from('agenda_scheduled_notifications')
    .delete()
    .eq('event_id', req.params.eventId)
    .select('id');

  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, removed: data.length });
});

// Send a test push immediately
app.post('/api/test', async (req, res) => {
  const { playerId } = req.body;
  if (!playerId) return res.status(400).json({ error: 'Missing playerId' });

  const { data } = await supabase
    .from('agenda_push_subscriptions')
    .select('player_id')
    .eq('player_id', playerId)
    .single();

  if (!data) return res.status(404).json({ error: 'Player ID not found. Re-activate notifications.' });
  const ok = await sendPush(playerId, 'Mi Agenda', 'Las notificaciones funcionan correctamente');
  res.json({ ok });
});

// Health check (no auth needed)
app.get('/api/health', async (req, res) => {
  const now = Date.now();

  const [subsResult, pendingResult, totalResult, nextResult] = await Promise.all([
    supabase.from('agenda_push_subscriptions').select('player_id', { count: 'exact', head: true }),
    supabase.from('agenda_scheduled_notifications').select('id', { count: 'exact', head: true }).eq('fired', false).gt('fire_at', 0),
    supabase.from('agenda_scheduled_notifications').select('id', { count: 'exact', head: true }),
    supabase.from('agenda_scheduled_notifications').select('fire_at, title').eq('fired', false).order('fire_at', { ascending: true }).limit(1).single()
  ]);

  res.json({
    ok: true,
    uptime: Math.floor((now - startedAt) / 1000),
    subscribers: subsResult.count || 0,
    pending: pendingResult.count || 0,
    total: totalResult.count || 0,
    nextFire: nextResult.data ? new Date(nextResult.data.fire_at).toISOString() : null,
    nextTitle: nextResult.data ? nextResult.data.title : null,
    pushesSent: pushCount,
    lastPushAt: lastPushAt ? new Date(lastPushAt).toISOString() : null,
    errors: errorCount
  });
});

// Status for a specific player
app.get('/api/status/:playerId', async (req, res) => {
  const pid = req.params.playerId;

  const [subResult, pendingResult] = await Promise.all([
    supabase.from('agenda_push_subscriptions').select('player_id').eq('player_id', pid).single(),
    supabase.from('agenda_scheduled_notifications').select('*').eq('player_id', pid).eq('fired', false).order('fire_at', { ascending: true })
  ]);

  res.json({
    ok: true,
    subscribed: !!subResult.data,
    pending: pendingResult.data ? pendingResult.data.length : 0,
    next: pendingResult.data?.[0] || null
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Mi Agenda notif server on port ${PORT}`);
});

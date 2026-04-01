const express  = require('express');
const cors     = require('cors');
const webpush  = require('web-push');
const fs       = require('fs');
const path     = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// ── VAPID keys (generated once, fixed) ───────────────────────────────────
const VAPID_PUBLIC  = 'BAa__naKLX3Rox0_TuewP-4IcWBgfB5FoU7H2OK1jNeKeV1sVAgiAn2zDYRkup1-xJxfcVEraGeYLzaERyMOP-E';
const VAPID_PRIVATE = 'zEhM5SEc-wFnV6w2W6ornWSjWbsWEJHJzwJz9_h05JE';

webpush.setVapidDetails('mailto:ediciones.c@gmail.com', VAPID_PUBLIC, VAPID_PRIVATE);

// ── Persistent storage ───────────────────────────────────────────────────
const SUBS_FILE   = path.join(__dirname, 'subscriptions.json');
const NOTIFS_FILE = path.join(__dirname, 'notifs.json');

let subscriptions = {};  // { playerId: subscriptionObject }
let scheduled     = [];  // array of notification jobs

function loadData() {
  try { if(fs.existsSync(SUBS_FILE))   subscriptions = JSON.parse(fs.readFileSync(SUBS_FILE,'utf8')); } catch(e){}
  try { if(fs.existsSync(NOTIFS_FILE)) scheduled     = JSON.parse(fs.readFileSync(NOTIFS_FILE,'utf8')); } catch(e){}
}
function saveSubs()   { try{ fs.writeFileSync(SUBS_FILE, JSON.stringify(subscriptions,null,2)); }catch(e){} }
function saveNotifs() { try{ fs.writeFileSync(NOTIFS_FILE, JSON.stringify(scheduled,null,2)); }catch(e){} }

loadData();

// ── Send a push notification ─────────────────────────────────────────────
async function sendPush(playerId, title, body) {
  const sub = subscriptions[playerId];
  if(!sub) { console.warn('No subscription for player:', playerId); return false; }
  try {
    await webpush.sendNotification(sub, JSON.stringify({ title, body }));
    console.log(`✅ Sent to ${playerId}: ${title}`);
    return true;
  } catch(e) {
    console.error(`❌ Push failed for ${playerId}:`, e.statusCode, e.body);
    // If subscription expired/invalid, remove it
    if(e.statusCode === 410 || e.statusCode === 404) {
      delete subscriptions[playerId];
      saveSubs();
    }
    return false;
  }
}

// ── Polling loop every 20 seconds ────────────────────────────────────────
setInterval(async () => {
  const now = Date.now();
  const due = scheduled.filter(n => !n.fired && n.fireAt <= now);
  for(const n of due) {
    console.log(`⏰ Firing: "${n.title}" for ${n.playerId}`);
    const ok = await sendPush(n.playerId, n.title, n.body);
    n.fired = true;
    n.sentOk = ok;
  }
  if(due.length > 0) {
    // Cleanup fired notifications older than 2 days
    scheduled = scheduled.filter(n => !n.fired || (now - n.fireAt) < 172800000);
    saveNotifs();
  }
}, 20000);

// ── API ──────────────────────────────────────────────────────────────────

// Return VAPID public key so the client can subscribe
app.get('/api/vapid-public', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC });
});

// Save push subscription from browser
app.post('/api/subscribe', (req, res) => {
  const { subscription } = req.body;
  if(!subscription || !subscription.endpoint)
    return res.status(400).json({ error: 'Invalid subscription' });
  // Use endpoint as stable player ID
  const playerId = Buffer.from(subscription.endpoint).toString('base64').slice(-32);
  subscriptions[playerId] = subscription;
  saveSubs();
  console.log(`📱 New subscription: ${playerId}`);
  res.json({ ok: true, playerId });
});

// Schedule a notification
app.post('/api/schedule', (req, res) => {
  const { playerId, title, body, fireAt, eventId, remIndex } = req.body;
  if(!playerId || !title || !fireAt)
    return res.status(400).json({ error: 'Missing: playerId, title, fireAt' });
  const fireMs = new Date(fireAt).getTime();
  if(isNaN(fireMs)) return res.status(400).json({ error: 'Invalid fireAt' });
  // Deduplicate
  scheduled = scheduled.filter(n => !(n.eventId === eventId && n.remIndex === remIndex));
  const notif = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2,5),
    playerId, title, body,
    fireAt: fireMs, eventId: eventId||null,
    remIndex: remIndex??null, fired: false, createdAt: Date.now()
  };
  scheduled.push(notif);
  saveNotifs();
  console.log(`📅 Scheduled: "${title}" at ${new Date(fireMs).toLocaleString()}`);
  res.json({ ok: true, id: notif.id, fireAt: new Date(fireMs).toISOString() });
});

// Cancel all notifications for an event
app.delete('/api/cancel/:eventId', (req, res) => {
  const before = scheduled.length;
  scheduled = scheduled.filter(n => n.eventId !== req.params.eventId);
  saveNotifs();
  res.json({ ok: true, removed: before - scheduled.length });
});

// Send a test push immediately
app.post('/api/test', async (req, res) => {
  const { playerId } = req.body;
  if(!playerId) return res.status(400).json({ error: 'Missing playerId' });
  if(!subscriptions[playerId]) return res.status(404).json({ error: 'Player ID not found in server. Re-activate notifications.' });
  const ok = await sendPush(playerId, '🔔 Mi Agenda', 'Las notificaciones funcionan correctamente');
  res.json({ ok });
});

// Health check
app.get('/api/health', (req, res) => {
  const now = Date.now();
  const pending = scheduled.filter(n => !n.fired && n.fireAt > now);
  const next    = [...pending].sort((a,b) => a.fireAt - b.fireAt)[0];
  res.json({
    ok: true,
    subscribers: Object.keys(subscriptions).length,
    pending: pending.length,
    total: scheduled.length,
    nextFire:  next ? new Date(next.fireAt).toISOString() : null,
    nextTitle: next ? next.title : null
  });
});

// Status for a specific player
app.get('/api/status/:playerId', (req, res) => {
  const now     = Date.now();
  const mine    = scheduled.filter(n => n.playerId === req.params.playerId);
  const pending = mine.filter(n => !n.fired && n.fireAt > now);
  res.json({
    ok: true,
    subscribed: !!subscriptions[req.params.playerId],
    pending: pending.length,
    next: [...pending].sort((a,b)=>a.fireAt-b.fireAt)[0] || null
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Mi Agenda notif server on port ${PORT}`);
  console.log(`   Subscribers: ${Object.keys(subscriptions).length}`);
  console.log(`   Scheduled:   ${scheduled.length}`);
});

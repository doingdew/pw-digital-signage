// Slack integration via Socket Mode.
//
// The server holds an outbound WebSocket to Slack — no inbound port needed.
// When a message lands in the configured channel, we insert it into the
// messages table and broadcast it over our own WebSocket hub to every
// connected TV. The 30-min expiry is handled by the existing signage code
// (it filters out messages older than 30 minutes during rendering).
//
// Settings live in `settings` table keyed by 'slack' as JSON:
//   { botToken: 'xoxb-…', appToken: 'xapp-…', channelId: 'C0123…' }
//
// The connection is teardown-safe: setSlackConfig() can be called at runtime
// from the admin panel and we'll reconnect with the new credentials.

const { db, getSetting } = require('./db');
const wsHub = require('./ws');

let SocketModeClient = null;
let WebClient = null;
try {
  SocketModeClient = require('@slack/socket-mode').SocketModeClient;
  WebClient = require('@slack/web-api').WebClient;
} catch (e) {
  // Packages not installed — Slack feature simply unavailable until npm install.
  console.warn('Slack packages not installed, integration disabled. Run: npm install');
}

let socket = null;
let web = null;
let connectedAs = null;            // bot user id once authed
let lastError = null;
let lastMessageAt = 0;
let eventsReceived = 0;            // total slack_event count since boot
let messagesReceived = 0;          // total chat messages from configured channel
const userCache = new Map();       // user_id -> display name

const insertMessage = db.prepare(`
  INSERT INTO messages (screen_id, sender, body, priority)
  VALUES (NULL, ?, ?, 'normal')
`);
const allScreens = db.prepare('SELECT slug FROM screens');

async function start() {
  await stop();   // ensure clean slate
  if (!SocketModeClient || !WebClient) return;

  const cfg = getSetting('slack');
  if (!cfg || !cfg.botToken || !cfg.appToken || !cfg.channelId) {
    return;   // not configured
  }

  try {
    web = new WebClient(cfg.botToken);
    socket = new SocketModeClient({ appToken: cfg.appToken });

    // Auth check + cache bot user id (so we can ignore our own messages).
    const auth = await web.auth.test();
    connectedAs = auth.user_id;
    console.log(`[slack] connected as @${auth.user || auth.bot_id} in workspace ${auth.team}`);

    // Primary handler — fires for chat messages from the events API.
    socket.on('message', async ({ event, ack }) => {
      try { await ack(); } catch (_) {}
      console.log(`[slack] event 'message' received: channel=${event?.channel} subtype=${event?.subtype || '-'} user=${event?.user || event?.bot_id || '-'} text=${(event?.text || '').slice(0, 40)}`);
      await handleMessage(event, cfg);
    });

    // Diagnostic — log ALL slack events flowing in so we can see why messages
    // aren't being delivered if the primary handler isn't firing.
    socket.on('slack_event', (env) => {
      eventsReceived++;
      const innerType = env?.body?.event?.type || env?.type;
      console.log(`[slack] generic slack_event #${eventsReceived}: outerType=${env?.type} innerType=${innerType}`);
    });

    socket.on('disconnect', () => console.log('[slack] disconnected'));
    socket.on('connected', () => console.log('[slack] websocket connected'));
    socket.on('error', (e) => { lastError = String(e?.message || e); console.warn('[slack] error:', lastError); });
    socket.on('unable_to_socket_mode_start', (e) => {
      lastError = `Couldn't start Socket Mode: ${e?.message || e}`;
      console.warn('[slack]', lastError);
    });

    await socket.start();
    lastError = null;
  } catch (e) {
    lastError = e.message || String(e);
    console.warn('[slack] start failed:', lastError);
    await stop();
  }
}

async function stop() {
  if (socket) {
    try { await socket.disconnect(); } catch (_) {}
    socket = null;
  }
  web = null;
  connectedAs = null;
}

async function handleMessage(event, cfg) {
  if (!event || !event.channel) return;
  if (event.channel !== cfg.channelId) {
    console.log(`[slack] message in wrong channel: got=${event.channel} configured=${cfg.channelId}`);
    return;
  }
  // Drop only specific subtypes we don't want — joins/leaves, edits, deletes.
  // Plain messages have no subtype; we want those, plus 'me_message',
  // 'thread_broadcast' (thread reply also posted to channel), 'file_share'.
  const SKIP_SUBTYPES = new Set([
    'channel_join', 'channel_leave', 'message_changed', 'message_deleted',
    'channel_topic', 'channel_purpose', 'channel_name', 'channel_archive',
    'channel_unarchive', 'pinned_item', 'unpinned_item',
  ]);
  if (event.subtype && SKIP_SUBTYPES.has(event.subtype)) {
    console.log(`[slack] skipping subtype: ${event.subtype}`);
    return;
  }
  if (event.user === connectedAs) {
    console.log(`[slack] skipping own message`);
    return;
  }
  // Skip thread replies (but keep thread_broadcast since those re-post to channel).
  if (event.thread_ts && event.thread_ts !== event.ts && event.subtype !== 'thread_broadcast') {
    console.log(`[slack] skipping thread reply`);
    return;
  }
  const text = (event.text || '').trim();
  if (!text) {
    console.log(`[slack] skipping empty message (subtype=${event.subtype || '-'})`);
    return;
  }

  // Resolve sender display name (cached so we don't spam users.info).
  let sender = 'Slack';
  if (event.user) {
    sender = await getUserName(event.user);
  } else if (event.bot_profile?.name) {
    sender = event.bot_profile.name;
  }

  // Slack-flavored markup → plain text. Strip <@U…> mentions, <#C…|name> channels,
  // and <http://url|label> links to just the label, decode &amp; / &lt; / &gt;.
  const clean = text
    .replace(/<@([A-Z0-9]+)>/g, '@user')
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');

  const info = insertMessage.run(sender, clean);
  const message = {
    id: info.lastInsertRowid,
    sender,
    body: clean,
    priority: 'normal',
    timestamp: Date.now(),
  };
  // Push out to every screen — same payload shape the admin /api/messages route uses.
  let pushed = 0;
  for (const s of allScreens.all()) {
    wsHub.broadcast(s.slug, { type: 'MESSAGE', message });
    pushed++;
  }
  lastMessageAt = Date.now();
  messagesReceived++;
  console.log(`[slack] ✓ broadcast "${clean.slice(0,40)}" from ${sender} to ${pushed} screens`);
}

async function getUserName(userId) {
  if (userCache.has(userId)) return userCache.get(userId);
  try {
    const r = await web.users.info({ user: userId });
    const name = r.user?.profile?.display_name || r.user?.real_name || r.user?.name || 'Slack';
    userCache.set(userId, name);
    return name;
  } catch (_) {
    userCache.set(userId, 'Slack');
    return 'Slack';
  }
}

async function testConnection({ botToken, appToken, channelId }) {
  if (!WebClient) throw new Error('Slack packages not installed');
  if (!botToken || !appToken || !channelId) throw new Error('Need botToken, appToken, channelId');
  const w = new WebClient(botToken);
  const auth = await w.auth.test();
  // Confirm the bot can see the channel. conversations.info works for both
  // public and private channels — the bot needs channels:read for #public
  // and groups:read for private channels.
  let channel;
  try {
    channel = await w.conversations.info({ channel: channelId });
  } catch (e) {
    const errCode = e.data?.error || e.message;
    if (errCode === 'not_in_channel') {
      throw new Error('The bot is not a member of that channel. In Slack, type: /invite @' + (auth.user || 'YourBot'));
    }
    if (errCode === 'channel_not_found') {
      throw new Error('Channel ID not found. Right-click the channel in Slack → View channel details → copy the ID at the bottom.');
    }
    if (errCode === 'missing_scope') {
      const needed = e.data?.needed || 'channels:read or groups:read';
      throw new Error(
        `Bot is missing the "${needed}" scope. ` +
        `In api.slack.com/apps → your app → OAuth & Permissions, add these Bot Token Scopes: ` +
        `channels:read, channels:history, groups:read, groups:history, users:read, chat:write. ` +
        `Then click "Reinstall to Workspace" at the top of the page.`
      );
    }
    throw new Error(`Channel lookup failed: ${errCode}`);
  }
  return {
    workspace: auth.team || '',
    botUser: auth.user || '',
    channelName: channel.channel?.name || '',
    channelType: channel.channel?.is_private ? 'private' : 'public',
  };
}

function status() {
  const cfg = getSetting('slack') || {};
  return {
    configured: !!(cfg.botToken && cfg.appToken && cfg.channelId),
    connected: !!socket,
    connectedAs,
    lastMessageAt: lastMessageAt || null,
    eventsReceived,
    messagesReceived,
    lastError,
  };
}

module.exports = { start, stop, testConnection, status };

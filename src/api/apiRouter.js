const express = require('express');
const crypto = require('crypto');
const { createScrimReminderJob } = require('../jobs/scrimReminders');
const { createYouTubeStats } = require('../lib/youtube');
const webpush = require('../lib/webpush');
const router = express.Router();

// Plain `!==` leaks timing information (an attacker can narrow down the
// key byte-by-byte from response latency) and -- separately -- if
// BOT_API_KEY is ever unset, `undefined !== undefined` is false, so a
// request with NO Authorization header at all would pass. Requiring
// both to be non-empty strings before the constant-time compare closes
// both gaps.
function safeKeysMatch(a, b) {
    if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
    const bufA = Buffer.from(a);
    const bufB = Buffer.from(b);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

// Razorpay/RazorpayX webhook verification -- a third auth model
// alongside requireApiKey/requireUserToken below, needed because
// Razorpay's own servers call these endpoints directly (no shared bot
// key, no user session to forward). Verifies an HMAC-SHA256 signature
// computed over the RAW request body against a per-webhook secret --
// reuses safeKeysMatch so this gets the same constant-time-compare
// protection as the shared-key model. req.rawBody is populated by the
// express.json({verify}) callback in index.js; if that's ever missing
// (e.g. a body-less request), this fails closed rather than skipping
// the check.
function verifyRazorpaySignature(getSecret) {
    return (req, res, next) => {
        const secret = getSecret();
        if (!secret) {
            return res.status(500).json({ error: 'Payments are not configured on the bot yet.' });
        }
        const signature = req.headers['x-razorpay-signature'];
        if (!signature || !req.rawBody) {
            return res.status(400).json({ error: 'Missing signature or body.' });
        }
        const expected = crypto.createHmac('sha256', secret).update(req.rawBody).digest('hex');
        if (!safeKeysMatch(signature, expected)) {
            return res.status(401).json({ error: 'Invalid webhook signature.' });
        }
        next();
    };
}

// Verifies API key -- applied only to routes that mutate something or
// touch a user's DMs. /verify-membership is read-only (checks guild
// membership, changes nothing) and deliberately skips this, since it's
// called directly from the browser during registration and a secret
// key can't be safely embedded in client-side JS.
function requireApiKey(req, res, next) {
    const API_KEY = process.env.BOT_API_KEY;
    const providedKey = req.headers['authorization'] || req.headers['x-api-key'];

    if (!safeKeysMatch(providedKey, API_KEY)) {
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }
    next();
}

// One API key is shared across the whole platform with no per-caller
// scoping at all -- a single global fixed-window cap means a leaked key
// can't be used to mass-DM an unbounded number of people. Deliberately
// NOT keyed by req.ip: Render sits behind a proxy, and without a
// confirmed `trust proxy` setup, req.ip either reflects the proxy (every
// caller sharing one bucket anyway) or trusts a spoofable
// X-Forwarded-For header -- a single shared bucket sidesteps that
// entirely and still matches this platform's actual usage pattern (one
// admin panel, occasional deliberate sends, not high-frequency). In-memory
// (no new dependency) -- resets on restart.
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX_REQUESTS = 20;
const rateLimitBuckets = new Map();

function rateLimitNotify(req, res, next) {
    const key = 'global';
    const now = Date.now();
    const bucket = rateLimitBuckets.get(key);
    if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
        rateLimitBuckets.set(key, { windowStart: now, count: 1 });
        return next();
    }
    if (bucket.count >= RATE_LIMIT_MAX_REQUESTS) {
        return res.status(429).json({ error: 'Too many notification requests -- please slow down.' });
    }
    bucket.count++;
    next();
}

// Public read-only endpoints (currently just the YouTube badge) get
// their own, looser bucket. They send no DMs and touch no user data, so
// the 20/min ceiling meant for notifications would throttle ordinary
// page views -- but they are unauthenticated, so they cannot be
// unlimited either. The real quota protection is the daily lookup budget
// inside youtube.js; this only keeps one client from monopolising the
// process.
// Ceilings on one round trigger. A bracket round cannot legitimately be
// larger than this, and together they bound what a single organizer
// click can set in motion -- against a mistake as much as against a
// tampered request.
const MAX_ROUND_MATCHES = 32;
const MAX_ROUND_RECIPIENTS = 400;

const PUBLIC_RATE_LIMIT_MAX = 240;
const publicRateBucket = { windowStart: 0, count: 0 };

function rateLimitPublic(req, res, next) {
    const now = Date.now();
    if (now - publicRateBucket.windowStart > RATE_LIMIT_WINDOW_MS) {
        publicRateBucket.windowStart = now;
        publicRateBucket.count = 1;
        return next();
    }
    if (publicRateBucket.count >= PUBLIC_RATE_LIMIT_MAX) {
        return res.status(429).json({ error: 'Too many requests -- please slow down.' });
    }
    publicRateBucket.count++;
    next();
}

// One instance for the process, so the six-hour cache and the daily
// budget are shared across every request rather than per-router.
// YOUTUBE_API_KEY: never log it, never echo it in a response -- same rule
// as BOT_API_KEY above. It is read once, here, and only ever appended to
// a googleapis.com URL inside youtube.js.
const youtubeStats = createYouTubeStats({
    apiKey: process.env.YOUTUBE_API_KEY,
    fetchJson: async (url) => {
        const r = await fetch(url);
        if (!r.ok) throw new Error('YouTube API returned ' + r.status);
        return r.json();
    },
    log: console.log
});

// ---------------------------------------------------------------
// Session-token auth (the newer model -- see /tournament-broadcast and
// /tournament-notify-match below).
//
// Instead of a shared bot key, these endpoints take the CALLER'S OWN
// Supabase access token and forward it to an authorization RPC.
// PostgREST derives request.jwt.claims from the bearer header no matter
// which host sent the request, so discord_id() inside that RPC resolves
// to the real organizer -- and every permission decision stays in SQL
// next to all the other permission logic, rather than being
// reimplemented here. No service-role key is involved.
// ---------------------------------------------------------------
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

// One POST to PostgREST. Deliberately not @supabase/supabase-js: this is
// a separately-deployed repo and that would be a whole dependency for a
// single HTTP call. Node 18+ (Render's default) has global fetch.
async function callRpc(fnName, args, bearer) {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${bearer}`
        },
        body: JSON.stringify(args)
    });
    if (!res.ok) return null;   // expired/invalid token, or the RPC errored
    return res.json();
}

// Only used by /scrim-reminders-tick, which has no signed-in caller to
// forward a session for (it's woken up by a scheduled GitHub Actions
// workflow, not a browser). A service-role key bypasses RLS/grants
// entirely -- this is the FIRST time this bot talks to Supabase as
// itself rather than relaying an already-authenticated user's own
// session, so treat SUPABASE_SERVICE_ROLE_KEY with the same care as
// BOT_API_KEY: never log it, never echo it in a response.
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Callers treat a null return as "couldn't complete the request" and
// respond with a clean 500 -- so every failure mode here, including a
// missing/invalid SUPABASE_URL, must resolve to null rather than throw.
// An async Express route handler doesn't catch a rejected promise on
// its own; letting one escape becomes an unhandled rejection that
// crashes the whole process (Discord connection included), not just
// the one request -- which is exactly what took this bot down.
async function callRpcAsService(fnName, args) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        console.error(`[API] callRpcAsService(${fnName}): missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY`);
        return null;
    }
    try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fnName}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey: SUPABASE_SERVICE_ROLE_KEY,
                Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`
            },
            body: JSON.stringify(args)
        });
        if (!res.ok) return null;
        return res.json();
    } catch (err) {
        console.error(`[API] callRpcAsService(${fnName}) failed:`, err.message);
        return null;
    }
}

// ---------------------------------------------------------------
// Razorpay -- raw fetch, same reasoning as callRpc above (Node 18+ has
// global fetch; the official `razorpay` SDK would be a whole dependency
// for what's a handful of straightforward REST calls). RAZORPAY_KEY_ID
// is not secret (it's also in settings.razorpayKeyId for Checkout.js);
// RAZORPAY_KEY_SECRET and RAZORPAY_WEBHOOK_SECRET never leave this
// process -- never logged, never echoed in a response, same discipline
// as BOT_API_KEY/SUPABASE_SERVICE_ROLE_KEY above.
// ---------------------------------------------------------------
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

function razorpayConfigured() {
    return !!(RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET);
}

// Returns null on any failure (network, non-2xx, malformed JSON) --
// callers treat null as "couldn't reach Razorpay" and respond with a
// clean 502, same discipline callRpcAsService uses for a missing
// Supabase config.
async function razorpayFetch(path, options = {}) {
    try {
        const auth = Buffer.from(`${RAZORPAY_KEY_ID}:${RAZORPAY_KEY_SECRET}`).toString('base64');
        const res = await fetch(`https://api.razorpay.com/v1${path}`, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Basic ${auth}`,
                ...(options.headers || {})
            }
        });
        if (!res.ok) {
            const body = await res.text().catch(() => '');
            console.error(`[Razorpay] ${path} -> ${res.status}: ${body.slice(0, 300)}`);
            return null;
        }
        return res.json();
    } catch (err) {
        console.error(`[Razorpay] ${path} failed:`, err.message);
        return null;
    }
}

// NEVER log req.userToken and never echo it in an error response -- it
// grants everything that signed-in user can do until it expires.
function requireUserToken(req, res, next) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        return res.status(500).json({ error: 'Bot is missing its Supabase configuration.' });
    }
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) {
        return res.status(401).json({ error: 'Missing session token -- please sign in again.' });
    }
    req.userToken = token;
    next();
}

// Per-caller bucket nested INSIDE the global one above. That global cap
// was sized for "one admin, occasional deliberate sends"; these endpoints
// are reachable by every organizer, and one of them broadcasting to a
// 64-team roster must not be able to starve the whole platform. Hashed so
// the raw token never becomes a Map key we might later dump while
// debugging.
const PER_TOKEN_MAX_REQUESTS = 5;
const perTokenBuckets = new Map();

function rateLimitPerToken(req, res, next) {
    const key = crypto.createHash('sha256').update(req.userToken).digest('hex');
    const now = Date.now();
    const bucket = perTokenBuckets.get(key);
    if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
        perTokenBuckets.set(key, { windowStart: now, count: 1 });
        return next();
    }
    if (bucket.count >= PER_TOKEN_MAX_REQUESTS) {
        return res.status(429).json({ error: 'Too many Discord sends -- wait a minute and try again.' });
    }
    bucket.count++;
    next();
}

// Verification has its own bucket rather than reusing rateLimitPerToken:
// that one is sized for Discord sends and says so in its 429, and
// retrying IS the normal path here -- you paste the code, save the
// description, check, find you saved the wrong channel, fix it, check
// again. A cap that punishes the ordinary correction loop would read as
// the feature being broken.
const VERIFY_MAX_REQUESTS = 8;
const verifyBuckets = new Map();

function rateLimitVerify(req, res, next) {
    const key = crypto.createHash('sha256').update(req.userToken).digest('hex');
    const now = Date.now();
    const bucket = verifyBuckets.get(key);
    if (!bucket || now - bucket.windowStart > RATE_LIMIT_WINDOW_MS) {
        verifyBuckets.set(key, { windowStart: now, count: 1 });
        return next();
    }
    if (bucket.count >= VERIFY_MAX_REQUESTS) {
        return res.status(429).json({ ok: false, reason: 'rate-limit',
            error: 'That is a lot of checks in a row -- wait a minute and try again.' });
    }
    bucket.count++;
    next();
}

// Resolve the guild behind an invite link. Split out of
// resolveGuildMember() so a batch send can do this ONCE rather than
// re-fetching the same invite for every player on the roster.
async function resolveGuild(client, inviteLink) {
    const invite = await client.fetchInvite(inviteLink).catch(() => null);
    if (!invite || !invite.guild) {
        return { error: 'Invalid or expired invite link', status: 400 };
    }
    const guild = await client.guilds.fetch(invite.guild.id).catch(() => null);
    if (!guild) {
        return { error: 'Bot is not in that server. The organizer MUST invite the bot to their server first.', status: 403 };
    }
    return { guild };
}

async function findMemberInGuild(guild, username) {
    const searchResults = await guild.members.fetch({ query: username, limit: 10 }).catch(() => null);
    if (!searchResults || searchResults.size === 0) return null;
    return searchResults.find(m =>
        m.user.username.toLowerCase() === username.toLowerCase() ||
        (m.user.globalName && m.user.globalName.toLowerCase() === username.toLowerCase())
    ) || null;
}

// Shared by /verify-membership and /notify-by-username: resolves a guild
// member by username within the server behind a given invite link.
async function resolveGuildMember(client, inviteLink, username) {
    const resolved = await resolveGuild(client, inviteLink);
    if (resolved.error) return resolved;
    const member = await findMemberInGuild(resolved.guild, username);
    return { guild: resolved.guild, member };
}

// Shared by /notify, /scrim-notify, and /scrim-reminders-tick -- every
// place in this file that DMs one Discord user by numeric id. Returns a
// plain result object instead of writing to `res` directly, since each
// caller needs a different HTTP response shape wrapped around the same
// core action (a single DM vs. a per-recipient loop).
async function dmUserById(client, userId, message) {
    try {
        const user = await client.users.fetch(userId).catch(() => null);
        if (!user) return { ok: false, status: 404, error: 'User not found on Discord' };
        await user.send(message);
        return { ok: true };
    } catch (error) {
        console.error(`[API Error] Failed to send DM to ${userId}:`, error.message);
        if (error.code === 50007) {
            return { ok: false, status: 403, error: 'Cannot send messages to this user (DMs disabled or blocked)' };
        }
        return { ok: false, status: 500, error: 'Internal Server Error' };
    }
}

// Pass the Discord client to the router so endpoints can use it
module.exports = (client) => {

    // --- 0. YouTube subscriber badge (public, read-only) ---
    //
    // Registered BEFORE the gateway-readiness gate below on purpose. This
    // endpoint never touches Discord, and a tournament page's badge
    // should not disappear for the two minutes a Render restart takes to
    // reconnect the bot.
    //
    // Unauthenticated because the number it returns is public on the
    // channel's own page; requiring a session would only hide it from the
    // logged-out spectators the badge is for. Nothing here reads or
    // writes platform data, so there is no authorization decision to make.
    // --- Web Push: the application server key ---
    // Unauthenticated, and that is correct rather than an oversight: a
    // VAPID PUBLIC key is public by construction. Every browser that
    // subscribes receives it, and it is useless without the private half,
    // which never leaves this process. Served from here rather than baked
    // into the site so rotating the pair does not need a site deploy.
    router.get('/push-public-key', rateLimitPublic, (req, res) => {
        const key = webpush.publicKey();
        if (!key) return res.status(503).json({ ok: false, reason: 'not-configured' });
        res.json({ ok: true, key: key });
    });

    router.get('/youtube-subs', rateLimitPublic, async (req, res) => {
        const url = typeof req.query.url === 'string' ? req.query.url : '';
        if (!url) return res.status(400).json({ error: 'Missing url' });
        // A URL is an unbounded string from an anonymous caller; the
        // parser rejects anything that is not a YouTube channel link, but
        // there is no reason to hand it a megabyte first.
        if (url.length > 300) return res.status(400).json({ ok: false, reason: 'unsupported-url' });

        const result = await youtubeStats.subscribersFor(url);
        // Always 200: every outcome here is a legitimate answer about a
        // decoration, and a 4xx/5xx would show up in the browser console
        // of a page that is working perfectly.
        //
        // Cached at the edge for an hour. The six-hour server cache stops
        // us calling YouTube; this stops the browser calling US on every
        // navigation within a session.
        res.set('Cache-Control', 'public, max-age=3600');
        return res.status(200).json(result);
    });

    // Channel OWNERSHIP. /youtube-subs above says how big a channel is;
    // it cannot say who runs it, and that is the question an organizer
    // application actually asks.
    //
    // WHY THIS RUNS HERE AND NOT IN THE BROWSER. The page could call
    // YouTube itself -- the data is public -- but then the answer that
    // decides an organizer role would be a claim typed by the applicant's
    // own client, and a tampered page can claim anything. So both facts
    // are established on this side: the description is read with OUR api
    // key, the subscriber count comes out of the same response, and the
    // verdict is written with the service-role key through an RPC the
    // browser is not granted execute on. The browser's only power here is
    // to ask for the check to be run.
    //
    // Identity is NOT taken from the request body. The caller's own
    // session token is forwarded to get_my_youtube_challenge(), which
    // resolves discord_id() from the JWT and hands back both the id and
    // the code -- so claiming to be somebody else would mean holding
    // their session, which is the same bar as logging in as them.
    //
    // Registered before the Discord-readiness gate for the same reason
    // the badge endpoint is: nothing here touches Discord, and a restart
    // should not make verification fail for two minutes.
    router.post('/youtube-verify', requireUserToken, rateLimitVerify, async (req, res) => {
        const url = typeof req.body.url === 'string' ? req.body.url.trim() : '';
        if (!url) return res.status(400).json({ ok: false, reason: 'missing-url' });
        if (url.length > 300) return res.status(400).json({ ok: false, reason: 'unsupported-url' });

        const challenge = await callRpc('get_my_youtube_challenge', {}, req.userToken);
        if (!challenge || !challenge.code || !challenge.discordId) {
            return res.status(401).json({ ok: false, reason: 'session',
                error: 'Your session could not be verified -- please sign in again.' });
        }

        const found = await youtubeStats.verifyOwnership(url, challenge.code);
        if (!found.ok) {
            // 200 with a reason, not a 4xx: every one of these is a
            // legitimate answer about a channel, and the page shows each
            // one differently. A 4xx here would also be indistinguishable
            // from the auth failure above.
            return res.status(200).json({ ok: false, reason: found.reason });
        }

        // Ownership is proven. The write -- including whether this clears
        // the subscriber bar and earns the role -- is the database's
        // decision, made from numbers this process read from YouTube.
        const recorded = await callRpcAsService('record_youtube_verification', {
            p_discord_id: challenge.discordId,
            p_url: url,
            p_channel_id: found.channelId,
            p_subscribers: found.subscribers
        });
        if (!recorded) {
            return res.status(500).json({ ok: false, reason: 'record-failed',
                error: 'Your channel checked out, but we could not save that. Please try again.' });
        }
        if (recorded.success === false) {
            return res.status(200).json({ ok: false, reason: 'rejected', message: recorded.message });
        }

        return res.status(200).json({
            ok: true,
            verified: true,
            granted: !!recorded.granted,
            alreadyElevated: !!recorded.alreadyElevated,
            subscribers: found.subscribers,
            display: found.display,
            hiddenCount: !!found.hiddenCount,
            threshold: recorded.threshold || null,
            channelTitle: found.title
        });
    });

    // Without this, a request arriving while the bot is still connecting
    // to Discord (e.g. right after a Render restart) would reach a route
    // handler, try to use `client` before it's ready, and fail with a
    // confusing "bot not in server" instead of a clear "still starting up".
    router.use((req, res, next) => {
        if (!client.isReady()) {
            return res.status(503).json({ error: 'Bot is still starting up -- try again in a few seconds.' });
        }
        next();
    });

    // Built once per router, with this module's own Supabase and DM
    // helpers injected. index.js builds an identical one for the timer --
    // same code, same guarantees, no HTTP hop between them.
    const scrimReminderJob = createScrimReminderJob({
        callRpc: callRpcAsService,
        dmUser: (userId, text) => dmUserById(client, userId, text),
        gatewayUp: () => { try { return client.isReady(); } catch (e) { return false; } }
    });

    // --- 1. Send DM Notification ---
    router.post('/notify', requireApiKey, rateLimitNotify, async (req, res) => {
        const { userId, message } = req.body;

        if (!userId || !message) {
            return res.status(400).json({ error: 'Missing userId or message in request body' });
        }

        const result = await dmUserById(client, userId, message);
        if (!result.ok) return res.status(result.status).json({ error: result.error });
        console.log(`[API] Sent DM to user ${userId}`);
        return res.status(200).json({ success: true, message: 'Notification sent' });
    });

    // --- 1f. Scrim event DMs (challenge received/accepted/rejected),
    // same session-token model as /tournament-notify-match: the caller's
    // own Supabase session is forwarded to authorize_scrim_dm(), which
    // resolves the correct recipient (the OTHER squad's owner) server-
    // side rather than trusting a userId the client could tamper with.
    router.post('/scrim-notify', requireUserToken, rateLimitNotify, rateLimitPerToken, async (req, res) => {
        const { scrimId, event, message } = req.body; // event: 'challenged' | 'accepted' | 'rejected' | 'reminder'
        if (!scrimId || !event) {
            return res.status(400).json({ error: 'Missing scrimId or event in request body' });
        }

        const auth = await callRpc('authorize_scrim_dm', { p_scrim_id: scrimId }, req.userToken);
        if (!auth) {
            return res.status(401).json({ error: 'Your session could not be verified -- please sign in again.' });
        }
        if (!auth.allowed) {
            return res.status(403).json({ error: auth.message });
        }

        const messages = {
            challenged: 'Your scrim listing just received a new challenge!',
            accepted: 'Your scrim challenge was accepted -- check the lobby for details.',
            rejected: 'Your scrim challenge was declined.',
            reminder: 'Your opponent is nudging you about your upcoming scrim -- check the lobby for details.'
        };
        // 'reminder' is the only event with an editable compose step (the
        // scrim lobby's Notify modal) -- challenged/accepted/rejected fire
        // automatically from other actions with no textarea behind them,
        // so a client-supplied message there would just be trusting
        // unvalidated input for events that should always say exactly
        // what happened. Same length cap as /tournament-notify-match's
        // custom-message path, above, scaled down for a single-recipient nudge.
        const trimmedMessage = typeof message === 'string' ? message.trim() : '';
        const body = (event === 'reminder' && trimmedMessage) ? trimmedMessage.slice(0, 500) : (messages[event] || 'Scrim update.');

        // 'challenged' notifies the CREATOR (someone challenged them);
        // 'accepted'/'rejected' notify the CHALLENGER (the creator responded).
        // 'reminder' is symmetric -- either side can click it, so the
        // target is always whichever side ISN'T the caller, resolved from
        // authorize_scrim_dm's callerIsCreator rather than a fixed role.
        const targetOwnerId = event === 'reminder'
            ? (auth.callerIsCreator ? auth.opponentOwnerId : auth.creatorOwnerId)
            : (event === 'challenged' ? auth.creatorOwnerId : auth.opponentOwnerId);

        const result = await dmUserById(client, targetOwnerId, body);
        if (!result.ok) return res.status(result.status).json({ error: result.error });
        return res.status(200).json({ success: true });
    });

    // --- 1g. Scheduled scrim reminders -- shared-secret model like
    // /notify, since a cron trigger has no signed-in user to forward a
    // session for. Uses the Supabase SERVICE ROLE key (a new trust
    // boundary for this bot -- see callRpcAsService above) to reach
    // get_scrims_needing_reminder()/mark_scrim_reminder_sent(), both
    // deliberately ungranted to authenticated/anon in supabase_migration_rls.sql
    // section 17 -- this endpoint is the only way either is reachable.
    // The sweep itself now lives in src/jobs/scrimReminders.js, because
    // the bot runs it on its own timer (src/lib/scheduler.js) as well as
    // serving it here. Two copies of this loop would drift, and this one
    // had a bug the shared version fixes: it marked every scrim as
    // reminded even when the Discord gateway was down and every DM had
    // failed, permanently losing reminders that no retry would pick up.
    //
    // The endpoint is kept for a manual poke while debugging, and so an
    // external cron can still drive it. Both paths are idempotent, so
    // running both changes nothing.
    router.post('/scrim-reminders-tick', requireApiKey, async (req, res) => {
        const result = await scrimReminderJob.run();
        if (result && result.error) {
            return res.status(500).json({ error: 'Could not reach Supabase for the reminder query.' });
        }
        return res.status(200).json({
            ok: true,
            scrimsProcessed: result.scrims || 0,
            remindersSent: result.dms || 0
        });
    });

    // --- 1b. Notify a batch of players by Discord username ---
    // Registration only ever collects/verifies a username, never a numeric
    // ID (see /verify-membership below) -- so this resolves each username
    // against the tournament's own Discord server fresh, in the same
    // request that sends the DM, rather than requiring an ID to be looked
    // up and persisted somewhere ahead of time.
    router.post('/notify-by-username', requireApiKey, rateLimitNotify, async (req, res) => {
        const { usernames, inviteLink, message } = req.body;

        if (!Array.isArray(usernames) || usernames.length === 0 || !inviteLink || !message) {
            return res.status(400).json({ error: 'Missing usernames (non-empty array), inviteLink, or message in request body' });
        }

        const results = [];
        for (const username of usernames) {
            try {
                const resolved = await resolveGuildMember(client, inviteLink, username);
                if (resolved.error) {
                    // Invite/guild-level failure applies to every remaining
                    // username too -- no point retrying it player by player.
                    return res.status(resolved.status).json({ error: resolved.error });
                }
                if (!resolved.member) {
                    results.push({ username, success: false, error: 'Not found in server' });
                    continue;
                }
                await resolved.member.user.send(message);
                results.push({ username, success: true });
            } catch (error) {
                console.error(`[API Error] Failed to DM ${username}:`, error.message);
                results.push({ username, success: false, error: error.code === 50007 ? 'DMs disabled or blocked' : 'Send failed' });
            }
        }

        return res.status(200).json({ results });
    });

    // --- 1c. Broadcast an announcement directly into a Discord channel ---
    // Unlike /notify and /notify-by-username (both DM individuals), this
    // posts one visible message into the channel the organizer configured
    // for their tournament (tournaments.announcementChannelId) -- the bot
    // must already be a member of that server, same requirement the other
    // endpoints already have via resolveGuildMember(). A channel ID (not
    // an invite link) is required here because an invite only identifies a
    // *server*, not which channel to post in. Always goes to everyone who
    // can see the channel -- no per-player/per-team targeting.
    router.post('/broadcast-to-channel', requireApiKey, rateLimitNotify, async (req, res) => {
        const { channelId, title, body } = req.body;

        if (!channelId || !body) {
            return res.status(400).json({ error: 'Missing channelId or body in request body' });
        }

        try {
            const channel = await client.channels.fetch(channelId).catch(() => null);
            if (!channel || !channel.guild || !channel.isTextBased()) {
                return res.status(404).json({ error: 'Channel not found. Double-check the Announcement Channel ID, and make sure the bot has been invited to that server.' });
            }

            await channel.send({
                embeds: [{
                    title: (title || 'Announcement').slice(0, 256),
                    description: body.slice(0, 4096),
                    color: 0x7C3AED,
                    timestamp: new Date().toISOString()
                }]
            });

            console.log(`[API] Broadcast sent to channel ${channelId}`);
            return res.status(200).json({ success: true });
        } catch (error) {
            console.error(`[API Error] Failed to broadcast to channel ${channelId}:`, error.message);
            if (error.code === 50001 || error.code === 50013) {
                return res.status(403).json({ error: "The bot doesn't have permission to post in that channel -- check its role permissions in Discord." });
            }
            return res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // --- 1d. Broadcast, authorized by the caller's own Supabase session ---
    // Replaces /broadcast-to-channel for browser callers. The key
    // difference is not the auth mechanism but WHERE the destination
    // comes from: channelId is a RETURN value from the RPC, never
    // req.body, so a caller cannot post into a channel they don't own
    // even if the bot can see it.
    router.post('/tournament-broadcast', requireUserToken, rateLimitNotify, rateLimitPerToken, async (req, res) => {
        const { tournamentId, title, body } = req.body;

        if (!tournamentId || !body) {
            return res.status(400).json({ error: 'Missing tournamentId or body in request body' });
        }

        const auth = await callRpc('authorize_tournament_broadcast', { p_tournament_id: tournamentId }, req.userToken);
        if (!auth) {
            return res.status(401).json({ error: 'Your session could not be verified -- please sign in again.' });
        }
        if (!auth.allowed) {
            return res.status(403).json({ error: auth.message });
        }

        try {
            const channel = await client.channels.fetch(auth.channelId).catch(() => null);
            if (!channel || !channel.guild || !channel.isTextBased()) {
                return res.status(404).json({ error: 'Channel not found. Double-check the Announcement Channel ID, and make sure the bot has been invited to that server.' });
            }

            await channel.send({
                embeds: [{
                    title: (title || 'Announcement').slice(0, 256),
                    description: String(body).slice(0, 4096),
                    color: 0x7C3AED,
                    timestamp: new Date().toISOString()
                }]
            });

            console.log(`[API] Broadcast sent for tournament ${tournamentId}`);
            return res.status(200).json({ success: true });
        } catch (error) {
            console.error(`[API Error] tournament-broadcast for ${tournamentId}:`, error.message);
            if (error.code === 50001 || error.code === 50013) {
                return res.status(403).json({ error: "The bot doesn't have permission to post in that channel -- check its role permissions in Discord." });
            }
            return res.status(500).json({ error: 'Internal Server Error' });
        }
    });

    // --- 1e. Match DMs, same model ---
    // usernames and inviteLink both come from the RPC, which resolves the
    // roster itself scoped to the tournament. That is what stops this
    // being a "DM any Discord user" primitive the way /notify-by-username
    // is -- there is no roster parameter to tamper with.
    router.post('/tournament-notify-match', requireUserToken, rateLimitNotify, rateLimitPerToken, async (req, res) => {
        const { tournamentId, team1Id, team2Id, message } = req.body;

        if (!tournamentId || !team1Id || !team2Id || !message) {
            return res.status(400).json({ error: 'Missing tournamentId, team1Id, team2Id or message in request body' });
        }

        const auth = await callRpc('authorize_match_dm', {
            p_tournament_id: tournamentId, p_team1_id: team1Id, p_team2_id: team2Id
        }, req.userToken);
        if (!auth) {
            return res.status(401).json({ error: 'Your session could not be verified -- please sign in again.' });
        }
        if (!auth.allowed) {
            return res.status(403).json({ error: auth.message });
        }

        // Invite resolved ONCE for the whole roster, not per player.
        const resolved = await resolveGuild(client, auth.inviteLink);
        if (resolved.error) {
            return res.status(resolved.status).json({ error: resolved.error });
        }

        const body = String(message).slice(0, 2000);
        const results = [];
        for (const username of auth.usernames) {
            try {
                const member = await findMemberInGuild(resolved.guild, username);
                if (!member) {
                    results.push({ username, success: false, error: 'Not found in server' });
                    continue;
                }
                await member.user.send(body);
                results.push({ username, success: true });
            } catch (error) {
                console.error(`[API Error] Failed to DM ${username}:`, error.message);
                results.push({ username, success: false, error: error.code === 50007 ? 'DMs disabled or blocked' : 'Send failed' });
            }
        }

        return res.status(200).json({ results });
    });

    // --- 1h. Notify an entire bracket round, one DM per player about
    // their OWN match ---
    //
    // WHY THIS IS ONE ENDPOINT AND NOT A CLIENT-SIDE LOOP.
    // rateLimitPerToken caps a session at 5 requests a minute. A round of
    // eight matches sent as eight calls is refused after the fifth,
    // leaving half a round notified and the organizer unable to tell
    // which half. Doing the whole round inside one request also means the
    // Discord guild is resolved once instead of eight times.
    //
    // AUTHORIZATION IS PER MATCH, deliberately. Every match goes through
    // authorize_match_dm() -- the same RPC the single-match route uses,
    // scoped to the tournament -- so a tampered request carrying another
    // tournament's team ids resolves to no usernames rather than DMing
    // that tournament's players. There is no round-level shortcut that
    // would skip that check.
    router.post('/tournament-notify-round', requireUserToken, rateLimitNotify, rateLimitPerToken, async (req, res) => {
        const { tournamentId, matches } = req.body;

        if (!tournamentId || !Array.isArray(matches) || !matches.length) {
            return res.status(400).json({ error: 'Missing tournamentId or matches in request body' });
        }
        if (matches.length > MAX_ROUND_MATCHES) {
            return res.status(400).json({
                error: `A round trigger can cover at most ${MAX_ROUND_MATCHES} matches.`
            });
        }

        let guild = null;              // resolved once, on the first authorized match
        let sentCount = 0;
        const results = [];

        for (const entry of matches) {
            const matchId = entry && entry.matchId;
            const team1Id = entry && entry.team1Id;
            const team2Id = entry && entry.team2Id;
            const message = entry && entry.message;

            if (!team1Id || !team2Id || !message) {
                results.push({ matchId, error: 'Missing team ids or message', results: [] });
                continue;
            }

            const auth = await callRpc('authorize_match_dm', {
                p_tournament_id: tournamentId, p_team1_id: team1Id, p_team2_id: team2Id
            }, req.userToken);

            if (!auth) {
                // A failed authorization call is about the SESSION, not this
                // match -- every remaining match would fail the same way, so
                // stop rather than hammer the RPC once per match.
                return res.status(401).json({ error: 'Your session could not be verified -- please sign in again.' });
            }
            if (!auth.allowed) {
                results.push({ matchId, error: auth.message, results: [] });
                continue;
            }

            if (!guild) {
                const resolved = await resolveGuild(client, auth.inviteLink);
                if (resolved.error) {
                    return res.status(resolved.status).json({ error: resolved.error });
                }
                guild = resolved.guild;
            }

            const body = String(message).slice(0, 2000);
            const perMatch = [];
            for (const username of auth.usernames) {
                // A global ceiling as well as a per-round one: without it a
                // single click could set off an unbounded number of DMs and
                // put the bot in front of Discord's own rate limiter.
                if (sentCount >= MAX_ROUND_RECIPIENTS) {
                    perMatch.push({ username, success: false, error: 'Round DM limit reached' });
                    continue;
                }
                try {
                    const member = await findMemberInGuild(guild, username);
                    if (!member) {
                        perMatch.push({ username, success: false, error: 'Not found in server' });
                        continue;
                    }
                    await member.user.send(body);
                    sentCount++;
                    perMatch.push({ username, success: true });
                } catch (error) {
                    console.error(`[API Error] Round DM to ${username} failed:`, error.message);
                    perMatch.push({
                        username, success: false,
                        error: error.code === 50007 ? 'DMs disabled or blocked' : 'Send failed'
                    });
                }
            }
            results.push({ matchId, results: perMatch });
        }

        console.log(`[API] Round notify for ${tournamentId}: ${matches.length} matches, ${sentCount} DMs sent`);
        return res.status(200).json({ results });
    });

    // --- 2. Verify Membership ---
    router.post('/verify-membership', async (req, res) => {
        const { userId, username, inviteLink } = req.body;
        
        if ((!userId && !username) || !inviteLink) {
            return res.status(400).json({ error: 'Missing userId (or username) and inviteLink in request body' });
        }

        try {
            const invite = await client.fetchInvite(inviteLink).catch(() => null);
            if (!invite || !invite.guild) {
                return res.status(400).json({ error: 'Invalid or expired invite link' });
            }

            const guildId = invite.guild.id;
            const guild = await client.guilds.fetch(guildId).catch(() => null);
            
            if (!guild) {
                return res.status(403).json({ 
                    error: 'Bot is not in that server. The organizer MUST invite the bot to their server first.' 
                });
            }

            let member = null;

            if (userId) {
                member = await guild.members.fetch(userId).catch(() => null);
            } else if (username) {
                const searchResults = await guild.members.fetch({ query: username, limit: 10 }).catch(() => null);
                if (searchResults && searchResults.size > 0) {
                    member = searchResults.find(m => 
                        m.user.username.toLowerCase() === username.toLowerCase() || 
                        (m.user.globalName && m.user.globalName.toLowerCase() === username.toLowerCase())
                    );
                }
            }
            
            if (member) {
                return res.status(200).json({ isMember: true, guildName: guild.name, matchedUser: member.user.username });
            } else {
                return res.status(200).json({ isMember: false, guildName: guild.name });
            }

        } catch (error) {
            console.error(`[API Error] Failed to verify membership:`, error.message);
            return res.status(500).json({ error: 'Internal Server Error.' });
        }
    });

    // ---------------------------------------------------------------
    // 3. Paid tournament registration (Razorpay). See
    // supabase_migration_rls.sql section 32 for the full design --
    // register_team() is never called directly for a paid tournament;
    // complete_registration_payment() (called from both routes below)
    // is the only thing that inserts the team, and only after a
    // verified signature. Every route here is a no-op 500 until
    // RAZORPAY_KEY_ID/RAZORPAY_KEY_SECRET/RAZORPAY_WEBHOOK_SECRET are
    // set in this process's own .env -- there is no dependency on
    // settings.razorpayKeyId for anything server-side, that column
    // exists only for Checkout.js in the browser.
    // ---------------------------------------------------------------

    // 3a. Create a Razorpay order for a registration fee. Runs the same
    // pre-checks register_team() itself enforces (via
    // precheck_paid_registration, forwarding the caller's own session)
    // BEFORE ever creating an order or taking a card number, so nobody
    // pays for a slot that was already gone.
    router.post('/payments/create-order', requireUserToken, async (req, res) => {
        if (!razorpayConfigured()) {
            return res.status(500).json({ error: 'Payments are not configured on the bot yet.' });
        }
        const { tournamentId, team } = req.body;
        if (!tournamentId || !team || !team.id || !team.name) {
            return res.status(400).json({ error: 'Missing tournamentId or team (with id/name) in request body' });
        }

        const precheck = await callRpc('precheck_paid_registration', { p_tournament_id: tournamentId, p_team_name: team.name }, req.userToken);
        if (!precheck) {
            return res.status(401).json({ error: 'Your session could not be verified -- please sign in again.' });
        }
        if (!precheck.success) {
            return res.status(400).json({ error: precheck.message });
        }

        const order = await razorpayFetch('/orders', {
            method: 'POST',
            body: JSON.stringify({
                amount: precheck.amountPaise,
                currency: 'INR',
                receipt: `${tournamentId}-${team.id}`.slice(0, 40),
                notes: { tournamentId, teamId: team.id }
            })
        });
        if (!order) {
            return res.status(502).json({ error: 'Could not create the payment order -- please try again.' });
        }

        const created = await callRpc('create_registration_payment_order', {
            p_tournament_id: tournamentId,
            p_razorpay_order_id: order.id,
            p_team_payload: team
        }, req.userToken);
        if (!created) {
            return res.status(401).json({ error: 'Your session could not be verified -- please sign in again.' });
        }
        if (!created.success) {
            return res.status(400).json({ error: created.message });
        }

        return res.status(200).json({
            razorpayOrderId: created.razorpayOrderId,
            amountPaise: created.amountPaise,
            keyId: RAZORPAY_KEY_ID,
            paymentRecordId: created.paymentRecordId
        });
    });

    // 3b. Client-side checkout success callback. This is a fast-path
    // UX nicety, not the only way a registration completes -- the
    // webhook below (3c) is the authoritative path if the browser
    // closes before this ever fires. Both call the exact same RPC,
    // which is safe to call from either (or both, at once) -- see that
    // RPC's own comment.
    router.post('/payments/verify-payment', requireUserToken, async (req, res) => {
        if (!razorpayConfigured()) {
            return res.status(500).json({ error: 'Payments are not configured on the bot yet.' });
        }
        const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;
        if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
            return res.status(400).json({ error: 'Missing payment verification fields.' });
        }

        // Razorpay's documented checkout-signature algorithm -- HMAC
        // over the parsed order_id + "|" + payment_id, a DIFFERENT
        // signature from the webhook's (which is over the raw body).
        // Fail closed: any mismatch or thrown error rejects, never
        // proceeds on ambiguity.
        let expected;
        try {
            expected = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET)
                .update(`${razorpayOrderId}|${razorpayPaymentId}`)
                .digest('hex');
        } catch (err) {
            console.error('[Razorpay] verify-payment HMAC computation failed:', err.message);
            return res.status(400).json({ error: 'Could not verify this payment.' });
        }
        if (!safeKeysMatch(razorpaySignature, expected)) {
            return res.status(401).json({ error: 'Payment signature does not match.' });
        }

        const result = await callRpcAsService('complete_registration_payment', {
            p_razorpay_order_id: razorpayOrderId,
            p_razorpay_payment_id: razorpayPaymentId
        });
        if (!result) {
            return res.status(500).json({ error: 'Could not complete the registration -- please contact the organizer.' });
        }
        if (!result.success) {
            // create-order's failure branches above already wrap as
            // {error: message} for _botFetch (js/db.js) to surface -- match
            // that shape here too so a refund-required/closed message
            // reaches the client instead of _botFetch's generic "Bot
            // request failed." fallback (which only fires when `.error`
            // is absent from a non-2xx body).
            return res.status(400).json({ error: result.message, ...result });
        }
        console.log(`[API] Paid registration completed for order ${razorpayOrderId} -> team ${result.teamId}`);
        return res.status(200).json(result);
    });

    // ---------------------------------------------------------------
    // 3d/3e. Wallet top-up. The same two-step shape as 3a/3b above,
    // for the same reasons: the amount is re-validated in Postgres
    // before an order exists, and the credit only happens behind a
    // verified signature.
    //
    // The one difference worth noting: the amount here is chosen by the
    // CLIENT, which the registration fee never is (that is read off the
    // tournament row). So it is the one number in either flow that
    // cannot be trusted, and precheck_wallet_topup bounds it server-side
    // before a single rupee is quoted to Razorpay.
    // ---------------------------------------------------------------
    router.post('/wallet/topup-create-order', requireUserToken, async (req, res) => {
        if (!razorpayConfigured()) {
            return res.status(500).json({ error: 'Payments are not configured on the bot yet.' });
        }
        const amountPaise = Number(req.body && req.body.amountPaise);
        if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
            return res.status(400).json({ error: 'Missing or invalid amountPaise.' });
        }

        const precheck = await callRpc('precheck_wallet_topup', { p_amount_paise: amountPaise }, req.userToken);
        if (!precheck) {
            return res.status(401).json({ error: 'Your session could not be verified -- please sign in again.' });
        }
        if (!precheck.success) {
            return res.status(400).json({ error: precheck.message });
        }

        // precheck.amountPaise, not the request's: the server's idea of
        // the amount is the only one that reaches Razorpay.
        const order = await razorpayFetch('/orders', {
            method: 'POST',
            body: JSON.stringify({
                amount: precheck.amountPaise,
                currency: 'INR',
                receipt: `topup-${Date.now()}`.slice(0, 40),
                notes: { kind: 'wallet_topup' }
            })
        });
        if (!order) {
            return res.status(502).json({ error: 'Could not start the top-up -- please try again.' });
        }

        const created = await callRpc('create_wallet_topup', {
            p_razorpay_order_id: order.id,
            p_amount_paise: precheck.amountPaise
        }, req.userToken);
        if (!created) {
            return res.status(401).json({ error: 'Your session could not be verified -- please sign in again.' });
        }
        if (!created.success) {
            return res.status(400).json({ error: created.message });
        }

        return res.status(200).json({
            razorpayOrderId: created.razorpayOrderId,
            amountPaise: created.amountPaise,
            keyId: RAZORPAY_KEY_ID
        });
    });

    router.post('/wallet/topup-verify', requireUserToken, async (req, res) => {
        if (!razorpayConfigured()) {
            return res.status(500).json({ error: 'Payments are not configured on the bot yet.' });
        }
        const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body || {};
        if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
            return res.status(400).json({ error: 'Missing payment verification fields.' });
        }

        // Checkout signature: HMAC over order_id + "|" + payment_id.
        // A different signature from the webhook's, which is over the
        // raw body. Fail closed on any mismatch or thrown error.
        let expected;
        try {
            expected = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET)
                .update(`${razorpayOrderId}|${razorpayPaymentId}`)
                .digest('hex');
        } catch (err) {
            console.error('[Razorpay] topup-verify HMAC computation failed:', err.message);
            return res.status(400).json({ error: 'Could not verify this payment.' });
        }
        if (!safeKeysMatch(razorpaySignature, expected)) {
            return res.status(401).json({ error: 'Payment signature does not match.' });
        }

        // As service: this one moves money and is revoked from every
        // browser role. Safe to call twice -- it flips the row's status
        // under a lock and credits nothing the second time.
        const result = await callRpcAsService('complete_wallet_topup', {
            p_razorpay_order_id: razorpayOrderId,
            p_razorpay_payment_id: razorpayPaymentId
        });
        if (!result) {
            return res.status(500).json({ error: 'Payment taken but the wallet could not be credited -- contact support with payment ID ' + razorpayPaymentId + '.' });
        }
        if (!result.success) {
            return res.status(400).json({ error: result.message, ...result });
        }
        console.log(`[API] Wallet top-up credited for order ${razorpayOrderId}${result.alreadyCredited ? ' (already credited)' : ''}`);
        return res.status(200).json(result);
    });

    // 3c. Razorpay webhook -- the authoritative completion path.
    // Always 200s once the signature is valid, regardless of what
    // complete_registration_payment actually did (already-completed is
    // a valid, expected outcome here, not an error) -- Razorpay retries
    // on non-200, and retrying an already-idempotent call is harmless
    // but pointless.
    router.post('/payments/webhook', verifyRazorpaySignature(() => process.env.RAZORPAY_WEBHOOK_SECRET), async (req, res) => {
        const event = req.body?.event;
        if (event !== 'payment.captured') {
            return res.status(200).json({ ok: true, ignored: event || 'unknown event' });
        }
        const payment = req.body?.payload?.payment?.entity;
        if (!payment?.order_id || !payment?.id) {
            return res.status(200).json({ ok: true, ignored: 'malformed payload' });
        }

        // One webhook endpoint now serves two products: tournament
        // registrations and Organizer Pro purchases. Razorpay doesn't tell
        // us which, so the order id is resolved against each table in
        // turn. Registration is tried first only because it's the higher
        // volume path -- both RPCs return "Unknown order." for an id they
        // don't own, which is the signal to try the other, and both are
        // independently idempotent so a retry can't double-apply either.
        let result = await callRpcAsService('complete_registration_payment', {
            p_razorpay_order_id: payment.order_id,
            p_razorpay_payment_id: payment.id
        });
        let kind = 'registration';
        if (result && !result.success && /unknown order/i.test(result.message || '')) {
            result = await callRpcAsService('complete_plan_purchase', {
                p_razorpay_order_id: payment.order_id,
                p_razorpay_payment_id: payment.id
            });
            kind = 'plan';
        }
        if (!result) {
            // A genuine failure to reach Supabase -- worth a non-200 so
            // Razorpay retries this one, unlike the "nothing to do"
            // cases above.
            return res.status(500).json({ error: 'Could not process webhook.' });
        }
        console.log(`[API] Webhook (${kind}) order ${payment.order_id}:`, result.success ? (result.alreadyCompleted || result.alreadyProcessed ? 'already completed' : (result.teamId ? `team ${result.teamId}` : `pro until ${result.proUntil}`)) : result.message);
        return res.status(200).json({ ok: true });
    });

    // ── 4. Organizer Pro ────────────────────────────────────────
    // Same two-step shape as the registration routes above (order here,
    // verify below) and the same signature algorithms. What differs is
    // only the product: create_plan_order reads the price from
    // plan_limits itself, so nothing about the amount comes from the
    // client, and complete_plan_purchase extends users.proUntil rather
    // than creating a team.
    router.post('/plan/create-order', requireUserToken, async (req, res) => {
        if (!razorpayConfigured()) {
            return res.status(500).json({ error: 'Payments are not configured on the bot yet.' });
        }
        const { period } = req.body;
        if (period !== 'monthly' && period !== 'yearly') {
            return res.status(400).json({ error: 'period must be "monthly" or "yearly".' });
        }

        // Razorpay needs an amount before it will mint an order id, and
        // the only trustworthy source of that amount is the database --
        // so the price is read server-side here, never taken from the
        // request body. create_plan_order below independently re-derives
        // the same price for the stored record rather than trusting this
        // one, so a tampered bot request still can't buy a year cheap.
        const price = await callRpc('get_pro_price', { p_period: period }, req.userToken);
        if (price === null || price === undefined) {
            return res.status(401).json({ error: 'Your session could not be verified -- please sign in again.' });
        }
        if (!(price > 0)) {
            return res.status(400).json({ error: 'Pro is not on sale right now.' });
        }

        const order = await razorpayFetch('/orders', {
            method: 'POST',
            body: JSON.stringify({
                amount: price,
                currency: 'INR',
                receipt: `pro-${period}-${Date.now()}`.slice(0, 40),
                notes: { product: 'organizer_pro', period }
            })
        });
        if (!order) {
            return res.status(502).json({ error: 'Could not create the payment order -- please try again.' });
        }

        const created = await callRpc('create_plan_order', {
            p_period: period,
            p_razorpay_order_id: order.id
        }, req.userToken);
        if (!created) {
            return res.status(401).json({ error: 'Your session could not be verified -- please sign in again.' });
        }
        if (!created.success) {
            return res.status(400).json({ error: created.message });
        }

        return res.status(200).json({
            razorpayOrderId: order.id,
            amountPaise: created.amountPaise,
            keyId: RAZORPAY_KEY_ID
        });
    });

    router.post('/plan/verify-payment', requireUserToken, async (req, res) => {
        if (!razorpayConfigured()) {
            return res.status(500).json({ error: 'Payments are not configured on the bot yet.' });
        }
        const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
        if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
            return res.status(400).json({ error: 'Missing payment verification fields.' });
        }

        // Identical fail-closed HMAC check to /payments/verify-payment.
        let expected;
        try {
            expected = crypto.createHmac('sha256', RAZORPAY_KEY_SECRET)
                .update(`${razorpay_order_id}|${razorpay_payment_id}`)
                .digest('hex');
        } catch (err) {
            console.error('[Razorpay] plan verify HMAC computation failed:', err.message);
            return res.status(400).json({ error: 'Could not verify this payment.' });
        }
        if (!safeKeysMatch(razorpay_signature, expected)) {
            return res.status(401).json({ error: 'Payment signature does not match.' });
        }

        const result = await callRpcAsService('complete_plan_purchase', {
            p_razorpay_order_id: razorpay_order_id,
            p_razorpay_payment_id: razorpay_payment_id
        });
        if (!result) {
            return res.status(500).json({ error: 'Could not complete the upgrade -- please contact support.' });
        }
        if (!result.success) {
            return res.status(400).json({ error: result.message, ...result });
        }
        console.log(`[API] Pro purchase completed for order ${razorpay_order_id} -> proUntil ${result.proUntil}`);
        return res.status(200).json(result);
    });

    return router;
};

// Exported for index.js, which builds the same scrim-reminder job for
// the scheduler. Attached to the factory rather than moved to their own
// module: they are still only meaningful to this bot's Supabase and
// Discord wiring, and moving them would be a bigger change than the one
// being made.
// Cache size and spent budget for /health. Returns counts only -- the
// API key is never part of this, and neither are the channels looked up.
module.exports.youtubeStatus = () => youtubeStats.status();
module.exports.dmUserById = dmUserById;
module.exports.callRpcAsService = callRpcAsService;

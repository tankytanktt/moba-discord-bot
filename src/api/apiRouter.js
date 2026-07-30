const express = require('express');
const crypto = require('crypto');
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

// Pass the Discord client to the router so endpoints can use it
module.exports = (client) => {

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

    // --- 1. Send DM Notification ---
    router.post('/notify', requireApiKey, rateLimitNotify, async (req, res) => {
        const { userId, message } = req.body;
        
        if (!userId || !message) {
            return res.status(400).json({ error: 'Missing userId or message in request body' });
        }

        try {
            const user = await client.users.fetch(userId).catch(() => null);
            if (!user) {
                return res.status(404).json({ error: 'User not found on Discord' });
            }

            await user.send(message);
            console.log(`[API] Sent DM to user ${userId}`);
            
            return res.status(200).json({ success: true, message: 'Notification sent' });
        } catch (error) {
            console.error(`[API Error] Failed to send DM to ${userId}:`, error.message);
            if (error.code === 50007) {
                return res.status(403).json({ error: 'Cannot send messages to this user (DMs disabled or blocked)' });
            }
            return res.status(500).json({ error: 'Internal Server Error' });
        }
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

    return router;
};

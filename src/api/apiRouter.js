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

// Shared by /verify-membership and /notify-by-username: resolves a guild
// member by username within the server behind a given invite link.
async function resolveGuildMember(client, inviteLink, username) {
    const invite = await client.fetchInvite(inviteLink).catch(() => null);
    if (!invite || !invite.guild) {
        return { error: 'Invalid or expired invite link', status: 400 };
    }
    const guild = await client.guilds.fetch(invite.guild.id).catch(() => null);
    if (!guild) {
        return { error: 'Bot is not in that server. The organizer MUST invite the bot to their server first.', status: 403 };
    }
    const searchResults = await guild.members.fetch({ query: username, limit: 10 }).catch(() => null);
    let member = null;
    if (searchResults && searchResults.size > 0) {
        member = searchResults.find(m =>
            m.user.username.toLowerCase() === username.toLowerCase() ||
            (m.user.globalName && m.user.globalName.toLowerCase() === username.toLowerCase())
        );
    }
    return { guild, member };
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

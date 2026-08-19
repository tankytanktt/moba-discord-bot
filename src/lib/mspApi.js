/**
 * Read access to MSP for slash commands.
 *
 * Until now every path in this bot was OUTBOUND -- the website told the bot
 * to send a DM or post a broadcast. Nothing let a Discord user ask MSP a
 * question. This module is the inbound half.
 *
 * NOTE ON DUPLICATION: src/api/apiRouter.js has its own callRpcAsService().
 * They are deliberately not merged right now -- that file also carries the
 * Razorpay payment and webhook paths, and refactoring a shared dependency
 * out from under live money handling is not a change to make casually. If
 * they are ever unified, this is the copy to keep and apiRouter should
 * delegate to it, not the other way round.
 */

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// Where to send people for the full picture. Overridable so a staging
// deploy links to staging rather than production.
const SITE_URL = (process.env.SITE_URL || 'https://mobaesports.netlify.app').replace(/\/+$/, '');

/**
 * Calls a Postgres function with the service-role key.
 *
 * Every failure mode resolves to null rather than throwing. An async
 * discord.js interaction handler that rejects leaves the user staring at
 * "The application did not respond" with no explanation, and an unhandled
 * rejection can take the whole process down -- Discord connection included.
 * Callers check for null and say something useful instead.
 */
async function callRpc(fnName, args) {
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
        console.error(`[mspApi] ${fnName}: missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY`);
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
            body: JSON.stringify(args || {})
        });
        if (!res.ok) {
            // Body, not just status: PostgREST puts the actual reason
            // (missing function, bad argument types) in the payload, and
            // without it every failure looks identical in the logs.
            let detail = '';
            try { detail = (await res.text()).slice(0, 300); } catch (e) { /* ignore */ }
            console.error(`[mspApi] ${fnName} -> HTTP ${res.status} ${detail}`);
            return null;
        }
        return await res.json();
    } catch (err) {
        console.error(`[mspApi] ${fnName} failed:`, err.message);
        return null;
    }
}

/**
 * Upcoming, undecided matches for whoever holds this Discord identity.
 *
 * Both the id AND the username are sent, because MSP stores two different
 * things: a team's captain is recorded by snowflake, but the roster entries
 * hold whatever the captain typed into the "Discord Username" field. Sending
 * only the id would answer correctly for captains and tell every other
 * player on the roster they had no matches.
 */
function getMatchesForDiscordUser(discordId, username = null, limit = 5) {
    return callRpc('get_matches_for_discord_user', {
        p_discord_id: discordId,
        p_discord_username: username,
        p_limit: limit
    });
}

/** Tournaments currently accepting registrations. */
function getOpenTournaments(limit = 8) {
    return callRpc('get_open_tournaments_for_bot', { p_limit: limit });
}

/** Open scrims, optionally narrowed to one game. */
function getOpenScrims(game = null, limit = 8) {
    return callRpc('get_open_scrims_for_bot', { p_game: game, p_limit: limit });
}

/**
 * Formats MSP's schedule value for Discord.
 *
 * Returns a Discord timestamp (<t:unix:F>) when the value parses, which
 * renders in each viewer's OWN timezone -- the right answer for a roster
 * spread across regions, and something a pre-formatted IST string can
 * never do. Falls back to the raw text if it will not parse, and to a
 * clear "not scheduled yet" when there is nothing at all.
 */
function discordTime(value) {
    if (!value) return null;
    const ms = Date.parse(value);
    if (Number.isNaN(ms)) return String(value);
    const unix = Math.floor(ms / 1000);
    return `<t:${unix}:F> (<t:${unix}:R>)`;
}

module.exports = { callRpc, getMatchesForDiscordUser, getOpenTournaments, getOpenScrims, discordTime, SITE_URL };

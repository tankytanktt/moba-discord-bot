/**
 * "Your scrim starts soon" -- the sweep that had nowhere to run.
 *
 * Everything else for this feature has existed for a while:
 * get_scrims_needing_reminder() and mark_scrim_reminder_sent() in
 * supabase_migration_rls.sql, and the /scrim-reminders-tick endpoint in
 * src/api/apiRouter.js. The only missing piece was something that called
 * it on time, which is why the platform quietly had no scheduled
 * behaviour at all.
 *
 * The logic lives HERE rather than inside the route so the scheduler and
 * the endpoint run the same code. The alternative -- having the bot make
 * an HTTP request to itself, with its own API key, to reach its own
 * function -- would add a network hop, a second failure mode and a
 * credential round trip to a function call.
 *
 * Every dependency is injected, so the whole thing is testable without
 * Discord or Supabase.
 */

// A reminder about a scrim that has already started is worse than none:
// it tells someone they are late. get_scrims_needing_reminder() enforces
// the window in SQL (now .. now + 20 min); this constant only documents
// what that window is for the reader.
const WINDOW_MINUTES = 20;

/**
 * deps:
 *   callRpc(name, args)  -> parsed JSON, or null on any failure
 *   dmUser(userId, text) -> { ok: boolean, ... }
 *   gatewayUp()          -> boolean
 *   log(...)             -> console.log
 */
function createScrimReminderJob(deps) {
    const callRpc = deps.callRpc;
    const dmUser = deps.dmUser;
    const gatewayUp = deps.gatewayUp || (() => true);
    const log = deps.log || console.log;

    async function run() {
        // The single most important check here. Without it, a sweep
        // running while the Discord gateway is down fails every DM and
        // then marks every scrim as reminded anyway -- turning a
        // temporary outage into permanently missed reminders that no
        // retry will ever pick up. The original endpoint did exactly
        // this, because nothing had ever called it while disconnected.
        if (!gatewayUp()) {
            return { skipped: 'discord-disconnected' };
        }

        const scrims = await callRpc('get_scrims_needing_reminder', {});
        // null means the query itself could not be reached. Returning
        // rather than throwing keeps this a quiet no-op that the next
        // tick retries; the scrims are still unmarked, so nothing is lost.
        if (!scrims) {
            return { error: 'supabase-unreachable' };
        }
        if (!scrims.length) {
            return { scrims: 0, dms: 0 };
        }

        let dms = 0, failed = 0, marked = 0;
        for (const s of scrims) {
            const when = formatWhen(s.scheduledAt);
            for (const ownerId of [s.creatorOwnerId, s.opponentOwnerId]) {
                if (!ownerId) continue;
                const result = await dmUser(ownerId, 'Reminder: your scrim starts soon (' + when + ').');
                if (result && result.ok) dms++; else failed++;
            }

            // Marked AFTER the DMs, never before. If this write fails the
            // scrim stays unmarked and the next tick sends again -- a
            // duplicate reminder, which is a far smaller harm than a
            // silent miss. Marking first would invert that trade.
            //
            // Marked even when a DM failed, deliberately: with the
            // gateway up, a failure is a permanent condition (the player
            // has DMs closed, or left the server) and retrying it every
            // five minutes until the scrim starts helps nobody.
            const ok = await callRpc('mark_scrim_reminder_sent', { p_scrim_id: s.id });
            if (ok !== null) marked++;
        }

        log('[scrim-reminders] ' + scrims.length + ' scrim(s), ' + dms + ' DM(s) sent, ' + failed + ' failed');
        return { scrims: scrims.length, dms: dms, failed: failed, marked: marked };
    }

    return { run, WINDOW_MINUTES };
}

// scheduledAt arrives as an ISO string from PostgREST. A malformed or
// missing value must not throw inside a reminder -- the message is still
// worth sending without a time in it.
function formatWhen(value) {
    if (!value) return 'soon';
    const d = new Date(value);
    if (isNaN(d.getTime())) return 'soon';
    // Asia/Kolkata: MSP is India-only, and a UTC timestamp in a DM is a
    // small piece of homework for the reader.
    try {
        return d.toLocaleString('en-IN', {
            timeZone: 'Asia/Kolkata',
            day: 'numeric', month: 'short',
            hour: 'numeric', minute: '2-digit', hour12: true
        }) + ' IST';
    } catch (e) {
        return d.toISOString();
    }
}

module.exports = { createScrimReminderJob, formatWhen, WINDOW_MINUTES };

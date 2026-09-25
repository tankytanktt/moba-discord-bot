/**
 * Web Push dispatch — the sweep that puts a notification on a lock screen.
 *
 * MSP's notification bell is a <span> in the site's own DOM, updated over
 * a realtime subscription that only exists while the tab is open. Nine
 * events feed it and none of them reach a phone that is closed. This job
 * is what changes that.
 *
 * WHY HERE. Same reasoning as scrimReminders: a Postgres trigger cannot
 * make an HTTP request without pg_net, an Edge Function would be a new
 * runtime with a new deploy and a new secret, and this process is already
 * awake, already scheduled, and already holds the service role key.
 *
 * IDEMPOTENCE. notifications."pushedAt" is this feature's
 * `reminderSentAt`. Rows are claimed where it is null and stamped after
 * sending, so a restart mid-run can at worst re-send — a duplicate on a
 * lock screen, which is a far smaller harm than a missed deadline. Same
 * trade the scrim sweep makes, for the same reason.
 *
 * Every dependency is injected, so all of this is testable without
 * Supabase, without a push service, and without a network.
 */

// One notification can have several endpoints behind it — a player with a
// phone and a laptop — so the RPC returns a row per (notification,
// subscription) pair and this groups them back up. Marking happens once
// per notification, after every one of its endpoints has been tried.
function groupByNotification(rows) {
    const order = [];
    const byId = new Map();
    for (const r of rows || []) {
        if (!r || r.id == null) continue;
        const key = String(r.id);
        if (!byId.has(key)) {
            byId.set(key, { id: r.id, type: r.type, title: r.title, body: r.body, link: r.link, subs: [] });
            order.push(key);
        }
        if (r.endpoint) {
            byId.get(key).subs.push({ endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth });
        }
    }
    return order.map(k => byId.get(k));
}

/**
 * What lands on the lock screen.
 *
 * Shaped here rather than in the browser because this is the only place
 * that sends one. `tag` collapses repeats: three reminders about one
 * tournament should replace each other, not stack three deep — but two
 * unrelated notifications must never collapse, hence type AND link.
 */
function payloadFor(n) {
    const notif = n || {};
    return {
        id: notif.id,
        title: String(notif.title || 'MSP'),
        body: String(notif.body || ''),
        url: String(notif.link || '#/'),
        tag: 'msp-' + String(notif.type || 'general') + '-' + String(notif.link || '')
    };
}

// 404 Not Found and 410 Gone are the push service telling us this browser
// is never coming back — uninstalled, cleared, or the subscription
// expired. Anything else (429, 500, a timeout) is temporary and the row
// stays, because deleting on a transient failure silently unsubscribes
// somebody who did nothing wrong.
function isDeadEndpoint(statusCode) {
    return statusCode === 404 || statusCode === 410;
}

/**
 * deps:
 *   callRpc(name, args)          -> parsed JSON, or null on any failure
 *   sendPush(subscription, json) -> { ok, statusCode }
 *   configured()                 -> boolean, VAPID keys present
 *   batchSize                    -> number, default 100
 *   log(...)                     -> console.log
 */
function createPushDispatchJob(deps) {
    const d = deps || {};
    const callRpc = d.callRpc;
    const sendPush = d.sendPush;
    const configured = d.configured || (() => true);
    const batchSize = d.batchSize || 100;
    const log = d.log || console.log;

    async function run() {
        // No keys means this deploy has not been given any. A quiet skip,
        // not an error: the rows stay unpushed and the moment keys are
        // configured the backlog inside the RPC's one-day window goes out.
        if (!configured()) {
            return { skipped: 'no-vapid-keys' };
        }

        const rows = await callRpc('get_notifications_needing_push', { p_limit: batchSize });
        // null means the query could not be reached at all. Returning
        // rather than throwing keeps this a no-op the next tick retries;
        // nothing is marked, so nothing is lost.
        if (!rows) {
            return { error: 'supabase-unreachable' };
        }

        const notifications = groupByNotification(rows);
        if (!notifications.length) {
            return { notifications: 0, sent: 0 };
        }

        let sent = 0, failed = 0, dropped = 0, marked = 0;

        for (const n of notifications) {
            const payload = payloadFor(n);

            for (const sub of n.subs) {
                let result;
                try {
                    result = await sendPush(
                        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
                        payload
                    );
                } catch (e) {
                    // sendPush is expected to resolve rather than throw,
                    // but a library that throws must not take the sweep
                    // down mid-batch and leave the rest unpushed.
                    result = { ok: false, statusCode: 0 };
                }

                if (result && result.ok) {
                    sent++;
                } else {
                    failed++;
                    if (result && isDeadEndpoint(result.statusCode)) {
                        const gone = await callRpc('drop_push_subscription', { p_endpoint: sub.endpoint });
                        if (gone !== null) dropped++;
                    }
                }
            }

            // Marked AFTER every endpoint has been tried, never before.
            // If this write fails the row stays unmarked and the next tick
            // sends again — a duplicate, not a silent miss.
            //
            // Marked even when every send failed, and even when a
            // notification had no subscriptions at all: retrying a person
            // who is not subscribed, every minute, until the row ages out
            // of the one-day window helps nobody.
            const ok = await callRpc('mark_notification_pushed', { p_id: n.id });
            if (ok !== null) marked++;
        }

        log('[push-dispatch] ' + notifications.length + ' notification(s), '
            + sent + ' sent, ' + failed + ' failed, ' + dropped + ' dead endpoint(s) dropped');
        return { notifications: notifications.length, sent, failed, dropped, marked };
    }

    return { run, groupByNotification, payloadFor, isDeadEndpoint };
}

module.exports = { createPushDispatchJob, groupByNotification, payloadFor, isDeadEndpoint };

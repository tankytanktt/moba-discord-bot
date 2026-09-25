/**
 * The Web Push sender.
 *
 * A thin wrapper over the `web-push` package, which exists because the
 * actual protocol is not thin: a VAPID JWT signed with ES256, an ECDH
 * key agreement against the subscriber's public key, HKDF, and an
 * aes128gcm payload. Hand-rolling that is how you end up debugging a
 * signature error that names nothing.
 *
 * WHY THE require IS IN A try
 *
 * This module is loaded at boot. If `web-push` is not installed yet --
 * the dependency lands in package.json before the next `npm install`
 * runs on Render, and a deploy can briefly sit between the two -- a bare
 * require would throw during startup and take the whole bot down with
 * it. Discord commands, the API and the scrim reminders have nothing to
 * do with push and must not die for it. So a missing package makes push
 * unavailable, and nothing else.
 *
 * KEYS. Generate a pair once with:
 *     npx web-push generate-vapid-keys
 * and set VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY and VAPID_SUBJECT (a
 * mailto: or https: URL identifying you to the push service) in the
 * bot's environment. The PUBLIC key is public by definition -- it ships
 * to every browser that subscribes, and /api/push-public-key serves it
 * deliberately. The PRIVATE key never leaves this process.
 */

let webpush = null;
let loadError = null;
try {
    webpush = require('web-push');
} catch (e) {
    loadError = e && e.message;
}

let configuredOnce = false;

function publicKey() {
    return process.env.VAPID_PUBLIC_KEY || '';
}

/**
 * Push is available only when the library loaded AND both keys exist.
 * Checked on every call rather than cached, so adding the env vars and
 * restarting is all it takes -- no code path remembers a "no" forever.
 */
function configured() {
    if (!webpush) return false;
    if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return false;
    if (!configuredOnce) {
        try {
            webpush.setVapidDetails(
                // A subject is required by the spec. Push services use it
                // to contact the sender about a misbehaving origin, and
                // some reject a subscription without one.
                process.env.VAPID_SUBJECT || 'mailto:support@msp.gg',
                process.env.VAPID_PUBLIC_KEY,
                process.env.VAPID_PRIVATE_KEY
            );
            configuredOnce = true;
        } catch (e) {
            console.error('[push] setVapidDetails failed:', e && e.message);
            return false;
        }
    }
    return true;
}

/**
 * Send one payload to one subscription.
 *
 * Always RESOLVES -- never rejects. The dispatcher decides what a failure
 * means (404/410 retires the endpoint, anything else is temporary), and
 * it can only do that if it is handed a status code rather than an
 * exception. A throw here would also abandon the rest of the batch.
 */
async function sendPush(subscription, payload) {
    if (!configured()) return { ok: false, statusCode: 0, error: 'not-configured' };
    try {
        const res = await webpush.sendNotification(
            subscription,
            JSON.stringify(payload),
            {
                // Four hours. A check-in reminder that arrives the next
                // morning is worse than one that never arrives -- it reads
                // as the platform being broken rather than the phone being
                // off.
                TTL: 4 * 60 * 60,
                urgency: 'high'
            }
        );
        return { ok: true, statusCode: (res && res.statusCode) || 201 };
    } catch (e) {
        // web-push puts the push service's HTTP status on the error.
        return { ok: false, statusCode: (e && e.statusCode) || 0, error: e && e.message };
    }
}

function status() {
    return {
        library: webpush ? 'loaded' : ('missing' + (loadError ? ' (' + loadError + ')' : '')),
        hasPublicKey: !!process.env.VAPID_PUBLIC_KEY,
        hasPrivateKey: !!process.env.VAPID_PRIVATE_KEY,
        subject: process.env.VAPID_SUBJECT || '(default)',
        ready: configured()
    };
}

module.exports = { sendPush, configured, publicKey, status };

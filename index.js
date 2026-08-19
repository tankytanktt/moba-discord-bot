require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// --- 1. Set up Express API Server ---
const app = express();
// verify captures the raw request bytes onto req.rawBody without changing
// anything else -- req.body stays parsed JSON for every existing route.
// Only the Razorpay webhook handler (src/api/apiRouter.js) reads
// req.rawBody, since webhook signature verification is computed over the
// exact raw payload, not the re-serialized parsed object.
app.use(express.json({
    verify: (req, res, buf) => { req.rawBody = buf; }
}));

// Restrict browser calls to the deployed site + local dev -- cors()
// with no options previously allowed any origin. Requests with no
// Origin header (health checks, curl, server-to-server) are still let
// through since they aren't a browser CORS concern.
const ALLOWED_ORIGINS = [
    'https://mobaesports.netlify.app',
    'https://mobaesportsplatform.netlify.app',
    'http://localhost:8000'
];
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        callback(new Error('Not allowed by CORS'));
    }
}));

// Health checks, for UptimeRobot (or any pinger) to hit.
//
// The old version always returned 200 as long as Express was listening --
// but Express and the Discord gateway are two independent things. The bot
// can be perfectly reachable over HTTP while its gateway connection is
// dead, in which case every slash command fails and every DM silently goes
// nowhere. A monitor watching that endpoint would have reported "up" the
// whole time.
//
// So the status now reflects what actually matters: is the bot logged in
// to Discord? A non-2xx is what makes an uptime monitor alert, so a dead
// gateway has to be a non-2xx or the check is decorative.
//
// isReady() is discord.js's own readiness flag; ws.status 0 is READY.
const gatewayUp = () => {
    try { return client.isReady() && client.ws.status === 0; }
    catch (e) { return false; }
};

app.get('/', (req, res) => {
    if (!gatewayUp()) {
        return res.status(503).send('MSP Bot is up but NOT connected to Discord.');
    }
    res.status(200).send('MSP Bot is online!');
});

// Same signal, machine-readable, for debugging a flaky deploy.
app.get('/health', (req, res) => {
    const up = gatewayUp();
    res.status(up ? 200 : 503).json({
        ok: up,
        discord: up ? 'connected' : 'disconnected',
        // ws.ping is -1 until the first heartbeat completes.
        wsPingMs: (() => { try { return client.ws.ping; } catch (e) { return null; } })(),
        guilds: (() => { try { return client.guilds.cache.size; } catch (e) { return null; } })(),
        uptimeSeconds: Math.round(process.uptime()),
        commandsLoaded: (() => { try { return client.commands.size; } catch (e) { return null; } })()
    });
});

const PORT = process.env.PORT || 3000;

// --- 2. Set up Discord Bot ---
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        // MessageContent was requested here but never used: there is no
        // messageCreate handler and nothing reads message.content anywhere
        // in this bot. It is a PRIVILEGED intent -- it needs Discord's
        // approval once the bot passes 100 servers, and while enabled it
        // grants the ability to read every message in every server the bot
        // is in. Dropping it removes both the future approval hurdle and
        // the blast radius, and changes no behaviour.
        //
        // Needed for the username-based member search in
        // /api/verify-membership (apiRouter.js) -- also requires the
        // "Server Members Intent" toggle enabled on the Discord
        // Developer Portal's Bot page, or the client fails to log in.
        GatewayIntentBits.GuildMembers
    ]
});

// --- 2.5 Load Slash Commands ---
const { Collection } = require('discord.js');
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'src', 'commands');
if (!fs.existsSync(commandsPath)) fs.mkdirSync(commandsPath, { recursive: true });

const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
for (const file of commandFiles) {
    const filePath = path.join(commandsPath, file);
    const command = require(filePath);
    if ('data' in command && 'execute' in command) {
        client.commands.set(command.data.name, command);
    }
}

// --- 3. Load Event Handlers dynamically ---
const eventsPath = path.join(__dirname, 'src', 'events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

for (const file of eventFiles) {
    const filePath = path.join(eventsPath, file);
    const event = require(filePath);
    if (event.once) {
        client.once(event.name, (...args) => event.execute(...args, client));
    } else {
        client.on(event.name, (...args) => event.execute(...args, client));
    }
}

// --- 4. Load API Routes ---
// We pass the discord client to our modular router so the API can use it
const apiRouter = require('./src/api/apiRouter')(client);
app.use('/api', apiRouter);

// Catch-all error handler -- must be registered last, and must keep all
// 4 arguments for Express to recognize it as an error handler rather
// than regular middleware. Without this, an unhandled thrown error falls
// through to Express's own default handler, which includes the full
// stack trace in the response body unless NODE_ENV=production is set --
// not something this deploy target (Render) guarantees.
app.use((err, req, res, next) => {
    console.error('[Express] Unhandled error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
});

// --- 5. Start Everything ---
app.listen(PORT, () => {
    console.log(`[Express] API Server listening on port ${PORT}`);
});

// The .catch() below only covers a clean rejection (bad token, or a
// privileged intent -- GuildMembers/MessageContent -- not toggled on in
// the Developer Portal). Observed directly in production: some boots
// instead stall partway through the Gateway handshake (a network hiccup
// between Render and Discord) and client.login()'s promise just sits
// pending forever -- never resolving, never rejecting. That leaves the
// bot silently offline in Discord indefinitely, with Express/Render
// seeing nothing wrong since the web server itself never depended on it.
// This timer is the backstop: if 'ready' hasn't fired within 30s of
// calling login(), something is stuck, so exit and let Render's own
// crash-restart give it a fresh attempt instead of hanging forever.
const LOGIN_TIMEOUT_MS = 30000;
const loginTimeout = setTimeout(() => {
    console.error(`[Discord] Login did not complete within ${LOGIN_TIMEOUT_MS / 1000}s -- Gateway handshake appears stuck. Exiting so Render restarts the process.`);
    process.exit(1);
}, LOGIN_TIMEOUT_MS);
client.once('ready', () => clearTimeout(loginTimeout));

client.login(process.env.DISCORD_TOKEN).catch(err => {
    clearTimeout(loginTimeout);
    console.error('[Discord] Login FAILED -- bot will stay offline in Discord even though this web service stays up. Check: (1) DISCORD_TOKEN in Render\'s Environment tab matches the current token in the Discord Developer Portal\'s Bot page, (2) Server Members Intent and Message Content Intent are both toggled ON there. Raw error:', err);
});

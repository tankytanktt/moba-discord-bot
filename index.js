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
    'https://testingmobaos.netlify.app',
    'http://localhost:8000'
];
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
        callback(new Error('Not allowed by CORS'));
    }
}));

// Root route for UptimeRobot health checks
app.get('/', (req, res) => {
    res.status(200).send('MSP Bot is online!');
});

const PORT = process.env.PORT || 3000;

// --- 2. Set up Discord Bot ---
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
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

client.login(process.env.DISCORD_TOKEN);

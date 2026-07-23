require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

// --- 1. Set up Express API Server ---
const app = express();
app.use(express.json());
app.use(cors());

const PORT = process.env.PORT || 3000;

// --- 2. Set up Discord Bot ---
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ] 
});

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

// --- 5. Start Everything ---
app.listen(PORT, () => {
    console.log(`[Express] API Server listening on port ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);

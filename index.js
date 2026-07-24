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

// Root route for UptimeRobot health checks
app.get('/', (req, res) => {
    res.status(200).send('MOBA Esports OS Bot is online!');
});

const PORT = process.env.PORT || 3000;

// --- 2. Set up Discord Bot ---
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
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

// --- 5. Start Everything ---
app.listen(PORT, () => {
    console.log(`[Express] API Server listening on port ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);

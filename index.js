require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const express = require('express');
const cors = require('cors');

// --- 1. Set up Express API Server ---
const app = express();
app.use(express.json()); // Allows parsing JSON bodies
app.use(cors());         // Allows your website frontend to call this API if needed

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.BOT_API_KEY;

// --- 2. Set up Discord Bot ---
const client = new Client({ 
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ] 
});

client.once('ready', () => {
    console.log(`[Discord] Ready! Logged in as ${client.user.tag}`);
});

// --- 3. API Endpoint to Send DMs ---
// Your website will send POST requests to this endpoint
app.post('/api/notify', async (req, res) => {
    // 3a. Verify API Key
    const providedKey = req.headers['authorization'] || req.headers['x-api-key'];
    if (providedKey !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }

    // 3b. Extract data from request body
    const { userId, message } = req.body;
    
    if (!userId || !message) {
        return res.status(400).json({ error: 'Missing userId or message in request body' });
    }

    try {
        // 3c. Fetch the user and send the DM
        const user = await client.users.fetch(userId);
        if (!user) {
            return res.status(404).json({ error: 'User not found on Discord' });
        }

        await user.send(message);
        console.log(`[API] Sent DM to user ${userId}`);
        
        return res.status(200).json({ success: true, message: 'Notification sent' });
    } catch (error) {
        console.error(`[API Error] Failed to send DM to ${userId}:`, error.message);
        
        // Handle common errors (e.g., user disabled DMs)
        if (error.code === 50007) {
            return res.status(403).json({ error: 'Cannot send messages to this user (DMs disabled or blocked)' });
        }
        
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

// --- 4. Start Everything ---
// Start the Express API Server
app.listen(PORT, () => {
    console.log(`[Express] API Server listening on port ${PORT}`);
});

// Log in the Discord Bot
client.login(process.env.DISCORD_TOKEN);

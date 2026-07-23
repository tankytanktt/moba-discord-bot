const express = require('express');
const router = express.Router();

// Middleware to verify API key for all routes in this router
router.use((req, res, next) => {
    const API_KEY = process.env.BOT_API_KEY;
    const providedKey = req.headers['authorization'] || req.headers['x-api-key'];
    
    if (providedKey !== API_KEY) {
        return res.status(401).json({ error: 'Unauthorized: Invalid API Key' });
    }
    next();
});

// Pass the Discord client to the router so endpoints can use it
module.exports = (client) => {

    // --- 1. Send DM Notification ---
    router.post('/notify', async (req, res) => {
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

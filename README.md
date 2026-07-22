# Discord Bot API Setup

This bot is designed to run alongside your website. It exposes an HTTP API that your website backend can call to trigger Discord Direct Messages (DMs) or verify server membership across multiple servers.

## 1. Install Node.js
If you haven't already, download and install Node.js from [nodejs.org](https://nodejs.org/).

## 2. Install Dependencies
Open your terminal in this folder (`discord-bot`) and run:
```bash
npm install
```

## 3. Register on Discord Developer Portal
1. Go to the [Discord Developer Portal](https://discord.com/developers/applications).
2. Click **New Application** and give it a name.
3. In the left sidebar, click on **Bot**.
4. Click **Reset Token** to get your bot's token. **Copy this token.**

## 4. Environment Variables
Open the `.env` file in this folder:
1. Replace `your_bot_token_here` with the bot token.
2. Replace `your_secret_api_key_here` with a secure random string. This is used to make sure only your website can use the API.

## 5. How Tournament Organizers Invite the Bot
For the bot to verify membership in a tournament organizer's server, the bot MUST be invited to that server. 
You should add a button to your website that links to the following URL (replace `YOUR_CLIENT_ID` with your Application ID from the Developer Portal):

`https://discord.com/oauth2/authorize?client_id=YOUR_CLIENT_ID&permissions=0&scope=bot`

## 6. Run the Bot
In your terminal, run:
```bash
npm start
```

---

## API Endpoints

All requests must include the `x-api-key` header matching your `.env` file.

### 1. Send a DM
**Endpoint:** `POST /api/notify`

**Body (JSON):**
```json
{
  "userId": "123456789012345678",
  "message": "Hello! Your tournament is starting in 5 minutes!"
}
```

### 2. Verify Server Membership
**Endpoint:** `POST /api/verify-membership`

Checks if a specific user is a member of a server, given an invite link to that server.
*(Note: The bot must be explicitly invited to the server first using the OAuth2 link, otherwise it will return a 403 error).*

**Body (JSON):**
```json
{
  "userId": "123456789012345678",
  "inviteLink": "https://discord.gg/abc123xyz"
}
```

**Response (JSON):**
```json
{
  "isMember": true,
  "guildName": "Awesome Esports Server"
}
```

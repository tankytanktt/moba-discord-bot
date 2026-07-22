# Discord Bot API Setup

This bot is designed to run alongside your website. It exposes an HTTP API that your website backend can call to trigger Discord Direct Messages (DMs) to your users.

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
2. Replace `your_secret_api_key_here` with a secure random string (e.g., `super_secret_website_key`). This is used to make sure only your website can send DMs.

## 5. Invite the Bot to Your Server
Users must share a server with the bot (or have accepted a friend request) for the bot to DM them.
1. In the Developer Portal, go to **OAuth2 > URL Generator**.
2. Check the `bot` scope.
3. Copy the URL to invite the bot to your main Discord server.

## 6. Run the Bot
In your terminal, run:
```bash
npm start
```
You should see it connect to both Express and Discord!

---

## How to trigger a Notification from your Website

When an event happens on your website, your website's backend (PHP, Python, Node.js, etc.) should send an HTTP POST request to the bot.

**Endpoint:** `http://localhost:3000/api/notify` (Replace `localhost` with your bot's IP/Domain if hosted remotely)
**Method:** `POST`
**Headers:**
- `Content-Type: application/json`
- `x-api-key: your_secret_api_key_here` (Must match the `.env` file!)

**Body (JSON):**
```json
{
  "userId": "123456789012345678",
  "message": "Hello! Your tournament is starting in 5 minutes!"
}
```

**Example (using cURL):**
```bash
curl -X POST http://localhost:3000/api/notify \
-H "Content-Type: application/json" \
-H "x-api-key: your_secret_api_key_here" \
-d '{"userId": "123456789012345678", "message": "Hey from the website!"}'
```

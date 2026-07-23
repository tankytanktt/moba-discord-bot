const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('dm')
        .setDescription('Sends a Direct Message to a specific user through the bot.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) // Restrict to Admins to prevent spam
        .addUserOption(option => 
            option.setName('target')
                .setDescription('The user you want to message')
                .setRequired(true))
        .addStringOption(option => 
            option.setName('message')
                .setDescription('The message you want to send')
                .setRequired(true)),
        
    async execute(interaction) {
        const targetUser = interaction.options.getUser('target');
        const messageContent = interaction.options.getString('message');

        try {
            // Attempt to send the DM
            await targetUser.send(messageContent);
            
            // Reply privately to the admin confirming success
            await interaction.reply({ 
                content: `Successfully sent a DM to **${targetUser.tag}**: "${messageContent}"`, 
                ephemeral: true 
            });
        } catch (error) {
            console.error(`Could not send DM to ${targetUser.tag}:`, error);
            
            // If it fails (usually because the user has DMs disabled or blocked the bot)
            await interaction.reply({ 
                content: `Failed to send a DM to **${targetUser.tag}**. They might have their Direct Messages disabled for this server, or they have blocked the bot.`, 
                ephemeral: true 
            });
        }
    },
};

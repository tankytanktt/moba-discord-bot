const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('post')
        .setDescription('Make the bot post a message in a specific channel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator) // Restrict to Admins
        .addChannelOption(option => 
            option.setName('channel')
                .setDescription('The channel you want the bot to post in')
                .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
                .setRequired(true))
        .addStringOption(option => 
            option.setName('message')
                .setDescription('The message you want the bot to say')
                .setRequired(true))
        .addAttachmentOption(option => 
            option.setName('attachment')
                .setDescription('An optional image or file to attach to the message')
                .setRequired(false)),
        
    async execute(interaction) {
        const targetChannel = interaction.options.getChannel('channel');
        const messageContent = interaction.options.getString('message');
        const attachment = interaction.options.getAttachment('attachment');

        try {
            // Prepare the message payload
            const payload = { content: messageContent };
            
            // If an attachment was provided, add it to the payload
            if (attachment) {
                payload.files = [attachment.url];
            }

            // Send the message to the target channel
            await targetChannel.send(payload);
            
            // Reply privately to the admin confirming success
            await interaction.reply({ 
                content: `Successfully posted your message in ${targetChannel}!`, 
                ephemeral: true 
            });
        } catch (error) {
            console.error(`Could not post message in ${targetChannel.name}:`, error);
            
            await interaction.reply({ 
                content: `Failed to post the message. Please ensure I have "View Channel" and "Send Messages" permissions for ${targetChannel}.`, 
                ephemeral: true 
            });
        }
    },
};

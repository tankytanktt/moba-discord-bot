const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('kick')
        .setDescription('Kicks a user from the server.')
        .setDefaultMemberPermissions(PermissionFlagsBits.KickMembers)
        .addUserOption(option => 
            option.setName('target')
                .setDescription('The user to kick')
                .setRequired(true))
        .addStringOption(option => 
            option.setName('reason')
                .setDescription('The reason for kicking')
                .setRequired(false)),
        
    async execute(interaction) {
        const targetUser = interaction.options.getMember('target');
        const reason = interaction.options.getString('reason') || 'No reason provided';

        if (!targetUser) {
            return await interaction.reply({ content: 'That user is not in the server!', ephemeral: true });
        }

        if (!targetUser.kickable) {
            return await interaction.reply({ content: 'I cannot kick this user. My role might be below theirs, or they are the server owner.', ephemeral: true });
        }

        try {
            await targetUser.kick(reason);
            await interaction.reply({ content: `Successfully kicked **${targetUser.user.tag}**. Reason: ${reason}` });
        } catch (error) {
            console.error('Error kicking user:', error);
            await interaction.reply({ content: 'An error occurred while trying to kick that user.', ephemeral: true });
        }
    },
};

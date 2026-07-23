const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ban')
        .setDescription('Bans a user from the server.')
        .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
        .addUserOption(option => 
            option.setName('target')
                .setDescription('The user to ban')
                .setRequired(true))
        .addStringOption(option => 
            option.setName('reason')
                .setDescription('The reason for banning')
                .setRequired(false)),
        
    async execute(interaction) {
        const targetUser = interaction.options.getMember('target');
        const reason = interaction.options.getString('reason') || 'No reason provided';

        if (!targetUser) {
            return await interaction.reply({ content: 'That user is not in the server!', ephemeral: true });
        }

        if (!targetUser.bannable) {
            return await interaction.reply({ content: 'I cannot ban this user. My role might be below theirs, or they are the server owner.', ephemeral: true });
        }

        try {
            await targetUser.ban({ reason: reason });
            await interaction.reply({ content: `Successfully banned **${targetUser.user.tag}**. Reason: ${reason}` });
        } catch (error) {
            console.error('Error banning user:', error);
            await interaction.reply({ content: 'An error occurred while trying to ban that user.', ephemeral: true });
        }
    },
};

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('mute')
        .setDescription('Mutes (Timeouts) a user from chatting or joining voice channels.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ModerateMembers)
        .addUserOption(option => 
            option.setName('target')
                .setDescription('The user to mute')
                .setRequired(true))
        .addIntegerOption(option => 
            option.setName('duration')
                .setDescription('Mute duration in minutes')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(40320)) // Max 28 days
        .addStringOption(option => 
            option.setName('reason')
                .setDescription('The reason for muting')
                .setRequired(false)),
        
    async execute(interaction) {
        const targetUser = interaction.options.getMember('target');
        const durationMins = interaction.options.getInteger('duration');
        const reason = interaction.options.getString('reason') || 'No reason provided';

        if (!targetUser) {
            return await interaction.reply({ content: 'That user is not in the server!', ephemeral: true });
        }

        if (!targetUser.moderatable) {
            return await interaction.reply({ content: 'I cannot mute this user. My role might be below theirs, or they are the server owner.', ephemeral: true });
        }

        try {
            // Convert minutes to milliseconds
            const durationMs = durationMins * 60 * 1000;
            
            await targetUser.timeout(durationMs, reason);
            await interaction.reply({ content: `Successfully muted **${targetUser.user.tag}** for ${durationMins} minutes. Reason: ${reason}` });
        } catch (error) {
            console.error('Error muting user:', error);
            await interaction.reply({ content: 'An error occurred while trying to mute that user.', ephemeral: true });
        }
    },
};

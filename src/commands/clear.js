const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('clear')
        .setDescription('Bulk deletes messages from the channel.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
        .addIntegerOption(option => 
            option.setName('amount')
                .setDescription('Number of messages to delete (1-100)')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(100)),
        
    async execute(interaction) {
        const amount = interaction.options.getInteger('amount');

        try {
            const deleted = await interaction.channel.bulkDelete(amount, true);
            await interaction.reply({ 
                content: `Successfully deleted ${deleted.size} messages!`, 
                ephemeral: true 
            });
        } catch (error) {
            console.error('Error clearing messages:', error);
            await interaction.reply({ 
                content: 'Failed to delete messages. Messages older than 14 days cannot be bulk deleted.', 
                ephemeral: true 
            });
        }
    },
};

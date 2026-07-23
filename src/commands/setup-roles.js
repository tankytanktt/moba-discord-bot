const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setup-roles')
        .setDescription('Spawns the button menu for players to self-assign their MOBA roles.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator), // Only Admins can run this
        
    async execute(interaction) {
        // Create the embed message
        const embed = new EmbedBuilder()
            .setTitle('Select Your Roles!')
            .setDescription('Click the buttons below to assign yourself your main roles in the game. You can select multiple roles.')
            .setColor('#3498db')
            .setFooter({ text: 'MOBA Esports OS' });

        // Create the buttons
        const topButton = new ButtonBuilder()
            .setCustomId('role_top')
            .setLabel('Top')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🛡️');

        const jungleButton = new ButtonBuilder()
            .setCustomId('role_jungle')
            .setLabel('Jungle')
            .setStyle(ButtonStyle.Success)
            .setEmoji('🌲');

        const midButton = new ButtonBuilder()
            .setCustomId('role_mid')
            .setLabel('Mid')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🔥');

        const adcButton = new ButtonBuilder()
            .setCustomId('role_adc')
            .setLabel('ADC')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🏹');

        const supportButton = new ButtonBuilder()
            .setCustomId('role_support')
            .setLabel('Support')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('❤️');

        // Add buttons to an Action Row (max 5 buttons per row)
        const row = new ActionRowBuilder()
            .addComponents(topButton, jungleButton, midButton, adcButton, supportButton);

        // Send the message with the embed and the buttons
        await interaction.reply({ embeds: [embed], components: [row] });
    },
};

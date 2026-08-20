const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, PermissionFlagsBits } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setup-roles')
        .setDescription('Spawns the Game Selection menu for players to get their roles.')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles), // Admins and role managers
        
    async execute(interaction) {
        const embed = new EmbedBuilder()
            .setTitle('Select Your Game!')
            .setDescription('Please select which MOBA you play from the dropdown menu below. You will then receive your specific lane roles!')
            .setColor('#3498db')
            .setFooter({ text: 'MSP' });

        const select = new StringSelectMenuBuilder()
            .setCustomId('game_select')
            .setPlaceholder('Choose a MOBA...')
            .addOptions(
                new StringSelectMenuOptionBuilder()
                    .setLabel('Mobile Legends')
                    .setDescription('Get MLBB Lane Roles')
                    .setValue('mlbb')
                    .setEmoji('📱'),
                new StringSelectMenuOptionBuilder()
                    .setLabel('Honor of Kings')
                    .setDescription('Get HoK Lane Roles')
                    .setValue('hok')
                    .setEmoji('👑'),
                // Wild Rift is not released in India yet -- no point handing
                // out lane roles for a game nobody can queue into. Restore
                // when it launches (js/views-core.js carries the same flag).
                // new StringSelectMenuOptionBuilder()
                //     .setLabel('LOL Wild Rift')
                //     .setDescription('Get Wild Rift Lane Roles')
                //     .setValue('wildrift')
                //     .setEmoji('🐉'),
            );

        const row = new ActionRowBuilder()
            .addComponents(select);

        await interaction.reply({ embeds: [embed], components: [row] });
    },
};

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
            .setFooter({ text: 'MOBA Esports OS' });

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
                new StringSelectMenuOptionBuilder()
                    .setLabel('LOL Wild Rift')
                    .setDescription('Get Wild Rift Lane Roles')
                    .setValue('wildrift')
                    .setEmoji('🐉'),
            );

        const row = new ActionRowBuilder()
            .addComponents(select);

        await interaction.reply({ embeds: [embed], components: [row] });
    },
};

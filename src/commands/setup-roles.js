const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('setup-roles')
        .setDescription('Spawns the button menu for players to self-assign their MOBA roles.')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addRoleOption(option => option.setName('exp').setDescription('Custom role for Exp lane'))
        .addRoleOption(option => option.setName('jungle').setDescription('Custom role for Jungle'))
        .addRoleOption(option => option.setName('mid').setDescription('Custom role for Mid lane'))
        .addRoleOption(option => option.setName('marksman').setDescription('Custom role for Marksman'))
        .addRoleOption(option => option.setName('roam').setDescription('Custom role for Roam')),
        
    async execute(interaction) {
        // Fetch optional roles provided by the admin
        const expRole = interaction.options.getRole('exp');
        const jungleRole = interaction.options.getRole('jungle');
        const midRole = interaction.options.getRole('mid');
        const marksmanRole = interaction.options.getRole('marksman');
        const roamRole = interaction.options.getRole('roam');

        const embed = new EmbedBuilder()
            .setTitle('Select Your Roles!')
            .setDescription('Click the buttons below to assign yourself your main roles in the game. You can select multiple roles.')
            .setColor('#3498db')
            .setFooter({ text: 'MOBA Esports OS' });

        // If a custom role was provided, we embed its ID. Otherwise, we fallback to the default name system.
        const expButton = new ButtonBuilder()
            .setCustomId(expRole ? `assign_${expRole.id}` : 'default_Exp')
            .setLabel(expRole ? expRole.name : 'Exp')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('🛡️');

        const jungleButton = new ButtonBuilder()
            .setCustomId(jungleRole ? `assign_${jungleRole.id}` : 'default_Jungle')
            .setLabel(jungleRole ? jungleRole.name : 'Jungle')
            .setStyle(ButtonStyle.Success)
            .setEmoji('🌲');

        const midButton = new ButtonBuilder()
            .setCustomId(midRole ? `assign_${midRole.id}` : 'default_Mid')
            .setLabel(midRole ? midRole.name : 'Mid')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('🔥');

        const marksmanButton = new ButtonBuilder()
            .setCustomId(marksmanRole ? `assign_${marksmanRole.id}` : 'default_Marksman')
            .setLabel(marksmanRole ? marksmanRole.name : 'Marksman')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🏹');

        const roamButton = new ButtonBuilder()
            .setCustomId(roamRole ? `assign_${roamRole.id}` : 'default_Roam')
            .setLabel(roamRole ? roamRole.name : 'Roam')
            .setStyle(ButtonStyle.Primary)
            .setEmoji('❤️');

        const row = new ActionRowBuilder()
            .addComponents(expButton, jungleButton, midButton, marksmanButton, roamButton);

        await interaction.reply({ embeds: [embed], components: [row] });
    },
};

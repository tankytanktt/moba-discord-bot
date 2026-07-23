const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('lfg')
        .setDescription('Post a Looking For Group message to find a team or recruit players.')
        .addStringOption(option => 
            option.setName('type')
                .setDescription('Are you a solo player or a team captain?')
                .setRequired(true)
                .addChoices(
                    { name: 'Solo Player looking for Team', value: 'solo' },
                    { name: 'Team looking for Player', value: 'team' }
                ))
        .addStringOption(option => 
            option.setName('game')
                .setDescription('Which game are you playing?')
                .setRequired(true)
                .addChoices(
                    { name: 'Mobile Legends', value: 'MLBB' },
                    { name: 'Honor of Kings', value: 'HoK' },
                    { name: 'LOL Wild Rift', value: 'Wild Rift' }
                ))
        .addStringOption(option => 
            option.setName('rank')
                .setDescription('What is your current Rank?')
                .setRequired(true))
        .addStringOption(option => 
            option.setName('role')
                .setDescription('What role do you play (or need)?')
                .setRequired(true)
                .addChoices(
                    { name: 'Exp / Top / Clash', value: 'Exp/Top' },
                    { name: 'Jungle', value: 'Jungle' },
                    { name: 'Mid', value: 'Mid' },
                    { name: 'Marksman / ADC / Dragon', value: 'Marksman' },
                    { name: 'Roam / Support', value: 'Roam/Support' },
                    { name: 'Flex / Any', value: 'Flex' }
                ))
        .addStringOption(option => 
            option.setName('notes')
                .setDescription('Any extra information? (e.g. Mic required, server region)')
                .setRequired(false)),
        
    async execute(interaction) {
        const type = interaction.options.getString('type');
        const game = interaction.options.getString('game');
        const rank = interaction.options.getString('rank');
        const role = interaction.options.getString('role');
        const notes = interaction.options.getString('notes') || 'No additional notes provided.';

        const isSolo = type === 'solo';

        const embed = new EmbedBuilder()
            .setTitle(isSolo ? '🔍 Player Looking For Team' : '📢 Team Looking For Player')
            .setColor(isSolo ? '#2ecc71' : '#e67e22')
            .setThumbnail(interaction.user.displayAvatarURL())
            .addFields(
                { name: 'Game', value: game, inline: true },
                { name: 'Rank', value: rank, inline: true },
                { name: 'Role', value: role, inline: true },
                { name: 'Notes', value: notes }
            )
            .setFooter({ text: `Posted by ${interaction.user.tag}` });

        // customId stores "lfg_" + the type + "_" + the user's ID
        const customId = `lfg_${type}_${interaction.user.id}`;

        const button = new ButtonBuilder()
            .setCustomId(customId)
            .setLabel(isSolo ? 'Recruit Player' : 'Request to Join')
            .setStyle(ButtonStyle.Primary)
            .setEmoji(isSolo ? '🤝' : '📩');

        const row = new ActionRowBuilder().addComponents(button);

        await interaction.reply({ embeds: [embed], components: [row] });
    },
};

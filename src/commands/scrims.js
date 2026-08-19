const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getOpenScrims, discordTime, SITE_URL } = require('../lib/mspApi');

/**
 * /scrims -- who is looking for a practice match.
 *
 * Public by default for the same reason as /tournaments: finding an
 * opponent is inherently a broadcast, and a scrim listed to one person is
 * a scrim that does not get filled.
 *
 * The game choices mirror /lfg's rather than inventing a second vocabulary
 * for the same three games.
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('scrims')
        .setDescription('List open scrims looking for an opponent.')
        .addStringOption(option =>
            option.setName('game')
                .setDescription('Only show scrims for one game')
                .setRequired(false)
                .addChoices(
                    { name: 'Mobile Legends', value: 'Mobile Legends' },
                    { name: 'Honor of Kings', value: 'Honor of Kings' },
                    { name: 'LOL Wild Rift', value: 'Wild Rift' }
                ))
        .addBooleanOption(option =>
            option.setName('private')
                .setDescription('Show the result only to you (default: visible to the channel)')
                .setRequired(false)),

    async execute(interaction) {
        const game = interaction.options.getString('game');
        const isPrivate = interaction.options.getBoolean('private') === true;
        await interaction.deferReply({ ephemeral: isPrivate });

        const rows = await getOpenScrims(game, 8);

        if (rows === null) {
            await interaction.editReply(
                `Couldn't reach MSP just now. The board is still on the site: ${SITE_URL}/#/scrims`
            );
            return;
        }

        if (!rows.length) {
            // Name the filter back, so an empty result is obviously "none
            // for THAT game" rather than "the feature is broken".
            await interaction.editReply(
                (game ? `No open ${game} scrims right now.` : 'No open scrims right now.') +
                `\nPost one: ${SITE_URL}/#/scrims`
            );
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(0xA855F7)
            .setTitle(game ? `Open ${game} scrims` : 'Open scrims')
            .setURL(`${SITE_URL}/#/scrims`)
            .setFooter({ text: 'MSP — MOBA e-Sports Platform' })
            .setTimestamp();

        for (const s of rows) {
            const when = discordTime(s.scheduledAt);
            const lines = [
                [s.game, s.region].filter(Boolean).join(' · '),
                s.rankRange ? `📊 ${s.rankRange}` : null,
                when ? `🕒 ${when}` : '🕒 Flexible',
                `[Challenge](${SITE_URL}/#/scrim?id=${encodeURIComponent(s.id)})`
            ].filter(Boolean);

            embed.addFields({ name: s.hostSquad, value: lines.join('\n'), inline: false });
        }

        await interaction.editReply({ embeds: [embed] });
    }
};

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getOpenTournaments, discordTime, SITE_URL } = require('../lib/mspApi');

/**
 * /tournaments -- what is open to register for, right now.
 *
 * Defaults to public, unlike /mymatch: this is shared information, and the
 * whole point is that one person running it puts the list in front of the
 * whole channel. A scrim partner asking "anything on this weekend?" should
 * get an answer everyone can see.
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('tournaments')
        .setDescription('List MSP tournaments currently open for registration.')
        .addBooleanOption(option =>
            option.setName('private')
                .setDescription('Show the result only to you (default: visible to the channel)')
                .setRequired(false)),

    async execute(interaction) {
        const isPrivate = interaction.options.getBoolean('private') === true;
        await interaction.deferReply({ ephemeral: isPrivate });

        const rows = await getOpenTournaments(8);

        if (rows === null) {
            await interaction.editReply(
                `Couldn't reach MSP just now. The list is still on the site: ${SITE_URL}/#/tournaments`
            );
            return;
        }

        if (!rows.length) {
            await interaction.editReply(
                `Nothing is open for registration at the moment.\n${SITE_URL}/#/tournaments`
            );
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(0x45F3FF)
            .setTitle('Open for registration')
            .setURL(`${SITE_URL}/#/tournaments`)
            .setFooter({ text: 'MSP — MOBA e-Sports Platform' })
            .setTimestamp();

        for (const t of rows) {
            const slots = `${t.registered}/${t.participants} teams`;
            const lines = [
                `${t.game}${t.teamSize ? ` · ${t.teamSize}v${t.teamSize}` : ''} · ${slots}`,
                t.prize ? `🏆 ${t.prize}` : null,
                // startDate is a plain date, so the relative form ("in 3 days")
                // is the useful half -- the exact clock time is meaningless
                // for something that has not been scheduled to the hour.
                t.startDate ? `🗓️ ${discordTime(t.startDate) || t.startDate}` : null,
                // Say it plainly rather than leaving someone to compare two
                // numbers and work it out.
                t.isFull ? '⛔ **Full** — registration is closed in practice' : null,
                `[Open](${SITE_URL}/#/tournament?id=${encodeURIComponent(t.id)})`
            ].filter(Boolean);

            embed.addFields({ name: t.name, value: lines.join('\n'), inline: false });
        }

        await interaction.editReply({ embeds: [embed] });
    }
};

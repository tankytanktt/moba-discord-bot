const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getMatchesForDiscordUser, discordTime, SITE_URL } = require('../lib/mspApi');

/**
 * /mymatch -- "when do I play next?", answered without leaving Discord.
 *
 * No linking step, no account connect flow -- the player is identified by
 * what MSP already recorded at registration. That is two different things
 * depending on where you sit on the roster: a captain is stored as a
 * verified Discord snowflake, while the other players are stored as the
 * username the captain typed into the "Discord Username" field. Both are
 * sent, and the RPC checks each against the one it actually holds.
 *
 * Ephemeral by default. A roster's schedule is not something to dump into a
 * public channel every time someone checks, and it keeps the command usable
 * mid-conversation without derailing it.
 */
module.exports = {
    data: new SlashCommandBuilder()
        .setName('mymatch')
        .setDescription('Show your upcoming MSP matches -- opponent, time and room code.')
        .addBooleanOption(option =>
            option.setName('public')
                .setDescription('Post the result visibly in this channel (default: only you can see it)')
                .setRequired(false)),

    async execute(interaction) {
        const isPublic = interaction.options.getBoolean('public') === true;
        // Defer immediately: the round trip to Supabase can outrun Discord's
        // 3-second reply deadline, especially on a cold start.
        await interaction.deferReply({ ephemeral: !isPublic });

        // Id and username both: the captain is stored by snowflake, roster
        // members by the username typed at registration. See mspApi.
        const rows = await getMatchesForDiscordUser(
            interaction.user.id,
            interaction.user.username,
            5
        );

        // null means the lookup itself failed -- distinct from "you have no
        // matches", and the player should not be told the latter when we
        // simply could not check.
        if (rows === null) {
            await interaction.editReply(
                "Couldn't reach MSP just now, so I can't tell you your schedule. Try again in a moment — " +
                `if it keeps failing, the site still has it: ${SITE_URL}/#/my-matches`
            );
            return;
        }

        if (!rows.length) {
            await interaction.editReply(
                "No upcoming matches for you.\n\n" +
                "That means one of: your team isn't approved yet, the bracket hasn't been generated, " +
                "or every match you're in has already been played.\n" +
                `Browse what's open: ${SITE_URL}/#/tournaments`
            );
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(0x45F3FF)
            .setTitle(rows.length === 1 ? 'Your next match' : `Your next ${rows.length} matches`)
            .setFooter({ text: 'MSP — MOBA e-Sports Platform' })
            .setTimestamp();

        for (const m of rows) {
            const when = discordTime(m.scheduleTime);
            const lines = [
                `**vs ${m.opponent}**`,
                `${m.tournamentName} · ${m.stage}`,
                when ? `🕒 ${when}` : '🕒 Not scheduled yet',
            ];
            // Only surface these when the organizer has actually set them --
            // an empty "Room:" line is worse than no line.
            if (m.room)  lines.push(`🔑 Room \`${m.room}\``);
            if (m.venue) lines.push(`📍 ${m.venue}`);
            lines.push(`[Open bracket](${SITE_URL}/#/tournament?id=${encodeURIComponent(m.tournamentId)}&tab=bracket)`);

            embed.addFields({
                name: `${m.myTeam} — Match ${m.matchNum}`,
                value: lines.join('\n'),
                inline: false
            });
        }

        await interaction.editReply({ embeds: [embed] });
    }
};

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getPartners, SITE_URL } = require('../lib/mspApi');

/**
 * /partners -- who MSP's partnered creators are, and where to watch them.
 *
 * Public by default, like /tournaments: the entire point of a partner
 * spotlight is that other people see it. The `private` option exists only
 * so someone can check the list mid-conversation without derailing it.
 *
 * The backing RPC returns active partners in the same displayOrder the
 * website's Home spotlight uses, so the two can never disagree about who
 * the partners are or what order they come in. It deliberately does NOT
 * return capabilities or Discord ids -- who has access to which MSP
 * feature is nobody else's business, and this is a public channel.
 */

// Each platform gets its own verb. "Watch" is wrong for a site link and
// "Visit" is limp for a live stream, and getting that right costs one
// lookup table.
const PLATFORM_VERB = {
    Twitch:  'Watch on Twitch',
    YouTube: 'Watch on YouTube',
    Kick:    'Watch on Kick'
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('partners')
        .setDescription("List MSP's partnered creators.")
        .addBooleanOption(option =>
            option.setName('private')
                .setDescription('Show the result only to you (default: visible to the channel)')
                .setRequired(false)),

    async execute(interaction) {
        const isPrivate = interaction.options.getBoolean('private') === true;
        await interaction.deferReply({ ephemeral: isPrivate });

        const rows = await getPartners(25);

        // null is "the lookup failed", which is not the same as "there are
        // no partners" -- saying the latter when we simply could not check
        // would be telling people something untrue about the business.
        if (rows === null) {
            await interaction.editReply(
                `Couldn't reach MSP just now. The partner list is on the site: ${SITE_URL}/`
            );
            return;
        }

        if (!rows.length) {
            await interaction.editReply(
                `No partners are listed yet. Interested in partnering with MSP? ${SITE_URL}/#/support`
            );
            return;
        }

        const embed = new EmbedBuilder()
            .setColor(0xFF007C)
            .setTitle(rows.length === 1 ? 'MSP Partner' : `MSP Partners (${rows.length})`)
            .setDescription('Creators partnered with MSP — go give them a follow.')
            .setURL(`${SITE_URL}/`)
            .setFooter({ text: 'MSP — MOBA e-Sports Platform' })
            .setTimestamp();

        // Discord caps an embed at 25 fields; the RPC already caps at 25,
        // so this cannot overflow -- the slice is belt and braces in case
        // that cap is ever raised on one side only.
        for (const p of rows.slice(0, 25)) {
            const verb = PLATFORM_VERB[p.platform] || 'Visit channel';
            // Only linkify a real http(s) URL. channelUrl is admin-entered
            // free text, and a malformed value would otherwise render as a
            // broken markdown link rather than something readable.
            const link = /^https?:\/\//i.test(p.channelUrl || '')
                ? `[${verb}](${p.channelUrl})`
                : (p.channelUrl || 'No channel link');

            const lines = [p.tagline, link].filter(Boolean);
            embed.addFields({ name: p.name, value: lines.join('\n'), inline: false });
        }

        // The first partner's avatar as the thumbnail: a spotlight embed
        // with a face in it reads as a feature rather than a directory.
        const firstAvatar = rows.find(p => /^https?:\/\//i.test(p.avatarUrl || ''));
        if (firstAvatar) embed.setThumbnail(firstAvatar.avatarUrl);

        await interaction.editReply({ embeds: [embed] });
    }
};

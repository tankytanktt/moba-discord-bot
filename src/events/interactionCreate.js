const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } = require('discord.js');

module.exports = {
    name: 'interactionCreate',
    async execute(interaction, client) {
        // --- 1. Handle Slash Commands ---
        if (interaction.isChatInputCommand()) {
            const command = client.commands.get(interaction.commandName);

            if (!command) return;

            try {
                await command.execute(interaction);
            } catch (error) {
                console.error(`Error executing ${interaction.commandName}:`, error);
                await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
            }
        }
        
        // --- 2. Handle String Select Menu (Game Selection) ---
        else if (interaction.isStringSelectMenu()) {
            if (interaction.customId === 'game_select') {
                const game = interaction.values[0];
                let embed = new EmbedBuilder().setColor('#3498db');
                let buttons = [];

                if (game === 'mlbb') {
                    embed.setTitle('Mobile Legends Roles')
                        .setDescription('Select your MLBB lanes:');
                    buttons = [
                        { id: 'default_Exp', label: 'Exp', emoji: '🛡️' },
                        { id: 'default_Jungle', label: 'Jungle', emoji: '🌲' },
                        { id: 'default_Mid', label: 'Mid', emoji: '🔥' },
                        { id: 'default_Marksman', label: 'Marksman', emoji: '🏹' },
                        { id: 'default_Roam', label: 'Roam', emoji: '❤️' }
                    ];
                } else if (game === 'hok') {
                    embed.setTitle('Honor of Kings Roles')
                        .setDescription('Select your HoK lanes:');
                    buttons = [
                        { id: 'default_Clash', label: 'Clash', emoji: '⚔️' },
                        { id: 'default_Jungle', label: 'Jungle', emoji: '🌲' },
                        { id: 'default_Mid', label: 'Mid', emoji: '🔥' },
                        { id: 'default_Marksman', label: 'Marksman', emoji: '🏹' },
                        { id: 'default_Roam', label: 'Roam', emoji: '❤️' }
                    ];
                } else if (game === 'wildrift') {
                    embed.setTitle('Wild Rift Roles')
                        .setDescription('Select your Wild Rift lanes:');
                    buttons = [
                        { id: 'default_Top', label: 'Top', emoji: '⛰️' },
                        { id: 'default_Jungle', label: 'Jungle', emoji: '🌲' },
                        { id: 'default_Mid', label: 'Mid', emoji: '🔥' },
                        { id: 'default_ADC', label: 'ADC', emoji: '🏹' },
                        { id: 'default_Support', label: 'Support', emoji: '❤️' }
                    ];
                }

                if (buttons.length > 0) {
                    const row = new ActionRowBuilder();
                    buttons.forEach(b => {
                        row.addComponents(
                            new ButtonBuilder()
                                .setCustomId(b.id)
                                .setLabel(b.label)
                                .setStyle(ButtonStyle.Primary)
                                .setEmoji(b.emoji)
                        );
                    });

                    // Reply ephemerally so only they see the buttons
                    await interaction.reply({ embeds: [embed], components: [row], ephemeral: true });
                }
            }
        }
        
        // --- 3. Handle Button Clicks ---
        else if (interaction.isButton()) {
            const { customId, guild, member } = interaction;
            let roleToAssign = null;
            let roleNameForReply = '';

            try {
                // If it's a custom mapped role (legacy support)
                if (customId.startsWith('assign_')) {
                    const roleId = customId.replace('assign_', '');
                    roleToAssign = guild.roles.cache.get(roleId);
                    
                    if (!roleToAssign) {
                        return await interaction.reply({ content: 'That role no longer exists in the server!', ephemeral: true });
                    }
                    roleNameForReply = roleToAssign.name;
                }
                
                // If it's a default role (default_Exp, default_Clash, etc)
                else if (customId.startsWith('default_')) {
                    const defaultName = customId.replace('default_', '');
                    
                    // Look for it by name
                    roleToAssign = guild.roles.cache.find(r => r.name === defaultName);
                    
                    // Auto-create it if it doesn't exist
                    if (!roleToAssign) {
                        roleToAssign = await guild.roles.create({
                            name: defaultName,
                            reason: 'Automatically created for Button Roles',
                        });
                    }
                    roleNameForReply = roleToAssign.name;
                }
                else {
                    return; // Not one of our buttons
                }

                // Check if the user already has the role
                if (member.roles.cache.has(roleToAssign.id)) {
                    await member.roles.remove(roleToAssign);
                    await interaction.reply({ content: `Removed the **${roleNameForReply}** role!`, ephemeral: true });
                } else {
                    await member.roles.add(roleToAssign);
                    await interaction.reply({ content: `Given the **${roleNameForReply}** role!`, ephemeral: true });
                }
            } catch (error) {
                console.error('Failed to handle button role:', error);
                await interaction.reply({ content: 'Failed to assign role. Make sure the bot has the "Manage Roles" permission and its role is placed higher than the role it is trying to assign!', ephemeral: true });
            }
        }
    },
};

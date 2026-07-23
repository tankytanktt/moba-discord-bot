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
        
        // --- 2. Handle Button Clicks ---
        else if (interaction.isButton()) {
            const { customId, guild, member } = interaction;
            let roleToAssign = null;
            let roleNameForReply = '';

            try {
                // If it's a custom mapped role (assign_123456789)
                if (customId.startsWith('assign_')) {
                    const roleId = customId.replace('assign_', '');
                    roleToAssign = guild.roles.cache.get(roleId);
                    
                    if (!roleToAssign) {
                        return await interaction.reply({ content: 'That role no longer exists in the server!', ephemeral: true });
                    }
                    roleNameForReply = roleToAssign.name;
                }
                
                // If it's a default role (default_Exp)
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

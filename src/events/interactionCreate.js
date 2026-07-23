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
            // Check if this button is part of our roles system
            if (interaction.customId.startsWith('role_')) {
                // Extract the role name from the customId (e.g., "role_top" -> "Top")
                const roleKey = interaction.customId.replace('role_', '');
                
                // Map the key to the actual Role Name we want to create/assign
                const roleNames = {
                    top: 'Top',
                    jungle: 'Jungle',
                    mid: 'Mid',
                    adc: 'ADC',
                    support: 'Support'
                };
                
                const roleName = roleNames[roleKey];
                if (!roleName) return;

                const { guild, member } = interaction;

                try {
                    // Find the role in the server
                    let role = guild.roles.cache.find(r => r.name === roleName);
                    
                    // If the role doesn't exist in the server yet, create it automatically!
                    if (!role) {
                        role = await guild.roles.create({
                            name: roleName,
                            reason: 'Automatically created for Button Roles',
                        });
                    }

                    // Check if the user already has the role
                    if (member.roles.cache.has(role.id)) {
                        // Remove it
                        await member.roles.remove(role);
                        await interaction.reply({ content: `Removed the **${roleName}** role!`, ephemeral: true });
                    } else {
                        // Add it
                        await member.roles.add(role);
                        await interaction.reply({ content: `Given the **${roleName}** role!`, ephemeral: true });
                    }
                } catch (error) {
                    console.error('Failed to handle button role:', error);
                    await interaction.reply({ content: 'Failed to assign role. Make sure the bot has the "Manage Roles" permission and its role is placed higher than the role it is trying to assign!', ephemeral: true });
                }
            }
        }
    },
};

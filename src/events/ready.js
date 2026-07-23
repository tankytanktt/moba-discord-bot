module.exports = {
    name: 'ready',
    once: true,
    execute(client) {
        console.log(`[Discord] Ready! Logged in as ${client.user.tag}`);
    },
};

import 'dotenv/config';

import {REST} from '@discordjs/rest';
import {Routes} from 'discord-api-types/v9';

const commands = [
    {
        name: 'join',
        description: 'Join voice channel'
    },
    {
        name: 'leave',
        description: 'Leave voice channel'
    }
];


const rest = new REST({ version: '9' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        console.log('Started refreshing application (/) commands.');

        await rest.put(Routes.applicationCommands(process.env.DISCORD_ID), {
            body: commands
        });

        console.log('Successfully reloaded application (/) commands.');
    } catch (error) {
        console.error(error);
    }
})();

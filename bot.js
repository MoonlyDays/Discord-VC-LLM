import 'dotenv/config';

import {Client, GatewayIntentBits} from 'discord.js';
import {createAudioPlayer, createAudioResource, EndBehaviorType, joinVoiceChannel} from '@discordjs/voice';
import {Readable} from 'stream';
import {ElevenLabsClient} from '@elevenlabs/elevenlabs-js';
import fs from 'fs';
import ffmpeg from 'fluent-ffmpeg';
import prism from 'prism-media';
import OpenAI from 'openai';

const elevenLabs = new ElevenLabsClient();
const chatGpt = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
});

let connection = null;

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

const TOKEN = process.env.DISCORD_TOKEN;
const botNames = process.env.BOT_TRIGGERS.split(',');
if (!Array.isArray(botNames)) {
    logToConsole('BOT_TRIGGERS must be an array of strings', 'error', 1);
    process.exit(1);
}

logToConsole(`Bot triggers: ${botNames}`, 'info', 1);
let chatHistory = {};
let allowWithoutBip = false;
let currentlyThinking = false;

// Create the directories if they don't exist
if (!fs.existsSync('./recordings')) {
    fs.mkdirSync('./recordings');
}
if (!fs.existsSync('./sounds')) {
    fs.mkdirSync('./sounds');
}

client.on('ready', () => {
    // Clean up any old recordings
    fs.readdir('./recordings', (err, files) => {
        if (err) {
            logToConsole('Error reading recordings directory', 'error', 1);
            return;
        }

        files.forEach((file) => {
            fs.unlinkSync(`./recordings/${file}`);
        });
    });

    logToConsole(`Logged in as ${client.user.tag}!`, 'info', 1);
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;

    const { commandName, options } = interaction;

    switch (commandName) {
        case 'join':
            const mode = options.getString('mode');
            // You join logic here, using `mode` as the option
            if (connection) {
                await interaction.reply({
                    content: 'I am already in a voice channel. Please use the `leave` command first.',
                    ephemeral: true
                });
                return;
            }

            allowWithoutBip = false;

            if (mode === 'silent') {
                allowWithoutBip = true;
            }

            if (interaction.member.voice.channel) {
                connection = joinVoiceChannel({
                    channelId: interaction.member.voice.channel.id,
                    guildId: interaction.guild.id,
                    adapterCreator: interaction.guild.voiceAdapterCreator,
                    selfDeaf: false
                });
                logToConsole('> Joined voice channel', 'info', 1);
                handleRecording(connection, interaction.member.voice.channel);
                await interaction.reply({
                    content: 'Joined voice channel.',
                    ephemeral: true
                });
            } else {
                await interaction.reply({
                    content: 'You need to join a voice channel first!',
                    ephemeral: true
                });
            }
            break;

        case 'leave':
            if (connection) {
                connection.destroy();


                connection = null;
                chatHistory = {};
                logToConsole('> Left voice channel', 'info', 1);
                await interaction.reply({
                    content: 'Left voice channel.',
                    ephemeral: true
                });
            } else {
                await interaction.reply({
                    content: 'I am not in a voice channel.',
                    ephemeral: true
                });
            }
            break;
    }
});

// If the bot is in voice channel and a user joins, start listening to them (except for itself)
client.on('voiceStateUpdate', (oldState, newState) => {
    // Check if the user has joined a new channel (and it's the specific channel the bot is in)
    // and ensure the user is not the bot itself
    if (
        connection &&
        oldState.channelId !== newState.channelId &&
        newState.channelId === connection.joinConfig.channelId &&
        newState.member.user.id !== client.user.id
    ) {
        // Additional check to ensure the user is not just unmuting/muting or performing other state changes
        if (newState.channelId !== null) {
            // User has joined the channel (not just updated their state in the same channel)
            logToConsole(
                `> User joined voice channel: ${newState.member.user.username}`,
                'info',
                1
            );
            handleRecordingForUser(
                newState.member.user.id,
                connection,
                newState.channel
            );
        }
    }
});

function handleRecording(connection, channel) {
    const receiver = connection.receiver;
    channel.members.forEach((member) => {
        if (member.user.bot) return;

        const filePath = `./recordings/${member.user.id}.pcm`;
        const writeStream = fs.createWriteStream(filePath);
        const listenStream = receiver.subscribe(member.user.id, {
            end: {
                behavior: EndBehaviorType.AfterSilence,
                duration: process.env.WAIT_TIME
            }
        });

        const opusDecoder = new prism.opus.Decoder({
            frameSize: 960,
            channels: 1,
            rate: 48000
        });

        listenStream.pipe(opusDecoder).pipe(writeStream);

        writeStream.on('finish', () => {
            logToConsole(`> Audio recorded for ${member.user.username}`, 'info', 2);
            convertAndHandleFile(filePath, member.user.id, connection, channel);
        });
    });
}

function handleRecordingForUser(userID, connection, channel) {
    const receiver = connection.receiver;

    const filePath = `./recordings/${userID}.pcm`;
    const writeStream = fs.createWriteStream(filePath);
    const listenStream = receiver.subscribe(userID, {
        end: {
            behavior: EndBehaviorType.AfterSilence,
            duration: process.env.WAIT_TIME
        }
    });

    const opusDecoder = new prism.opus.Decoder({
        frameSize: 960,
        channels: 1,
        rate: 48000
    });

    listenStream.pipe(opusDecoder).pipe(writeStream);

    writeStream.on('finish', () => {
        logToConsole(`> Audio recorded for ${userID}`, 'info', 2);
        convertAndHandleFile(filePath, userID, connection, channel);
    });
}

function convertAndHandleFile(filePath, userid, connection, channel) {
    const mp3Path = filePath.replace('.pcm', '.mp3');
    ffmpeg(filePath)
        .inputFormat('s16le')
        .audioChannels(1)
        .format('mp3')
        .on('error', (err) => {
            logToConsole(`X Error converting file: ${err.message}`, 'error', 1);
            currentlyThinking = false;
        })
        .save(mp3Path)
        .on('end', () => {
            logToConsole(`> Converted to MP3: ${mp3Path}`, 'info', 2);
            sendAudioToApi(mp3Path, userid, connection, channel).then();
        });
}

async function getAudioDuration(filePath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(filePath, (err, metadata) => {
            if (err) {
                reject(err);
                return;
            }
            resolve(metadata.format.duration);
        });
    });
}

async function sendAudioToApi(fileName, userId, connection, channel) {
    const duration = await getAudioDuration(fileName);
    if (duration < 2) {
        logToConsole(`> Audio too short (${duration}), ignoring`, 'info', 2);
        restartListening(userId, connection, channel);
        return;
    }

    console.log(`duration: ${duration} seconds`);

    try {
        const response = await chatGpt.audio.transcriptions.create({
            file: fs.createReadStream(fileName),
            model: 'whisper-1'
        });

        let transcription = response.text;
        logToConsole(
            `> Transcription for ${userId}: "${transcription}"`,
            'info',
            1
        );

        if (currentlyThinking) {
            logToConsole(
                '> Bot is already thinking, ignoring transcription.',
                'info',
                2
            );
            restartListening(userId, connection, channel);
            return;
        }

        // Check if the transcription includes the bot's name
        if (botNames.some((name) => transcription.toLowerCase().includes(name.toLowerCase()))) {
            // Ignore if the string is a single word
            if (transcription.split(' ').length <= 1) {
                currentlyThinking = false;
                logToConsole('> Ignoring single word command.', 'info', 2);
                restartListening(userId, connection, channel);
                return;
            }

            // Remove the first occurrence of the bot's name from the transcription
            for (const name of botNames) {
                transcription = transcription
                    .replace(new RegExp(`\\b${name}\\b`, 'i'), '')
                    .trim();
            }

            currentlyThinking = true;
            playSound(connection, 'understood').then();
            sendToChatGPT(transcription, userId, connection, channel).then();
            restartListening(userId, connection, channel);
        } else {
            currentlyThinking = false;
            logToConsole(
                '> Bot was not addressed directly. Ignoring the command.',
                'info',
                2
            );
            restartListening(userId, connection, channel);
        }
    } catch (error) {
        currentlyThinking = false;
        logToConsole(`X Failed to transcribe audio: ${error.message}`, 'error', 1);
        // Restart listening after an error
        restartListening(userId, connection, channel);
    } finally {
        // Ensure files are always deleted regardless of the transcription result
        try {
            fs.unlinkSync(fileName);
            const pcmPath = fileName.replace('.mp3', '.pcm'); // Ensure we have the correct .pcm path
            fs.unlinkSync(pcmPath);
        } catch (cleanupError) {
            // Log cleanup errors but continue
        }
    }
}

async function sendToChatGPT(transcription, userId, connection, channel) {
    let messages = chatHistory[userId] || [];

    // If this is the first message, add a system prompt
    if (messages.length === 0) {
        messages.push({
            role: 'system',
            content: process.env.LLM_SYSTEM_PROMPT
        });
    }

    // Add the user's message to the chat history
    messages.push({
        role: 'user',
        content: transcription
    });

    // Keep only the latest X messages
    const messageCount = messages.length;
    if (messageCount > process.env.MEMORY_SIZE) {
        messages = messages.slice(messageCount - process.env.MEMORY_SIZE);
    }

    try {
        const completion = await chatGpt.chat.completions.create({
            model: 'gpt-4.1-mini',
            messages: messages
        });

        const llmResponse = completion.choices[0].message.content;
        logToConsole(`> LLM Response: ${llmResponse}`, 'info', 1);

        // Store the LLM's response in the history
        messages.push({
            role: 'assistant',
            content: llmResponse
        });

        // Update the chat history
        chatHistory[userId] = messages;

        // Send response to TTS service
        playSound(connection, 'result').then();
        sendToTTS(llmResponse, userId, connection, channel).then();
    } catch (error) {
        currentlyThinking = false;
        logToConsole(
            `X Failed to communicate with LLM: ${error.message}`,
            'error',
            1
        );
    }
}

let audioQueue = [];

async function sendToTTS(text, userid, connection, channel) {
    const words = text.replace('*', '').split(' ');
    const maxChunkSize = 60; // Maximum words per chunk
    const punctuationMarks = ['.', '!', '?', ';', ':']; // Punctuation marks to look for
    const chunks = [];

    for (let i = 0; i < words.length;) {
        let end = Math.min(i + maxChunkSize, words.length); // Find the initial end of the chunk

        // If the initial end is not the end of the text, try to find a closer punctuation mark
        if (end < words.length) {
            let lastPunctIndex = -1;
            for (let j = i; j < end; j++) {
                if (punctuationMarks.includes(words[j].slice(-1))) {
                    lastPunctIndex = j;
                }
            }
            // If a punctuation mark was found, adjust the end to be after it
            if (lastPunctIndex !== -1) {
                end = lastPunctIndex + 1;
            }
        }

        // Create the chunk from i to the new end, then adjust i to start the next chunk
        chunks.push(words.slice(i, end).join(' '));
        i = end;
    }

    for (const chunk of chunks) {
        try {
            logToConsole('> Using ElevenLabs TTS', 'info', 2);

            const audioStream = await elevenLabs.textToSpeech.convert(process.env.ELEVENLABS_VOICE_ID, {
                text: chunk,
                modelId: process.env.ELEVENLABS_MODEL
            });

            // Convert ReadableStream to Buffer
            const audioChunks = [];
            const readable = Readable.from(audioStream);
            for await (const audioChunk of readable) {
                audioChunks.push(audioChunk);
            }
            const audioBuffer = Buffer.concat(audioChunks);

            // save the audio buffer to a file
            const filename = `./sounds/tts_${chunks.indexOf(chunk)}.mp3`;
            fs.writeFileSync(filename, audioBuffer);

            audioQueue.push({ file: filename, index: chunks.indexOf(chunk) });
            if (audioQueue.length === 1) {
                logToConsole('> Playing audio queue', 'info', 2);
                playAudioQueue(connection, channel, userid).then();
            }
        } catch (error) {
            currentlyThinking = false;
            logToConsole(
                `X Failed to send text to TTS: ${error.message}`,
                'error',
                1
            );
        }
    }
}

let currentIndex = 0;
let retryCount = 0;
const maxRetries = 5; // Maximum number of retries before giving up

async function playAudioQueue(connection, channel, userid) {
    // Sort the audioqueue based on the index to ensure the correct play order
    audioQueue.sort((a, b) => a.index - b.index);

    while (audioQueue.length > 0) {
        const audio = audioQueue.find((a) => a.index === currentIndex);
        if (audio) {
            // Create an audio player
            const player = createAudioPlayer();

            // Create an audio resource from a local file
            const resource = createAudioResource(audio.file);

            // Subscribe the connection to the player and play the resource
            connection.subscribe(player);
            player.play(resource);

            player.on('idle', async () => {
                // Delete the file after it's played
                try {
                    fs.unlinkSync(audio.file);
                } catch (err) {
                    logToConsole(`X Failed to delete file: ${err.message}`, 'error', 1);
                }

                // Remove the played audio from the queue
                audioQueue = audioQueue.filter((a) => a.index !== currentIndex);
                currentIndex++;
                retryCount = 0; // Reset retry count for the next index

                if (audioQueue.length > 0) {
                    await playAudioQueue(connection, channel, userid); // Continue playing
                } else {
                    currentlyThinking = false;
                    audioQueue = [];
                    currentIndex = 0;
                    retryCount = 0;
                    logToConsole('> Audio queue finished.', 'info', 2);
                }
            });

            player.on('error', (error) =>
                logToConsole(`Error: ${error.message}`, 'error', 1)
            );

            break; // Exit the while loop after setting up the player for the current index
        } else {
            // If the expected index is not found, wait 1 second and increase the retry count
            if (retryCount < maxRetries) {
                await new Promise((resolve) => setTimeout(resolve, 1000));
                retryCount++;
            } else {
                currentlyThinking = false;
                audioQueue = [];
                currentIndex = 0;
                retryCount = 0;
                logToConsole(
                    `X Failed to find audio with index ${currentIndex} after ${maxRetries} retries.`,
                    'error',
                    1
                );
                break; // Give up after exceeding retry limit
            }
        }
    }
}

async function playSound(connection, sound, volume = 1) {
    if ((allowWithoutBip) && sound !== 'command') {
        return;
    }

    // Check if the sound file exists
    if (!fs.existsSync(`./sounds/${sound}.mp3`)) {
        logToConsole(`X Sound file not found: ${sound}.mp3`, 'error', 1);
        return;
    }

    // Create a stream from the sound file using ffmpeg
    const stream = fs.createReadStream(`./sounds/${sound}.mp3`);
    const ffmpegStream = ffmpeg(stream)
        .audioFilters(`volume=${volume}`)
        .format('opus')
        .on('error', (err) => console.error(err))
        .stream();

    // Create an audio resource from the ffmpeg stream
    const resource = createAudioResource(ffmpegStream);
    const player = createAudioPlayer();

    // Subscribe the connection to the player and play the resource
    player.play(resource);
    connection.subscribe(player);

    player.on('error', (error) =>
        logToConsole(`Error: ${error.message}`, 'error', 1)
    );
    player.on('stateChange', (oldState, newState) => {
        if (newState.status === 'idle') {
            logToConsole('> Finished playing sound.', 'info', 2);
        }
    });
}

function restartListening(userID, connection, channel) {
    handleRecordingForUser(userID, connection, channel);
}

function logToConsole(message, level, type) {
    switch (level) {
        case 'info':
            if (process.env.LOG_TYPE >= type) {
                console.info(message);
            }
            break;
        case 'warn':
            if (process.env.LOG_TYPE >= type) {
                console.warn(message);
            }
            break;
        case 'error':
            console.error(message);
            break;
    }
}

client.login(TOKEN).then();

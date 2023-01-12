import {
    ActivityType,
    ApplicationCommandOptionType,
    ApplicationCommandType,
    ButtonStyle,
    ChannelType,
    Client,
    ComponentType,
    IntentsBitField,
    Interaction,
    Message,
    Partials,
    PermissionsBitField,
    User,
} from "discord.js";
import { MongoClient } from "mongodb";
import fetch from "node-fetch";
import {
    daedalus_route,
    daedalus_token,
    discord_token,
    mongodb_url,
} from "./config.js";

const dbclient = new MongoClient(mongodb_url);
await dbclient.connect();
const db = dbclient.db();

process.on("uncaughtException", console.error);

const client = new Client({
    intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.MessageContent,
    ],
    partials: [Partials.Channel],
    presence: {
        activities: [
            {
                name: "for banshares",
                type: ActivityType.Watching,
            },
        ],
    },
});

client.on("ready", async () => {
    await client.application.commands.set([
        {
            type: ApplicationCommandType.ChatInput,
            name: "setup",
            description: "set up the bot",
            dm_permission: false,
            options: [
                {
                    type: ApplicationCommandOptionType.Subcommand,
                    name: "logs",
                    description: "set the log output channel",
                    options: [
                        {
                            type: ApplicationCommandOptionType.Channel,
                            name: "channel",
                            description:
                                "the channel (leave blank to stop logging)",
                            channel_types: [
                                ChannelType.GuildText,
                                ChannelType.PrivateThread,
                                ChannelType.PublicThread,
                            ],
                        },
                    ],
                },
                {
                    type: ApplicationCommandOptionType.Subcommand,
                    name: "daedalus-sync",
                    description:
                        "enable/disable daedalus history API sync (add to user history on ban)",
                    options: [
                        {
                            type: ApplicationCommandOptionType.Boolean,
                            name: "enable",
                            description: "whether or not to enable",
                            required: true,
                        },
                    ],
                },
            ],
        },
    ]);

    console.log("TBB is ready.");
});

client.on("interactionCreate", async (interaction: Interaction) => {
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "setup") {
            const subcommand = interaction.options.getSubcommand();

            if (subcommand === "logs") {
                const channel = interaction.options.getChannel("channel");

                db.collection("settings").findOneAndUpdate(
                    { guild: interaction.guild.id },
                    channel
                        ? { $set: { logs: channel.id } }
                        : { $unset: { logs: 0 } },
                    { upsert: true }
                );

                await interaction.reply({
                    content: channel
                        ? `Set the logging channel to ${channel}.`
                        : "Unset the logging channel.",
                    ephemeral: true,
                });
            } else if (subcommand === "daedalus-sync") {
                const enable = interaction.options.getBoolean("enable");

                db.collection("settings").findOneAndUpdate(
                    { guild: interaction.guild.id },
                    { $set: { ddl: enable } },
                    { upsert: true }
                );

                await interaction.reply({
                    content: `${
                        enable ? "Enabled" : "Disabled"
                    } Daedalus API sync.`,
                    ephemeral: true,
                });
            }
        }
    } else if (interaction.isButton()) {
        if (interaction.customId === "execute-banshare") {
            const member = await interaction.guild.members.fetch(
                interaction.user
            );

            if (!member.permissions.has(PermissionsBitField.Flags.BanMembers)) {
                await interaction.reply({
                    content: "You do not have permission to ban members.",
                    ephemeral: true,
                });

                return;
            }

            await interaction.reply({
                content: "Fetching users...",
                ephemeral: true,
            });

            const message = await interaction.message.fetchReference();
            const users = [];

            for (const match of message.content
                .split("\n")[0]
                .matchAll(/\d+/g)) {
                try {
                    users.push(await client.users.fetch(match[0]));
                } catch {}
            }

            await interaction.editReply({
                content: `Confirm banning ${users.join(", ")}?`,
                components: [
                    {
                        type: ComponentType.ActionRow,
                        components: [
                            {
                                type: ComponentType.Button,
                                style: ButtonStyle.Secondary,
                                custom_id: "confirm-execute",
                                label: "CONFIRM",
                            },
                        ],
                    },
                ],
            });
        } else if (interaction.customId === "confirm-execute") {
            const settings = await db
                .collection("settings")
                .findOne({ guild: interaction.guild.id });

            const entry = await db
                .collection("executed")
                .findOneAndUpdate(
                    { message: interaction.message.reference.messageId },
                    { $set: { executed: true } },
                    { upsert: true }
                );

            if (entry.value?.executed) {
                await interaction.update({
                    content: "This banshare was already executed.",
                    components: [],
                });

                return;
            }

            const prompt = await interaction.message.fetchReference();

            try {
                await prompt.edit({
                    components: [
                        {
                            type: ComponentType.ActionRow,
                            components: [
                                {
                                    type: ComponentType.Button,
                                    style: ButtonStyle.Secondary,
                                    custom_id: ".",
                                    label: "BAN",
                                    disabled: true,
                                },
                            ],
                        },
                    ],
                });
            } catch {}

            await interaction.update({ content: "Banning...", components: [] });

            const banned: User[] = [];
            const notfound: string[] = [];
            const failed: User[] = [];

            const message = await prompt.fetchReference();

            for (const match of message.content
                .split("\n")[0]
                .matchAll(/\d+/g)) {
                try {
                    const user = await client.users.fetch(match[0]);

                    try {
                        await interaction.guild.bans.create(user);
                        banned.push(user);

                        if (settings?.ddl) {
                            try {
                                const response = await fetch(
                                    `${daedalus_route}/moderation/history/${interaction.guild.id}/user/${user.id}`,
                                    {
                                        method: "post",
                                        headers: {
                                            Authorization: `Bearer ${daedalus_token}`,
                                            "Content-Type": "application/json",
                                        },
                                        body: JSON.stringify({
                                            type: "ban",
                                            duration: 0,
                                            origin: message.url,
                                            reason:
                                                "TCN Banshare: " +
                                                    message.content
                                                        .match(
                                                            /\n\*\*reason\(s\):\*\* (.+)\n\*\*evidence:\*\*/
                                                        )[1]
                                                        ?.trim()
                                                        .substring(0, 498) ??
                                                "(missing reason)",
                                        }),
                                    }
                                );

                                if (!response.ok)
                                    console.error(
                                        response.status,
                                        await response.json()
                                    );
                            } catch {}
                        }
                    } catch {
                        failed.push(user);
                    }
                } catch {
                    notfound.push(match[0]);
                }
            }

            await interaction.editReply(
                `Banned ${banned.length}, Not Found ${notfound.length}, Failed ${failed.length}`
            );

            if (settings?.logs) {
                try {
                    const channel = await interaction.guild.channels.fetch(
                        settings.logs
                    );

                    if (!channel.isTextBased()) throw 0;

                    try {
                        await channel.send(
                            `Banshare Executed.\n\nSuccess: ${
                                banned.join(", ") || "(none)"
                            }\nFailed: ${
                                failed.join(", ") || "(none)"
                            }\nNot Found: ${notfound.join(", ") || "(none)"}`
                        );
                    } catch {
                        await channel.send({
                            files: [
                                {
                                    attachment: Buffer.from(
                                        `Banshare Executed.\n\nSuccess: ${
                                            banned
                                                .map(
                                                    (x) => `${x.tag} (${x.id})`
                                                )
                                                .join(", ") || "(none)"
                                        }\nFailed: ${
                                            failed
                                                .map(
                                                    (x) => `${x.tag} (${x.id})`
                                                )
                                                .join(", ") || "(none)"
                                        }\nNot Found: ${
                                            notfound.join(", ") || "(none)"
                                        }`,
                                        "utf-8"
                                    ),
                                    name: "banshare.txt",
                                },
                            ],
                        });
                    }
                } catch {}
            }
        }
    }
});

client.on("messageCreate", async (message: Message) => {
    if (message.reference?.channelId !== "1062742027269316719") return;
    if (!message.content.match(/^\*\*user id\(s\):\*\*(\s+\d+)+/)) return;

    try {
        await message.reply({
            components: [
                {
                    type: ComponentType.ActionRow,
                    components: [
                        {
                            type: ComponentType.Button,
                            style: ButtonStyle.Secondary,
                            custom_id: "execute-banshare",
                            label: "BAN",
                        },
                    ],
                },
            ],
        });
    } catch {}
});

await client.login(discord_token);

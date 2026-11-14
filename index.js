
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ActivityType
} = require("discord.js");

require("dotenv").config();

const http = require("node:http");
const dns = require("node:dns").promises;
const net = require("node:net");

// =====================================
// RENDER WEB SERVER
// =====================================

const PORT = process.env.PORT || 3000;

const server = http.createServer((req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8"
  });

  res.end("𝐋𝐚𝐫𝐢𝐤𝐚 BOT is running!");
});

server.on("error", error => {
  console.error("[LARIKA] Web Server Error:", error);
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[LARIKA] Web Server running on port ${PORT}`);
});

// =====================================
// DISCORD CLIENT
// =====================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// =====================================
// LARIKA CONFIGURATION
// =====================================

const CONFIG = {
  name: "𝐋𝐚𝐫𝐢𝐤𝐚 BOT",
  color: 0x17151F,
  accent: 0x9B5CFF,
  maxLinks: 3,
  timeout: 8000
};

const URL_REGEX = /https?:\/\/[^\s<>()]+/gi;

const IMAGE_REGEX =
  /\.(png|jpe?g|gif|webp|avif|bmp)(\?.*)?$/i;

const INVITE_REGEX =
  /^(?:https?:\/\/)?(?:www\.)?(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)([a-zA-Z0-9-]+)/i;

const processed = new Set();

// =====================================
// HELPERS
// =====================================

function cleanURL(url) {
  return url.replace(/[.,!?;:'"\]}>]+$/g, "");
}

function getURLs(content) {
  return [
    ...new Set(
      (content.match(URL_REGEX) || []).map(cleanURL)
    )
  ].slice(0, CONFIG.maxLinks);
}

function truncate(text, length = 4000) {
  if (!text) return "";

  return text.length > length
    ? text.slice(0, length - 1) + "…"
    : text;
}

function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);

    return (
      p[0] === 10 ||
      p[0] === 127 ||
      p[0] === 0 ||
      p[0] >= 224 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168)
    );
  }

  if (net.isIPv6(ip)) {
    const a = ip.toLowerCase();

    return (
      a === "::" ||
      a === "::1" ||
      a.startsWith("fc") ||
      a.startsWith("fd") ||
      a.startsWith("fe8") ||
      a.startsWith("fe9") ||
      a.startsWith("fea") ||
      a.startsWith("feb") ||
      a.startsWith("::ffff:127.") ||
      a.startsWith("::ffff:10.") ||
      a.startsWith("::ffff:192.168.")
    );
  }

  return true;
}

// =====================================
// URL SECURITY
// =====================================

async function checkURL(value) {
  const url = new URL(value);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Invalid protocol");
  }

  if (url.username || url.password) {
    throw new Error("Invalid URL credentials");
  }

  const host = url.hostname.toLowerCase();

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    throw new Error("Private host");
  }

  if (net.isIP(host)) {
    if (isPrivateIP(host)) {
      throw new Error("Private IP");
    }
  } else {
    const records = await dns.lookup(host, {
      all: true
    });

    if (
      !records.length ||
      records.some(record => isPrivateIP(record.address))
    ) {
      throw new Error("Private host");
    }
  }

  return url;
}

async function safeFetch(value) {
  let current = value;

  for (let i = 0; i < 4; i++) {
    await checkURL(current);

    const response = await fetch(current, {
      redirect: "manual",
      signal: AbortSignal.timeout(CONFIG.timeout),
      headers: {
        "User-Agent": "LarikaBot/1.0",
        "Accept": "text/html,image/*,*/*"
      }
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");

      if (!location) {
        throw new Error("Invalid redirect");
      }

      current = new URL(location, current).toString();
      continue;
    }

    return {
      response,
      url: current
    };
  }

  throw new Error("Too many redirects");
}

// =====================================
// HTML HELPERS
// =====================================

function meta(html, key) {
  const escaped = key.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&"
  );

  const patterns = [
    new RegExp(
      `<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["']`,
      "i"
    ),
    new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`,
      "i"
    )
  ];

  for (const pattern of patterns) {
    const match = html.match(pattern);

    if (match) return match[1].trim();
  }

  return "";
}

function decodeHTML(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function absoluteURL(value, base) {
  try {
    const url = new URL(value, base);

    return ["http:", "https:"].includes(url.protocol)
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}

// =====================================
// WEBSITE PREVIEW
// =====================================

async function websitePreview(link) {
  const { response, url } = await safeFetch(link);

  if (!response.ok) {
    throw new Error(`Website unavailable: ${response.status}`);
  }

  const type = (
    response.headers.get("content-type") || ""
  ).toLowerCase();

  if (!type.includes("text/html")) {
    throw new Error("Not an HTML website");
  }

  const html = (
    await response.text()
  ).slice(0, 1000000);

  let title =
    meta(html, "og:title") ||
    meta(html, "twitter:title");

  if (!title) {
    const match = html.match(
      /<title[^>]*>([\s\S]*?)<\/title>/i
    );

    title = match
      ? match[1].replace(/<[^>]+>/g, "")
      : "";
  }

  const description =
    meta(html, "og:description") ||
    meta(html, "description") ||
    meta(html, "twitter:description");

  const image = absoluteURL(
    meta(html, "og:image") ||
    meta(html, "twitter:image"),
    url
  );

  const embed = new EmbedBuilder()
    .setColor(CONFIG.color)
    .setTitle(
      truncate(
        decodeHTML(title || new URL(url).hostname),
        256
      )
    )
    .setURL(url)
    .setDescription(
      truncate(
        decodeHTML(
          description || "معاينة الموقع بواسطة Larika"
        ),
        4000
      )
    )
    .setFooter({
      text: "𝐋𝐚𝐫𝐢𝐤𝐚 BOT • Website Preview"
    });

  if (image) {
    embed.setImage(image);
  }

  return embed;
}

// =====================================
// IMAGE PREVIEW
// =====================================

async function imagePreview(link) {
  const { response, url } = await safeFetch(link);

  const type = (
    response.headers.get("content-type") || ""
  ).toLowerCase();

  if (!response.ok || !type.startsWith("image/")) {
    throw new Error("Invalid image");
  }

  return new EmbedBuilder()
    .setColor(CONFIG.color)
    .setTitle("معاينة صورة")
    .setURL(url)
    .setImage(url)
    .setFooter({
      text: "𝐋𝐚𝐫𝐢𝐤𝐚 BOT • Image Preview"
    });
}

// =====================================
// DISCORD INVITE PREVIEW
// =====================================

async function invitePreview(link, code) {
  const invite = await client.fetchInvite(code, {
    withCounts: true
  });

  const guild = invite.guild;

  if (!guild) {
    throw new Error("Invalid invitation");
  }

  const embed = new EmbedBuilder()
    .setColor(CONFIG.color)
    .setTitle(
      truncate(guild.name || "Discord Server", 256)
    )
    .setURL(invite.url || link)
    .setDescription("دعوة للانضمام إلى سيرفر ديسكورد")
    .addFields(
      {
        name: "الأعضاء",
        value: String(
          invite.approximateMemberCount ?? "غير متاح"
        ),
        inline: true
      },
      {
        name: "المتصلون",
        value: String(
          invite.approximatePresenceCount ?? "غير متاح"
        ),
        inline: true
      }
    )
    .setFooter({
      text: "𝐋𝐚𝐫𝐢𝐤𝐚 BOT • Discord Preview"
    });

  const icon = guild.iconURL({
    size: 512
  });

  if (icon) {
    embed.setThumbnail(icon);
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("انضم إلى السيرفر")
      .setStyle(ButtonStyle.Link)
      .setURL(invite.url || link)
  );

  return {
    embed,
    row
  };
}

// =====================================
// PREVIEW ENGINE
// =====================================

async function createPreview(link) {
  const invite = link.match(INVITE_REGEX);

  if (invite) {
    return invitePreview(link, invite[1]);
  }

  if (IMAGE_REGEX.test(link)) {
    return {
      embed: await imagePreview(link)
    };
  }

  // Important: website previews must also return an embed object.
  return {
    embed: await websitePreview(link)
  };
}

// =====================================
// BOT READY
// =====================================

client.once("ready", () => {
  console.log("--------------------------------");
  console.log("𝐋𝐚𝐫𝐢𝐤𝐚 BOT ONLINE");
  console.log("Bot:", client.user.tag);
  console.log("Bot ID:", client.user.id);
  console.log("Servers:", client.guilds.cache.size);
  console.log("--------------------------------");

  client.user.setActivity("Automatic Previews", {
    type: ActivityType.Watching
  });
});

// =====================================
// MESSAGE SYSTEM
// =====================================

client.on("messageCreate", async message => {
  if (!message.guild) return;
  if (message.author.bot) return;
  if (message.webhookId) return;

  if (processed.has(message.id)) return;

  const links = getURLs(message.content);

  const attachments = [
    ...message.attachments.values()
  ].filter(file =>
    file.contentType?.startsWith("image/")
  );

  if (!links.length && !attachments.length) return;

  processed.add(message.id);

  try {
    const embeds = [];
    let inviteRow = null;

    for (const link of links) {
      try {
        console.log("[LARIKA] Processing:", link);

        const result = await createPreview(link);

        if (result?.embed) {
          embeds.push(result.embed);
        }

        if (result?.row && !inviteRow) {
          inviteRow = result.row;
        }
      } catch (error) {
        console.log(
          "[LARIKA] Preview skipped:",
          error.message
        );
      }
    }

    for (const file of attachments) {
      if (embeds.length >= 10) break;

      embeds.push(
        new EmbedBuilder()
          .setColor(CONFIG.color)
          .setTitle("معاينة صورة")
          .setImage(file.url)
          .setFooter({
            text: "𝐋𝐚𝐫𝐢𝐤𝐚 BOT • Image Preview"
          })
      );
    }

    if (!embeds.length) return;

    await message.reply({
      embeds: embeds.slice(0, 10),
      components: inviteRow ? [inviteRow] : [],
      allowedMentions: {
        parse: []
      },
      failIfNotExists: false
    });

    console.log("[LARIKA] Preview sent successfully");

  } catch (error) {
    console.error("[LARIKA] Preview error:", error);
  }
});

// =====================================
// CLEANUP
// =====================================

setInterval(() => {
  processed.clear();
}, 60 * 60 * 1000).unref();

// =====================================
// DISCORD ERRORS
// =====================================

client.on("error", error => {
  console.error("[LARIKA] Discord Error:", error);
});

client.on("shardError", error => {
  console.error("[LARIKA] Shard Error:", error);
});

client.on("warn", warning => {
  console.warn("[LARIKA] Discord Warning:", warning);
});

process.on("unhandledRejection", error => {
  console.error("[LARIKA] Unhandled Rejection:", error);
});

process.on("uncaughtException", error => {
  console.error("[LARIKA] Uncaught Exception:", error);
});

// =====================================
// DISCORD LOGIN
// =====================================

async function startBot() {
  console.log("--------------------------------");
  console.log("[LARIKA] Starting Discord login...");

  const token = process.env.DISCORD_TOKEN?.trim();

  console.log(
    "[LARIKA] DISCORD_TOKEN exists:",
    Boolean(token)
  );

  if (!token) {
    console.error("[LARIKA] DISCORD_TOKEN is missing!");
    return;
  }

  try {
    await client.login(token);

    console.log("[LARIKA] Login request accepted");
  } catch (error) {
    console.error("--------------------------------");
    console.error("[LARIKA] DISCORD LOGIN FAILED");
    console.error("Error name:", error.name);
    console.error("Error code:", error.code);
    console.error("Error message:", error.message);
    console.error("--------------------------------");
  }
}

startBot();


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
const fs = require("node:fs");
const path = require("node:path");

// =====================================
// CONFIGURATION
// =====================================

const CONFIG_PATH = path.join(__dirname, "config.json");

function loadConfig() {
  try {
    const data = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));

    return {
      name: data.name || "𝐋𝐚𝐫𝐢𝐤𝐚 BOT",
      color: /^#[0-9a-f]{6}$/i.test(data.embedColor || "")
        ? parseInt(data.embedColor.slice(1), 16)
        : 0x17151F,
      accent: /^#[0-9a-f]{6}$/i.test(data.accentColor || "")
        ? parseInt(data.accentColor.slice(1), 16)
        : 0x9B5CFF,
      maxLinks: Math.max(1, Math.min(10, Number(data.maxLinks) || 3)),
      websitePreview: data.websitePreview !== false,
      imagePreview: data.imagePreview !== false,
      discordInvitePreview: data.discordInvitePreview !== false,
      replyUnderMessage: data.replyUnderMessage !== false,
      ignoreBots: data.ignoreBots !== false,
      ignoreWebhooks: data.ignoreWebhooks !== false,
      timeout: Math.max(3000, Math.min(20000, Number(data.timeout) || 8000)),
      maxHtmlBytes: Math.max(100000, Math.min(2000000, Number(data.maxHtmlBytes) || 1000000)),
      maxImageBytes: Math.max(100000, Math.min(15000000, Number(data.maxImageBytes) || 8000000)),
      maxRedirects: Math.max(0, Math.min(8, Number(data.maxRedirects) ?? 4)),
      preventDuplicatePreviews: data.preventDuplicatePreviews !== false,
      enableLogs: data.enableLogs !== false
    };
  } catch (error) {
    console.error("[LARIKA] Config error:", error.message);
    throw error;
  }
}

const CONFIG = loadConfig();

function log(...args) {
  if (CONFIG.enableLogs) console.log("[LARIKA]", ...args);
}

// =====================================
// HTTP SERVER - RENDER
// =====================================

const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({
      service: "Larika",
      web: "online",
      discord: client?.isReady() ? "connected" : "connecting"
    }));
  }

  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8"
  });

  res.end("𝐋𝐚𝐫𝐢𝐤𝐚 BOT is running!");
});

server.on("error", error => {
  console.error("[LARIKA] HTTP server error:", error);
});

server.listen(PORT, "0.0.0.0", () => {
  log(`Web Server running on port ${PORT}`);
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
// CONSTANTS
// =====================================

const URL_REGEX = /https?:\/\/[^\s<>()]+/gi;

const IMAGE_REGEX =
  /\.(png|jpe?g|gif|webp|avif|bmp)(\?.*)?$/i;

const INVITE_REGEX =
  /^(?:https?:\/\/)?(?:www\.)?(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)([a-zA-Z0-9-]+)/i;

const processed = new Map();
const MAX_PROCESSED = 10000;

function cleanURL(url) {
  return url.replace(/[.,!?;:'"\]}>]+$/g, "");
}

function getURLs(content) {
  return [
    ...new Set((content.match(URL_REGEX) || []).map(cleanURL))
  ].slice(0, CONFIG.maxLinks);
}

function truncate(value, length = 4000) {
  if (!value) return "";
  return value.length > length
    ? value.slice(0, length - 1) + "…"
    : value;
}

// =====================================
// IP SECURITY
// =====================================

function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);

    return (
      p[0] === 0 ||
      p[0] === 10 ||
      p[0] === 127 ||
      p[0] >= 224 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
    );
  }

  if (net.isIPv6(ip)) {
    const a = ip.toLowerCase();

    if (a.startsWith("::ffff:")) {
      const mapped = a.slice(7);
      if (net.isIPv4(mapped)) return isPrivateIP(mapped);
    }

    return (
      a === "::" ||
      a === "::1" ||
      a.startsWith("fc") ||
      a.startsWith("fd") ||
      a.startsWith("fe8") ||
      a.startsWith("fe9") ||
      a.startsWith("fea") ||
      a.startsWith("feb") ||
      a.startsWith("2001:db8:")
    );
  }

  return true;
}

async function checkURL(value) {
  const url = new URL(value);

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Invalid protocol");
  }

  if (url.username || url.password) {
    throw new Error("URL credentials blocked");
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  ) {
    throw new Error("Private hostname blocked");
  }

  if (net.isIP(host)) {
    if (isPrivateIP(host)) throw new Error("Private IP blocked");
  } else {
    const records = await dns.lookup(host, { all: true, verbatim: true });

    if (
      !records.length ||
      records.some(record => isPrivateIP(record.address))
    ) {
      throw new Error("Private DNS destination blocked");
    }
  }

  return url;
}

// =====================================
// SAFE FETCH
// =====================================

async function safeFetch(value, options = {}) {
  let current = value;

  for (let i = 0; i <= CONFIG.maxRedirects; i++) {
    const url = await checkURL(current);

    const response = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(CONFIG.timeout),
      headers: {
        "User-Agent": "LarikaBot/1.0",
        "Accept": options.accept || "text/html,image/*,*/*"
      }
    });

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");

      await response.body?.cancel();

      if (!location) throw new Error("Invalid redirect");

      current = new URL(location, url).toString();
      continue;
    }

    return { response, url: url.toString() };
  }

  throw new Error("Too many redirects");
}

async function readLimited(response, maxBytes) {
  const length = Number(response.headers.get("content-length"));

  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    throw new Error("Response too large");
  }

  if (!response.body) throw new Error("Empty response");

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      total += value.byteLength;

      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("Response exceeded size limit");
      }

      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

// =====================================
// HTML HELPERS
// =====================================

function decodeHTML(text) {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function meta(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const tags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const name =
      tag.match(/\b(?:property|name)=["']([^"']+)["']/i)?.[1];

    const content =
      tag.match(/\bcontent=["']([^"']*)["']/i)?.[1];

    if (name?.toLowerCase() === key.toLowerCase() && content) {
      return content.trim();
    }
  }

  return "";
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

  if (!response.ok) throw new Error(`Website status: ${response.status}`);

  const type = (response.headers.get("content-type") || "").toLowerCase();

  if (!type.includes("text/html") && !type.includes("application/xhtml+xml")) {
    await response.body?.cancel();
    throw new Error("Not an HTML website");
  }

  const html = (await readLimited(response, CONFIG.maxHtmlBytes)).toString("utf8");

  let title =
    meta(html, "og:title") ||
    meta(html, "twitter:title");

  if (!title) {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    title = match ? match[1].replace(/<[^>]+>/g, "") : "";
  }

  const description =
    meta(html, "og:description") ||
    meta(html, "description") ||
    meta(html, "twitter:description");

  const image = absoluteURL(
    meta(html, "og:image") || meta(html, "twitter:image"),
    url
  );

  const embed = new EmbedBuilder()
    .setColor(CONFIG.color)
    .setTitle(truncate(decodeHTML(title || new URL(url).hostname), 256))
    .setURL(url)
    .setDescription(
      truncate(decodeHTML(description || "معاينة الموقع بواسطة Larika"), 4000)
    )
    .setFooter({ text: `${CONFIG.name} • Website Preview` });

  if (image) embed.setImage(image);

  return { embed };
}

// =====================================
// IMAGE PREVIEW
// =====================================

async function imagePreview(link) {
  const { response, url } = await safeFetch(link, {
    accept: "image/*"
  });

  const type = (response.headers.get("content-type") || "").toLowerCase();

  if (!response.ok || !type.startsWith("image/")) {
    await response.body?.cancel();
    throw new Error("Invalid image");
  }

  const data = await readLimited(response, CONFIG.maxImageBytes);

  if (!data.length) throw new Error("Empty image");

  const embed = new EmbedBuilder()
    .setColor(CONFIG.color)
    .setTitle("معاينة صورة")
    .setURL(url)
    .setImage(url)
    .setFooter({ text: `${CONFIG.name} • Image Preview` });

  return { embed };
}

// =====================================
// DISCORD INVITE PREVIEW
// =====================================

async function invitePreview(link, code) {
  const invite = await client.fetchInvite(code, {
    withCounts: true
  });

  const guild = invite.guild;

  if (!guild) throw new Error("Invalid invitation");

  const embed = new EmbedBuilder()
    .setColor(CONFIG.color)
    .setTitle(truncate(guild.name || "Discord Server", 256))
    .setURL(invite.url || link)
    .setDescription("دعوة للانضمام إلى سيرفر ديسكورد")
    .addFields(
      {
        name: "الأعضاء",
        value: String(invite.approximateMemberCount ?? "غير متاح"),
        inline: true
      },
      {
        name: "المتصلون",
        value: String(invite.approximatePresenceCount ?? "غير متاح"),
        inline: true
      }
    )
    .setFooter({ text: `${CONFIG.name} • Discord Preview` });

  const icon = guild.iconURL({ size: 512 });
  if (icon) embed.setThumbnail(icon);

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("انضم إلى السيرفر")
      .setStyle(ButtonStyle.Link)
      .setURL(invite.url || link)
  );

  return { embed, row };
}

// =====================================
// PREVIEW ENGINE
// =====================================

async function createPreview(link) {
  const invite = link.match(INVITE_REGEX);

  if (invite && CONFIG.discordInvitePreview) {
    return invitePreview(link, invite[1]);
  }

  if (IMAGE_REGEX.test(link) && CONFIG.imagePreview) {
    return imagePreview(link);
  }

  if (CONFIG.websitePreview) {
    return websitePreview(link);
  }

  return null;
}

// =====================================
// READY
// =====================================

client.once("ready", () => {
  log("--------------------------------");
  log("DISCORD GATEWAY CONNECTED");
  log("BOT ONLINE:", client.user.tag);
  log("BOT ID:", client.user.id);
  log("SERVERS:", client.guilds.cache.size);
  log("--------------------------------");

  client.user.setActivity("Automatic Previews", {
    type: ActivityType.Watching
  });
});

// =====================================
// MESSAGE SYSTEM
// =====================================

client.on("messageCreate", async message => {
  if (!message.guild) return;
  if (CONFIG.ignoreBots && message.author.bot) return;
  if (CONFIG.ignoreWebhooks && message.webhookId) return;

  if (CONFIG.preventDuplicatePreviews && processed.has(message.id)) return;

  const links = getURLs(message.content);

  const attachments = [...message.attachments.values()].filter(file =>
    file.contentType?.startsWith("image/")
  );

  if (!links.length && !attachments.length) return;

  if (processed.size >= MAX_PROCESSED) {
    const oldest = processed.keys().next().value;
    if (oldest) processed.delete(oldest);
  }

  processed.set(message.id, Date.now());

  try {
    const embeds = [];
    let inviteRow = null;

    for (const link of links) {
      try {
        log("Processing:", link);

        const result = await createPreview(link);

        if (result?.embed && embeds.length < 10) {
          embeds.push(result.embed);
        }

        if (result?.row && !inviteRow) {
          inviteRow = result.row;
        }
      } catch (error) {
        log("Preview skipped:", error.message);
      }
    }

    for (const file of attachments) {
      if (embeds.length >= 10) break;

      embeds.push(
        new EmbedBuilder()
          .setColor(CONFIG.color)
          .setTitle("معاينة صورة")
          .setImage(file.url)
          .setFooter({ text: `${CONFIG.name} • Image Preview` })
      );
    }

    if (!embeds.length) return;

    const payload = {
      embeds: embeds.slice(0, 10),
      components: inviteRow ? [inviteRow] : [],
      allowedMentions: { parse: [] },
      failIfNotExists: false
    };

    if (CONFIG.replyUnderMessage) {
      await message.reply(payload);
    } else {
      await message.channel.send(payload);
    }

    log("Preview sent successfully");

  } catch (error) {
    console.error("[LARIKA] Preview error:", error);
  }
});

// =====================================
// CLEANUP
// =====================================

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;

  for (const [id, timestamp] of processed) {
    if (timestamp < cutoff) processed.delete(id);
  }
}, 5 * 60 * 1000).unref();

// =====================================
// DISCORD DIAGNOSTICS
// =====================================

client.on("error", error => {
  console.error("[LARIKA] Discord Error:", error);
});

client.on("shardError", error => {
  console.error("[LARIKA] Shard Error:", error);
});

client.on("shardDisconnect", (event, shardId) => {
  console.error("[LARIKA] Shard disconnected:", shardId, event.code);
});

client.on("shardReconnecting", shardId => {
  log("Shard reconnecting:", shardId);
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
  log("Starting Discord login...");

  const token = process.env.DISCORD_TOKEN?.trim();

  log("DISCORD_TOKEN exists:", Boolean(token));

  if (!token) {
    console.error("[LARIKA] DISCORD_TOKEN is missing!");
    process.exitCode = 1;
    return;
  }

  try {
    await client.login(token);
    log("Login request accepted");
  } catch (error) {
    console.error("[LARIKA] DISCORD LOGIN FAILED");
    console.error("Error name:", error.name);
    console.error("Error code:", error.code);
    console.error("Error message:", error.message);
  }
}

startBot();

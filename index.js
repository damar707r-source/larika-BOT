
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

// ==========================================
// CONFIG
// ==========================================

function loadConfig() {
  const file = path.join(__dirname, "config.json");
  const data = JSON.parse(fs.readFileSync(file, "utf8"));

  const getNumber = (value, fallback, min, max) => {
    const n = Number(value);
    return Number.isFinite(n)
      ? Math.max(min, Math.min(max, n))
      : fallback;
  };

  const getColor = (value, fallback) => {
    return /^#[0-9a-f]{6}$/i.test(value || "")
      ? parseInt(value.slice(1), 16)
      : fallback;
  };

  return {
    name: data.name || "𝐋𝐚𝐫𝐢𝐤𝐚 BOT",
    color: getColor(data.embedColor, 0x17151F),
    accent: getColor(data.accentColor, 0x9B5CFF),

    maxLinks: getNumber(data.maxLinks, 3, 1, 10),

    websitePreview: data.websitePreview !== false,
    imagePreview: data.imagePreview !== false,
    discordInvitePreview: data.discordInvitePreview !== false,

    replyUnderMessage: data.replyUnderMessage !== false,
    ignoreBots: data.ignoreBots !== false,
    ignoreWebhooks: data.ignoreWebhooks !== false,

    timeout: getNumber(data.timeout, 10000, 3000, 20000),
    maxHtmlBytes: getNumber(data.maxHtmlBytes, 1000000, 100000, 2000000),
    maxImageBytes: getNumber(data.maxImageBytes, 8000000, 100000, 15000000),
    maxRedirects: getNumber(data.maxRedirects, 4, 0, 8),

    preventDuplicatePreviews: data.preventDuplicatePreviews !== false,
    enableLogs: data.enableLogs !== false
  };
}

let CONFIG;

try {
  CONFIG = loadConfig();
  console.log("[LARIKA] Configuration loaded");
} catch (error) {
  console.error("[LARIKA] CONFIG ERROR:", error.message);
  process.exit(1);
}

function log(...args) {
  if (CONFIG.enableLogs) {
    console.log("[LARIKA]", ...args);
  }
}

// ==========================================
// DISCORD CLIENT
// ==========================================

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
});

// ==========================================
// RENDER HEALTH CHECK
// ==========================================

const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store"
    });

    return res.end(JSON.stringify({
      service: "Larika Discord Bot",
      discord: client.isReady() ? "connected" : "connecting"
    }));
  }

  res.writeHead(404, {
    "Content-Type": "text/plain; charset=utf-8"
  });

  res.end("Not Found");
});

server.on("error", error => {
  console.error("[LARIKA] HTTP SERVER ERROR:", error.message);
});

server.listen(PORT, "0.0.0.0", () => {
  log("Health check listening on port", PORT);
});

// ==========================================
// URL HELPERS
// ==========================================

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
    ...new Set(
      (content.match(URL_REGEX) || []).map(cleanURL)
    )
  ].slice(0, CONFIG.maxLinks);
}

function truncate(value, max = 4000) {
  if (!value) return "";

  return value.length > max
    ? value.slice(0, max - 1) + "…"
    : value;
}

// ==========================================
// PRIVATE IP PROTECTION
// ==========================================

function isPrivateIP(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);

    return (
      p[0] === 0 ||
      p[0] === 10 ||
      p[0] === 127 ||
      p[0] >= 224 ||
      (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) ||
      (p[0] === 192 && p[1] === 0 && p[2] === 0) ||
      (p[0] === 192 && p[1] === 0 && p[2] === 2) ||
      (p[0] === 198 && (p[1] === 18 || p[1] === 19)) ||
      (p[0] === 198 && p[1] === 51 && p[2] === 100) ||
      (p[0] === 203 && p[1] === 0 && p[2] === 113)
    );
  }

  if (net.isIPv6(ip)) {
    const address = ip.toLowerCase();

    if (address.startsWith("::ffff:")) {
      const mapped = address.slice(7);

      if (net.isIPv4(mapped)) {
        return isPrivateIP(mapped);
      }
    }

    // Permit only global unicast IPv6 space.
    return !address.startsWith("2") && !address.startsWith("3");
  }

  return true;
}

// ==========================================
// URL VALIDATION
// ==========================================

async function checkURL(value) {
  let url;

  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid URL");
  }

  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Unsupported URL protocol");
  }

  if (url.username || url.password) {
    throw new Error("URL credentials blocked");
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal"
  ) {
    throw new Error("Private hostname blocked");
  }

  if (net.isIP(host)) {
    if (isPrivateIP(host)) {
      throw new Error("Private IP blocked");
    }
  } else {
    const records = await dns.lookup(host, {
      all: true,
      verbatim: true
    });

    if (
      !records.length ||
      records.some(record => isPrivateIP(record.address))
    ) {
      throw new Error("Private DNS destination blocked");
    }
  }

  return url;
}

// ==========================================
// SAFE FETCH WITH REDIRECT CHECKS
// ==========================================

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

      if (!location) {
        throw new Error("Invalid redirect");
      }

      current = new URL(location, url).toString();
      continue;
    }

    return { response, url: url.toString() };
  }

  throw new Error("Too many redirects");
}

// ==========================================
// LIMITED RESPONSE READER
// ==========================================

async function readLimited(response, maxBytes) {
  const length = Number(response.headers.get("content-length"));

  if (Number.isFinite(length) && length > maxBytes) {
    await response.body?.cancel();
    throw new Error("Response too large");
  }

  if (!response.body) {
    throw new Error("Empty response");
  }

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

// ==========================================
// HTML HELPERS
// ==========================================

function decodeHTML(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function getAttribute(tag, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  const match = tag.match(
    new RegExp(
      `\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
      "i"
    )
  );

  return match
    ? (match[1] ?? match[2] ?? match[3] ?? "").trim()
    : "";
}

function meta(html, key) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const name =
      getAttribute(tag, "property") ||
      getAttribute(tag, "name");

    const content = getAttribute(tag, "content");

    if (name.toLowerCase() === key.toLowerCase() && content) {
      return content;
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

// ==========================================
// WEBSITE PREVIEW
// ==========================================

async function websitePreview(link) {
  const { response, url } = await safeFetch(link);

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Website status: ${response.status}`);
  }

  const type = (
    response.headers.get("content-type") || ""
  ).toLowerCase();

  if (
    !type.includes("text/html") &&
    !type.includes("application/xhtml+xml")
  ) {
    await response.body?.cancel();
    throw new Error("Not an HTML website");
  }

  const html = (
    await readLimited(response, CONFIG.maxHtmlBytes)
  ).toString("utf8");

  let title =
    meta(html, "og:title") ||
    meta(html, "twitter:title");

  if (!title) {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

    title = match
      ? match[1].replace(/<[^>]+>/g, "")
      : "";
  }

  const description =
    meta(html, "og:description") ||
    meta(html, "description") ||
    meta(html, "twitter:description");

  let image = absoluteURL(
    meta(html, "og:image") || meta(html, "twitter:image"),
    url
  );

  if (image) {
    try {
      await checkURL(image);
    } catch {
      image = "";
    }
  }

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
        decodeHTML(description || "معاينة الموقع بواسطة Larika"),
        4000
      )
    )
    .setFooter({
      text: `${CONFIG.name} • Website Preview`
    });

  if (image) {
    embed.setImage(image);
  }

  return { embed };
}

// ==========================================
// IMAGE PREVIEW
// ==========================================

async function imagePreview(link) {
  const { response, url } = await safeFetch(link, {
    accept: "image/*"
  });

  const type = (
    response.headers.get("content-type") || ""
  ).toLowerCase();

  if (!response.ok || !type.startsWith("image/")) {
    await response.body?.cancel();
    throw new Error("Invalid image");
  }

  const data = await readLimited(response, CONFIG.maxImageBytes);

  if (!data.length) {
    throw new Error("Empty image");
  }

  const embed = new EmbedBuilder()
    .setColor(CONFIG.color)
    .setTitle("معاينة صورة")
    .setURL(url)
    .setImage(url)
    .setFooter({
      text: `${CONFIG.name} • Image Preview`
    });

  return { embed };
}

// ==========================================
// DISCORD INVITE PREVIEW
// ==========================================

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
    .setFooter({
      text: `${CONFIG.name} • Discord Preview`
    });

  const icon = guild.iconURL({ size: 512 });

  if (icon) {
    embed.setThumbnail(icon);
  }

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("انضم إلى السيرفر")
      .setStyle(ButtonStyle.Link)
      .setURL(invite.url || link)
  );

  return { embed, row };
}

// ==========================================
// PREVIEW ENGINE
// ==========================================

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

// ==========================================
// BOT READY
// ==========================================

client.once("ready", () => {
  console.log("");
  console.log("==================================");
  console.log("         LARIKA BOT ONLINE");
  console.log("==================================");

  console.log("[LARIKA] Bot:", client.user.tag);
  console.log("[LARIKA] Servers:", client.guilds.cache.size);
  console.log("[LARIKA] Website Preview:", CONFIG.websitePreview);
  console.log("[LARIKA] Image Preview:", CONFIG.imagePreview);
  console.log("[LARIKA] Invite Preview:", CONFIG.discordInvitePreview);

  console.log("==================================");
  console.log("");

  client.user.setActivity("Automatic Previews", {
    type: ActivityType.Watching
  });
});

// ==========================================
// MESSAGE HANDLER
// ==========================================

client.on("messageCreate", async message => {
  if (!message.guild) return;

  if (CONFIG.ignoreBots && message.author.bot) return;
  if (CONFIG.ignoreWebhooks && message.webhookId) return;

  if (
    CONFIG.preventDuplicatePreviews &&
    processed.has(message.id)
  ) {
    return;
  }

  const links = getURLs(message.content);

  const attachments = [
    ...message.attachments.values()
  ].filter(file => file.contentType?.startsWith("image/"));

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
        log("Processing link:", new URL(link).hostname);

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

    if (CONFIG.imagePreview) {
      for (const file of attachments) {
        if (embeds.length >= 10) break;

        embeds.push(
          new EmbedBuilder()
            .setColor(CONFIG.color)
            .setTitle("معاينة صورة")
            .setImage(file.url)
            .setFooter({
              text: `${CONFIG.name} • Image Preview`
            })
        );
      }
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
    console.error("[LARIKA] Message handler error:", error.message);
  }
});

// ==========================================
// CLEANUP
// ==========================================

setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;

  for (const [id, timestamp] of processed) {
    if (timestamp < cutoff) {
      processed.delete(id);
    }
  }
}, 5 * 60 * 1000).unref();

// ==========================================
// DISCORD CONNECTION EVENTS
// ==========================================

client.on("shardConnecting", id => {
  log("Gateway connecting. Shard:", id);
});

client.on("shardReady", id => {
  log("Gateway READY. Shard:", id);
});

client.on("shardReconnecting", id => {
  log("Gateway reconnecting. Shard:", id);
});

client.on("shardDisconnect", (event, id) => {
  console.error(
    "[LARIKA] Gateway disconnected:",
    "Shard:", id,
    "Code:", event.code,
    "Reason:", event.reason || "No reason provided"
  );
});

client.on("shardError", (error, id) => {
  console.error(
    "[LARIKA] Gateway shard error:",
    id,
    error.message
  );
});

client.on("error", error => {
  console.error("[LARIKA] Discord client error:", error.message);
});

client.on("warn", warning => {
  console.warn("[LARIKA] Discord warning:", warning);
});

client.on("invalidated", () => {
  console.error("[LARIKA] Discord session invalidated");
});

process.on("unhandledRejection", error => {
  console.error(
    "[LARIKA] Unhandled rejection:",
    error?.message || error
  );
});

process.on("uncaughtException", error => {
  console.error(
    "[LARIKA] Uncaught exception:",
    error
  );

  process.exit(1);
});

// ==========================================
// START BOT
// ==========================================

async function startBot() {
  console.log("");
  console.log("[LARIKA] Starting Discord login...");
  console.log("[LARIKA] Node version:", process.version);

  const token = process.env.DISCORD_TOKEN?.trim();

  console.log(
    "[LARIKA] DISCORD_TOKEN exists:",
    Boolean(token)
  );

  if (!token) {
    console.error("[LARIKA] DISCORD_TOKEN is missing");
    process.exit(1);
    return;
  }

  const watchdog = setTimeout(() => {
    if (!client.isReady()) {
      console.error("");
      console.error("[LARIKA] CONNECTION TIMEOUT");
      console.error(
        "[LARIKA] Discord Gateway has not reached READY after 45 seconds."
      );
      console.error(
        "[LARIKA] Check the Gateway connection and the errors above."
      );
      console.error("");
    }
  }, 45000);

  // Register before login so the READY event cannot be missed.
  client.once("ready", () => {
    clearTimeout(watchdog);
  });

  try {
    console.log("[LARIKA] Connecting directly to Discord Gateway...");

    // Do not make an extra Discord API request before login.
    // discord.js handles the connection and authentication.
    await client.login(token);

    console.log("[LARIKA] Login request accepted.");

  } catch (error) {
    clearTimeout(watchdog);

    console.error("");
    console.error("[LARIKA] STARTUP FAILED");
    console.error("[LARIKA] Error name:", error.name || "Unknown");
    console.error("[LARIKA] Error code:", error.code || "Not provided");
    console.error("[LARIKA] Error message:", error.message || error);
    console.error("");

    process.exit(1);
  }
}

// ==========================================
// PROCESS START
// ==========================================

startBot();

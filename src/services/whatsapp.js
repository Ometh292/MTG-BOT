const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");
const fs = require("fs");
const path = require("path");

const logger = require("../utils/logger");

const SESSION_PATH = path.join(__dirname, "../../.wwebjs_auth");
const MAX_RECONNECT_ATTEMPTS = 3;

let reconnectAttempts = 0;
let isClientReady = false;
let client;
let config;
let agentService;

const processedMessages = new Set();
setInterval(() => processedMessages.clear(), 60 * 60 * 1000);

function ensureSessionDirectory() {
	if (!fs.existsSync(SESSION_PATH)) {
		fs.mkdirSync(SESSION_PATH, { recursive: true, mode: 0o755 });
	}
}

async function clearSessionAndRestart() {
	try {
		if (fs.existsSync(SESSION_PATH)) {
			fs.rmSync(SESSION_PATH, { recursive: true, force: true });
		}

		fs.mkdirSync(SESSION_PATH, { recursive: true, mode: 0o755 });
		setTimeout(() => process.exit(1), 2000);
	} catch (error) {
		console.error("Error clearing session:", error);
		process.exit(1);
	}
}

function initializeClient(configuration, services) {
	config = configuration;
	agentService = services.agentService;

	ensureSessionDirectory();

	const puppeteerConfig = {
		headless: true,
		args: config.client.puppeteerArgs,
	};

	if (config.client.executablePath) {
		puppeteerConfig.executablePath = config.client.executablePath;
	}

	client = new Client({
		authStrategy: new LocalAuth({
			clientId: "mtg-store-session",
			dataPath: SESSION_PATH,
		}),
		webVersionCache: {
			type: "remote",
			remotePath: "https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/2.3000.1018939634-alpha.html",
		},
		puppeteer: puppeteerConfig,
	});

	setupEventHandlers();
	return client;
}

function setupEventHandlers() {
	client.on("qr", async (qr) => {
		const timestamp = new Date().toISOString();
		logger.info(`QR code generated [${timestamp}]`);
		await logger.setQRCode(qr);
		qrcode.generate(qr, { small: true });
		reconnectAttempts = 0;
	});

	client.on("authenticated", () => {
		logger.success("Authentication successful");
		logger.clearQRCode();
		reconnectAttempts = 0;
	});

	client.on("auth_failure", async (message) => {
		console.error("Authentication failure:", message);
		await clearSessionAndRestart();
	});

	client.on("ready", async () => {
		isClientReady = true;
		reconnectAttempts = 0;

		logger.success("WhatsApp client ready");
		logger.success(`Connected as: ${client.info.pushname}`);
		logger.success(`Phone: ${client.info.wid.user}`);

		try {
			await client.pupPage.evaluate(() => {
				if (window.WWebJS && window.WWebJS.sendSeen) {
					const originalSendSeen = window.WWebJS.sendSeen;
					window.WWebJS.sendSeen = async (chatId) => {
						try {
							return await originalSendSeen(chatId);
						} catch (error) {
							return true;
						}
					};
				}
			});
		} catch (error) {
			console.warn("Could not apply sendSeen patch:", error.message);
		}

		logger.info("Bot is listening for inbound WhatsApp messages");
	});

	client.on("disconnected", async (reason) => {
		console.error("Client disconnected:", reason);
		isClientReady = false;

		if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
			reconnectAttempts += 1;
			setTimeout(async () => {
				try {
					await client.initialize();
				} catch (error) {
					console.error("Reconnection failed:", error.message);
					if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
						await clearSessionAndRestart();
					}
				}
			}, 5000);
			return;
		}

		await clearSessionAndRestart();
	});

	client.on("loading_screen", (percent, message) => {
		console.log(`Loading... ${percent}% - ${message}`);
	});

	client.on("message", handleMessage);
}

async function handleMessage(message) {
	if (processedMessages.has(message.id._serialized)) {
		return;
	}
	processedMessages.add(message.id._serialized);

	try {
		const chat = await message.getChat();
		const contact = await message.getContact();
		const customerInfo = {
			name: contact.name || contact.pushname || "Customer",
			number: message.from.split("@")[0],
		};

		if (config.bot.logMessages) {
			logger.info(`Message from ${customerInfo.name} (${message.from}): ${message.body}`);
		}

		if (config.bot.ignoreOwnMessages && message.fromMe) {
			return;
		}

		if (config.bot.ignoreBroadcast && message.from === "status@broadcast") {
			return;
		}

		if (message.from.endsWith("@g.us")) {
			if (config.bot.ignoreGroups) {
				return;
			}

			const mentions = await message.getMentions();
			const isMentioned = mentions.some((entry) => entry.id._serialized === client.info.wid._serialized);

			let isReplyingToBot = false;
			if (message.hasQuotedMsg) {
				const quotedMessage = await message.getQuotedMessage();
				if (quotedMessage.author === client.info.wid._serialized || quotedMessage.fromMe) {
					isReplyingToBot = true;
				}
			}

			if (!isMentioned && !isReplyingToBot) {
				return;
			}
		}

		const result = await agentService.processMessage({
			chatId: message.from,
			messageText: message.body,
			customerInfo,
		});

		if (!result.success || !result.reply) {
			return;
		}

		try {
			await chat.sendMessage(result.reply);
		} catch (error) {
			await client.sendMessage(message.from, result.reply);
		}
	} catch (error) {
		console.error("Error handling inbound message:", error);
	}
}

async function sendMessage(to, message) {
	try {
		await client.sendMessage(to, message);
		return true;
	} catch (error) {
		console.error(`Error sending message to ${to}:`, error);
		return false;
	}
}

function setupShutdownHandlers(onShutdown) {
	const shutdown = async (signal) => {
		console.log(`Received ${signal}, shutting down...`);

		if (typeof onShutdown === "function") {
			try {
				onShutdown();
			} catch (error) {
				console.error("Shutdown hook failed:", error);
			}
		}

		try {
			await client.destroy();
		} catch (error) {
			console.error("Error during shutdown:", error);
		}

		process.exit(0);
	};

	process.on("SIGINT", () => shutdown("SIGINT"));
	process.on("SIGTERM", () => shutdown("SIGTERM"));
}

function getStatus() {
	return {
		ready: isClientReady,
		info: client && client.info ? {
			name: client.info.pushname,
			phone: client.info.wid.user,
		} : null,
		reconnectAttempts,
	};
}

function getClient() {
	return client;
}

module.exports = {
	initializeClient,
	sendMessage,
	getStatus,
	getClient,
	setupShutdownHandlers,
};

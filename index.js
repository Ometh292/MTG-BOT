require("dotenv").config();

const config = require("./config");
const HistoryManager = require("./history");
const whatsappService = require("./src/services/whatsapp");
const geminiService = require("./src/services/gemini");
const agentService = require("./src/services/agent");
const expressService = require("./src/services/express");

function isTransientWhatsAppInitError(error) {
	const message = String(error && error.message ? error.message : error);
	return (
		message.includes("Execution context was destroyed")
		|| message.includes("Cannot find context with specified id")
		|| message.includes("Target closed")
	);
}

async function initializeWhatsAppClientWithRetry(client, maxAttempts = 4) {
	for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
		try {
			await client.initialize();
			return;
		} catch (error) {
			const isTransient = isTransientWhatsAppInitError(error);
			const canRetry = isTransient && attempt < maxAttempts;

			if (!canRetry) {
				throw error;
			}

			try {
				await client.destroy();
			} catch (_destroyError) {
				// Ignore cleanup failures and continue with retry backoff.
			}

			console.warn(
				`WhatsApp initialization attempt ${attempt}/${maxAttempts} failed with transient browser error. Retrying...`,
			);
			whatsappService.clearVolatileCache();
			await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
		}
	}
}

async function bootstrap() {
	console.log("==================================================");
	console.log("MTG Store WhatsApp Assistant");
	console.log(`PID: ${process.pid}`);
	console.log("==================================================\n");

	let historyManager = null;
	if (config.aiBot.memory && config.aiBot.memory.enabled) {
		historyManager = new HistoryManager(config.aiBot.memory.limit);
		console.log(`Session memory enabled (limit: ${config.aiBot.memory.limit} messages)`);
	}

	await geminiService.initialize(process.env.GEMINI_API_KEY, config);
	agentService.initialize({ config, historyManager, geminiService });

	const client = whatsappService.initializeClient(config, {
		agentService,
	});

	whatsappService.setupShutdownHandlers(() => {
		if (historyManager) {
			historyManager.destroy();
		}
	});

	console.log("Initializing WhatsApp client...\n");
	await initializeWhatsAppClientWithRetry(client);

	expressService.initializeServer(whatsappService, config);
	console.log("All services initialized.\n");
}

bootstrap().catch((error) => {
	console.error("Failed to start bot:", error);
	process.exit(1);
});

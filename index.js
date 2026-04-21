require("dotenv").config();

const config = require("./config");
const HistoryManager = require("./history");
const whatsappService = require("./src/services/whatsapp");
const geminiService = require("./src/services/gemini");
const agentService = require("./src/services/agent");
const expressService = require("./src/services/express");

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
	await client.initialize();

	expressService.initializeServer(whatsappService, config);
	console.log("All services initialized.\n");
}

bootstrap().catch((error) => {
	console.error("Failed to start bot:", error);
	process.exit(1);
});

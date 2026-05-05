require("dotenv").config();

const config = require("./config");
const HistoryManager = require("./history");
const whatsappService = require("./src/services/whatsapp");
const geminiService = require("./src/services/gemini");
const agentService = require("./src/services/agent");
const ragService = require("./src/services/rag");
const expressService = require("./src/services/express");
const crawlerService = require("./src/services/crawler");

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

	// Crawl website first to update rag/*.md files, then build the vector index
	if (config.features.rag.enabled) {
		// Step 1: Crawl website and refresh Markdown knowledge files
		console.log("Crawling moxandlotus.sg to refresh knowledge base...\n");
		try {
			const crawlResult = await crawlerService.runCrawler();
			console.log(`Crawl complete: ${crawlResult.savedCount} pages updated.\n`);
		} catch (crawlError) {
			console.warn("[Crawler] Website crawl failed (will use existing rag/*.md files):", crawlError.message);
		}

		// Step 2: Build (or rebuild) the vector index from rag/*.md
		console.log("Building RAG knowledge index...\n");
		try {
			await ragService.buildIndex();
			console.log("RAG index ready.\n");
		} catch (ragError) {
			console.warn("[RAG] Index build failed (bot will start without RAG):", ragError.message);
		}

		// Step 3: Schedule daily crawl + index rebuild (runs at midnight Colombo time)
		crawlerService.scheduleDaily(0, 0, ragService);
	}

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

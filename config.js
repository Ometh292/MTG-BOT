const path = require("path");

const getSystemPrompt = require("./prompts/system-prompt");

function parseBoolean(value, fallback = false) {
	if (value === undefined || value === null || value === "") {
		return fallback;
	}

	return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function getDefaultPuppeteerArgs() {
	const baseArgs = [
		"--no-sandbox",
		"--disable-setuid-sandbox",
		"--disable-dev-shm-usage",
		"--disable-accelerated-2d-canvas",
		"--no-first-run",
		"--disable-gpu",
		"--disable-crashpad",
	];

	// These flags are helpful in many Linux container runtimes but can destabilize
	// Chromium on desktop macOS during page context transitions.
	if (process.platform === "linux") {
		baseArgs.push("--no-zygote", "--single-process");
	}

	return baseArgs;
}

module.exports = {
	storeInfo: {
		name: "Mana Junction MTG Store",
		location: "Colombo, Sri Lanka",
		supportHours: "Tuesday-Sunday, 11:00 AM-8:00 PM",
		timezone: process.env.STORE_TIMEZONE || "Asia/Colombo",
		contactEmail: process.env.STORE_SUPPORT_EMAIL || "support@manajunction.example",
		websiteUrl: process.env.STORE_WEBSITE_URL || "",
	},

	aiBot: {
		enabled: true,
		provider: "gemini",
		model: process.env.GEMINI_MODEL || "gemini-2.5-flash",
		systemPrompt: getSystemPrompt(),
		memory: {
			enabled: true,
			limit: 30,
		},
	},

	features: {
		tools: {
			enabled: parseBoolean(process.env.TOOLS_ENABLED, true),
		},
		rag: {
			enabled: parseBoolean(process.env.RAG_ENABLED, true),
		},
		rulesGrounding: {
			enabled: parseBoolean(process.env.RULES_GROUNDING_ENABLED, false),
		},
	},

	storeApi: {
		baseUrl: process.env.STORE_API_BASE_URL || "",
		apiKey: process.env.STORE_API_KEY || "",
		timeoutMs: Number(process.env.STORE_API_TIMEOUT_MS || 10000),
	},

	rag: {
		// Folder containing .md knowledge files (auto-indexed on startup)
		sourcePath: process.env.RAG_SOURCE_PATH || path.join(__dirname, "rag"),
		// Local vectra vector-index storage directory
		indexPath: process.env.RAG_INDEX_PATH || path.join(__dirname, "rag", ".vector-index"),
		categories: ["policies", "buylist", "faq", "shipping", "events", "general"],
		maxResults: Number(process.env.RAG_MAX_RESULTS || 3),
		// Word-based chunking parameters
		chunkSize: Number(process.env.RAG_CHUNK_SIZE || 400),
		chunkOverlap: Number(process.env.RAG_CHUNK_OVERLAP || 50),
		// Cosine similarity threshold (0–1); lower = more permissive (0.40 is a safe default for Vertex AI)
		similarityThreshold: Number(process.env.RAG_SIMILARITY_THRESHOLD || 0.40),
		// Embedding model — text-embedding-004 is the Vertex AI model (768-dim, same as MoxVoice)
		embeddingModel: process.env.RAG_EMBEDDING_MODEL || "text-embedding-004",
	},

	rulesGrounding: {
		enabled: parseBoolean(process.env.RULES_GROUNDING_ENABLED, false),
	},

	bot: {
		ignoreGroups: false,
		ignoreBroadcast: true,
		ignoreOwnMessages: true,
		logMessages: true,
	},

	client: {
		puppeteerArgs: getDefaultPuppeteerArgs(),
		sessionPath: "./.wwebjs_auth",
		executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || null,
	},
};

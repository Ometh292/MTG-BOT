const path = require("path");

const getSystemPrompt = require("./prompts/system-prompt");

function parseBoolean(value, fallback = false) {
	if (value === undefined || value === null || value === "") {
		return fallback;
	}

	return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function parseDurationMs(value, fallback = 10000) {
	if (value === undefined || value === null || value === "") {
		return fallback;
	}

	const raw = String(value).trim().toLowerCase();
	if (!raw) {
		return fallback;
	}

	const parseNumeric = (text) => {
		const number = Number(text);
		return Number.isFinite(number) && number > 0 ? number : null;
	};

	if (/^\d+(?:\.\d+)?\s*ms$/.test(raw)) {
		const valueMs = parseNumeric(raw.replace(/\s*ms$/, ""));
		return valueMs ? Math.round(valueMs) : fallback;
	}

	if (/^\d+(?:\.\d+)?\s*(?:s|sec|secs|second|seconds)$/.test(raw)) {
		const valueSeconds = parseNumeric(raw.replace(/\s*(?:s|sec|secs|second|seconds)$/, ""));
		return valueSeconds ? Math.round(valueSeconds * 1000) : fallback;
	}

	if (/^\d+(?:\.\d+)?$/.test(raw)) {
		const numeric = parseNumeric(raw);
		if (!numeric) {
			return fallback;
		}

		// Backward compatibility: values like "30" were often provided as seconds.
		return numeric <= 120 ? Math.round(numeric * 1000) : Math.round(numeric);
	}

	return fallback;
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
		auth: {
			mode: String(process.env.GEMINI_AUTH_MODE || "auto").trim().toLowerCase(),
			apiKey: process.env.GEMINI_API_KEY || "",
			vertexAi: {
				enabled: parseBoolean(process.env.GEMINI_USE_VERTEX_AI, false),
				project: process.env.GOOGLE_CLOUD_PROJECT || "",
				location: process.env.GOOGLE_CLOUD_LOCATION || "",
				applicationCredentials: process.env.GOOGLE_APPLICATION_CREDENTIALS || "",
				apiVersion: process.env.GEMINI_VERTEX_API_VERSION || "",
			},
		},
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
	moxApi: {
		baseUrl: process.env.MOX_API_BASE_URL || "",
		username: process.env.MOX_API_USERNAME || "",
		password: process.env.MOX_API_PASSWORD || "",
		userType: process.env.MOX_API_USER_TYPE || "Customer",
		timeoutMs: parseDurationMs(process.env.MOX_API_TIMEOUT, 10000),
	},

	rag: {
		sourcePath: process.env.RAG_SOURCE_PATH || path.join(__dirname, "rag"),
		categories: ["policies", "buylist"],
		maxResults: Number(process.env.RAG_MAX_RESULTS || 3),
		remote: {
			baseUrl: process.env.MOX_RAG_BASE_URL || "http://localhost:8000",
			tenantId: process.env.MOX_RAG_TENANT_ID || "default",
			timeoutMs: Number(process.env.MOX_RAG_TIMEOUT_MS || 10000),
		},
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

const fs = require("fs");
const path = require("path");

let GoogleGenAI;
let FunctionCallingConfigMode;
let client;
let runtimeConfig;
let activeAuthMode = "unknown";

function hasDisplayValue(value) {
	return value !== undefined && value !== null && String(value).trim() !== "";
}

function parseBoolean(value, fallback = false) {
	if (value === undefined || value === null || value === "") {
		return fallback;
	}

	return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function normalizeAuthMode(rawMode) {
	const mode = String(rawMode || "auto").trim().toLowerCase();
	if (["vertex", "vertexai", "vertex_ai", "service_account", "service-account"].includes(mode)) {
		return "vertex";
	}

	if (["api", "api_key", "apikey", "gemini_api", "gemini-api"].includes(mode)) {
		return "api_key";
	}

	return "auto";
}

function resolveCredentialsPath(rawPath) {
	if (!hasDisplayValue(rawPath)) {
		return "";
	}

	const trimmed = String(rawPath).trim();
	return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
}

function resolveAuthConfiguration(apiKeyOrConfig, maybeConfig) {
	const legacyMode = maybeConfig !== undefined || typeof apiKeyOrConfig === "string" || apiKeyOrConfig === undefined;
	const config = legacyMode ? maybeConfig : apiKeyOrConfig;
	const legacyApiKey = legacyMode ? apiKeyOrConfig : "";

	if (!config) {
		throw new Error("Gemini runtime config is required");
	}

	const aiAuth = config?.aiBot?.auth || {};
	const vertexAi = aiAuth?.vertexAi || {};

	const authMode = normalizeAuthMode(aiAuth.mode || process.env.GEMINI_AUTH_MODE || "auto");
	const apiKey = String(
		hasDisplayValue(legacyApiKey)
			? legacyApiKey
			: (aiAuth.apiKey || process.env.GEMINI_API_KEY || ""),
	).trim();

	const project = String(vertexAi.project || process.env.GOOGLE_CLOUD_PROJECT || "").trim();
	const location = String(vertexAi.location || process.env.GOOGLE_CLOUD_LOCATION || "").trim();
	const credentialsPath = resolveCredentialsPath(
		vertexAi.applicationCredentials || process.env.GOOGLE_APPLICATION_CREDENTIALS || "",
	);
	const vertexApiVersion = String(vertexAi.apiVersion || process.env.GEMINI_VERTEX_API_VERSION || "").trim();
	const vertexEnabledFlag = parseBoolean(vertexAi.enabled, false);

	const shouldUseVertex = (
		authMode === "vertex"
		|| vertexEnabledFlag
		|| (authMode === "auto" && !hasDisplayValue(apiKey) && hasDisplayValue(project) && hasDisplayValue(location))
	);

	return {
		config,
		authMode,
		apiKey,
		project,
		location,
		credentialsPath,
		vertexApiVersion,
		shouldUseVertex,
	};
}

async function initialize(apiKeyOrConfig, maybeConfig) {
	const {
		config,
		authMode,
		apiKey,
		project,
		location,
		credentialsPath,
		vertexApiVersion,
		shouldUseVertex,
	} = resolveAuthConfiguration(apiKeyOrConfig, maybeConfig);

	const sdk = await import("@google/genai");
	GoogleGenAI = sdk.GoogleGenAI;
	FunctionCallingConfigMode = sdk.FunctionCallingConfigMode;

	if (shouldUseVertex) {
		if (!hasDisplayValue(project) || !hasDisplayValue(location)) {
			throw new Error("Vertex Gemini auth requires GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION.");
		}

		if (hasDisplayValue(credentialsPath)) {
			if (!fs.existsSync(credentialsPath)) {
				throw new Error(`GOOGLE_APPLICATION_CREDENTIALS file not found: ${credentialsPath}`);
			}
			process.env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
		}

		const vertexOptions = {
			vertexai: true,
			project,
			location,
			...(hasDisplayValue(vertexApiVersion) ? { apiVersion: vertexApiVersion } : {}),
			...(hasDisplayValue(credentialsPath)
				? { googleAuthOptions: { keyFilename: credentialsPath } }
				: {}),
		};

		client = new GoogleGenAI(vertexOptions);
		activeAuthMode = "vertex";
		runtimeConfig = config;
		return;
	}

	if (!hasDisplayValue(apiKey)) {
		if (authMode === "api_key") {
			throw new Error("GEMINI_API_KEY is required when GEMINI_AUTH_MODE=api_key.");
		}

		throw new Error(
			"Gemini auth is not configured. Set GEMINI_API_KEY, or configure Vertex auth with GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION.",
		);
	}

	client = new GoogleGenAI({ apiKey });
	activeAuthMode = "api_key";
	runtimeConfig = config;
}

function ensureInitialized() {
	if (!client || !runtimeConfig) {
		throw new Error("Gemini service has not been initialized");
	}
}

function getActiveAuthMode() {
	return activeAuthMode;
}

function mapHistoryToContents(history = []) {
	return history
		.filter((entry) => entry && entry.content)
		.map((entry) => ({
			role: entry.role === "assistant" ? "model" : "user",
			parts: [{ text: entry.content }],
		}));
}

function extractFunctionCalls(response) {
	if (Array.isArray(response.functionCalls) && response.functionCalls.length > 0) {
		return response.functionCalls;
	}

	const candidateParts = response?.candidates?.[0]?.content?.parts || [];
	return candidateParts
		.filter((part) => part.functionCall)
		.map((part) => part.functionCall);
}

function extractText(response) {
	if (typeof response.text === "string" && response.text.trim()) {
		return response.text.trim();
	}

	const candidateParts = response?.candidates?.[0]?.content?.parts || [];
	return candidateParts
		.filter((part) => typeof part.text === "string")
		.map((part) => part.text)
		.join("")
		.trim();
}

function extractJsonText(text) {
	const value = String(text || "").trim();
	if (!value) {
		return "";
	}

	const fencedMatch = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
	if (fencedMatch) {
		return fencedMatch[1].trim();
	}

	const firstBrace = value.indexOf("{");
	const lastBrace = value.lastIndexOf("}");
	if (firstBrace >= 0 && lastBrace > firstBrace) {
		return value.slice(firstBrace, lastBrace + 1).trim();
	}

	return value;
}

async function generateReply({ systemInstruction, history, message, config = {} }) {
	ensureInitialized();

	const contents = [
		...mapHistoryToContents(history),
		{ role: "user", parts: [{ text: message }] },
	];

	const response = await client.models.generateContent({
		model: runtimeConfig.aiBot.model,
		contents,
		config: {
			systemInstruction,
			temperature: 0.3,
			...config,
		},
	});

	return {
		text: extractText(response),
		raw: response,
	};
}

async function generateJson({ systemInstruction, history, message, config = {} }) {
	const response = await generateReply({
		systemInstruction,
		history,
		message,
		config: {
			temperature: 0.1,
			...config,
		},
	});

	const jsonText = extractJsonText(response.text);
	return {
		data: JSON.parse(jsonText),
		text: response.text,
		raw: response.raw,
	};
}

async function generateWithTools({
	systemInstruction,
	history,
	message,
	toolDeclarations,
	toolHandlers,
	allowedFunctionNames,
	maxIterations = 4,
}) {
	ensureInitialized();

	const contents = [
		...mapHistoryToContents(history),
		{ role: "user", parts: [{ text: message }] },
	];
	const toolExecutions = [];

	for (let iteration = 0; iteration < maxIterations; iteration += 1) {
		const response = await client.models.generateContent({
			model: runtimeConfig.aiBot.model,
			contents,
			config: {
				systemInstruction,
				temperature: 0.2,
				tools: [{ functionDeclarations: toolDeclarations }],
				toolConfig: {
					functionCallingConfig: {
						mode: FunctionCallingConfigMode.AUTO,
						...(allowedFunctionNames && allowedFunctionNames.length
							? { allowedFunctionNames }
							: {}),
					},
				},
			},
		});

		const functionCalls = extractFunctionCalls(response);
			if (!functionCalls.length) {
				return {
					text: extractText(response),
					raw: response,
					toolExecutions,
				};
			}

		contents.push({
			role: "model",
			parts: functionCalls.map((call) => ({
				functionCall: {
					name: call.name,
					args: call.args || {},
				},
			})),
		});

		const functionResponses = [];
		for (const call of functionCalls) {
			const handler = toolHandlers[call.name];
			if (!handler) {
				functionResponses.push({
					functionResponse: {
						name: call.name,
						response: {
							name: call.name,
							content: {
								success: false,
								error: `No handler registered for ${call.name}`,
							},
						},
					},
				});
				continue;
			}

			try {
				const result = await handler(call.args || {});
				toolExecutions.push({
					name: call.name,
					args: call.args || {},
					result,
				});
				functionResponses.push({
					functionResponse: {
						name: call.name,
						response: {
							name: call.name,
							content: result,
						},
					},
				});
			} catch (error) {
				toolExecutions.push({
					name: call.name,
					args: call.args || {},
					result: {
						success: false,
						error: error.message,
					},
				});
				functionResponses.push({
					functionResponse: {
						name: call.name,
						response: {
							name: call.name,
							content: {
								success: false,
								error: error.message,
							},
						},
					},
				});
			}
		}

		contents.push({
			role: "user",
			parts: functionResponses,
		});
	}

	throw new Error("Gemini tool orchestration exceeded the maximum iteration limit");
}

module.exports = {
	initialize,
	getActiveAuthMode,
	generateReply,
	generateJson,
	generateWithTools,
};

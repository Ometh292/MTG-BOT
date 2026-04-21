let GoogleGenAI;
let FunctionCallingConfigMode;
let client;
let runtimeConfig;

async function initialize(apiKey, config) {
	if (!apiKey) {
		throw new Error("GEMINI_API_KEY is required");
	}

	const sdk = await import("@google/genai");
	GoogleGenAI = sdk.GoogleGenAI;
	FunctionCallingConfigMode = sdk.FunctionCallingConfigMode;

	client = new GoogleGenAI({ apiKey });
	runtimeConfig = config;
}

function ensureInitialized() {
	if (!client || !runtimeConfig) {
		throw new Error("Gemini service has not been initialized");
	}
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
	generateReply,
	generateWithTools,
};

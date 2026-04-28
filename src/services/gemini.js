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
	generateReply,
	generateJson,
	generateWithTools,
};

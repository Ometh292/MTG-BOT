const storeTools = require("./store-tools");
const ragService = require("./rag");
const rulesGrounding = require("./rules-grounding");
const { safeTextCleanup } = require("../utils/helpers");

let runtimeConfig;
let historyManager;
let llmService;

const GREETING_KEYWORDS = ["hi", "hello", "hey", "help", "menu"];
const POLICY_KEYWORDS = ["policy", "policies", "return", "refund", "shipping", "pickup", "hours", "payment", "preorder", "pre-order", "hold", "store credit"];
const BUYLIST_KEYWORDS = ["buylist", "sell cards", "sell my cards", "trade in", "collection", "bulk", "cash offer", "store credit quote"];
const RULES_KEYWORDS = ["rules", "ruling", "judge", "priority", "stack", "combat", "mulligan", "commander tax", "layers", "trigger", "legal in"];
const ORDER_STATUS_KEYWORDS = ["order status", "track order", "tracking", "where is my order", "order code"];
const EVENT_KEYWORDS = ["event", "fnm", "draft", "prerelease", "commander night", "tournament", "modern night", "standard showdown"];
const VOUCHER_KEYWORDS = ["voucher", "promo code", "coupon", "discount code", "gift card"];
const SUPPORT_KEYWORDS = ["support", "issue", "problem", "damaged", "missing", "wrong item", "need help"];
const PRODUCT_KEYWORDS = ["product", "stock", "available", "price", "booster", "box", "bundle", "single", "card", "sleeves", "playmat", "deck box"];
const UNSUPPORTED_ACTION_KEYWORDS = ["place order", "buy this", "reserve this", "hold this for me", "register me", "sign me up"];

function initialize({ config, historyManager: sessionHistoryManager, geminiService }) {
	runtimeConfig = config;
	historyManager = sessionHistoryManager;
	llmService = geminiService;

	storeTools.initialize(config);
	ragService.initialize(config);
	rulesGrounding.initialize(config);
}

function looksNonEnglish(text) {
	return /[\u0D80-\u0DFF\u0600-\u06FF\u4E00-\u9FFF]/.test(text);
}

function includesAny(text, keywords) {
	return keywords.some((keyword) => text.includes(keyword));
}

function detectRoute(text) {
	if (includesAny(text, UNSUPPORTED_ACTION_KEYWORDS)) {
		return { type: "unsupported_action" };
	}

	if (includesAny(text, BUYLIST_KEYWORDS)) {
		return { type: "rag", category: "buylist" };
	}

	if (includesAny(text, POLICY_KEYWORDS)) {
		return { type: "rag", category: "policies" };
	}

	if (includesAny(text, RULES_KEYWORDS)) {
		return { type: "rules" };
	}

	if (
		includesAny(text, ORDER_STATUS_KEYWORDS)
		|| includesAny(text, EVENT_KEYWORDS)
		|| includesAny(text, VOUCHER_KEYWORDS)
		|| includesAny(text, SUPPORT_KEYWORDS)
		|| includesAny(text, PRODUCT_KEYWORDS)
	) {
		return { type: "store_tools" };
	}

	if (GREETING_KEYWORDS.includes(text)) {
		return { type: "greeting" };
	}

	return { type: "out_of_scope" };
}

function addToHistory(chatId, role, content) {
	if (!historyManager || !content) {
		return;
	}

	historyManager.addMessage(chatId, { role, content });
}

function getHistory(chatId) {
	return historyManager ? historyManager.getMessages(chatId) : [];
}

function getGreetingReply() {
	return [
		"Hello. I can help with MTG store products, event info, order status, vouchers, policies, and buylist questions.",
		"Ask in English and include any order code, SKU, or event name if you have one.",
	].join(" ");
}

async function handleRagRoute(text, history, category) {
	const retrieval = await ragService.retrieveKnowledge(text, category);
	if (!retrieval.matches.length) {
		return `I could not find ${category} guidance in the local knowledge base. Please contact store staff for a confirmed answer.`;
	}

	const context = retrieval.matches
		.map((match, index) => `[${index + 1}] ${match.text}`)
		.join("\n\n");

	const prompt = [
		"Answer the user using only the supplied knowledge snippets.",
		"Be concise and store-support focused.",
		"If the snippets are incomplete, say that the answer needs staff confirmation.",
		`Knowledge category: ${category}`,
		"",
		context,
		"",
		`User question: ${text}`,
	].join("\n");

	const response = await llmService.generateReply({
		systemInstruction: runtimeConfig.aiBot.systemPrompt,
		history,
		message: prompt,
	});

	return response.text || `Here is the closest ${category} guidance I found:\n\n${context}`;
}

async function handleStoreToolsRoute(text, history, context) {
	const toolReply = await llmService.generateWithTools({
		systemInstruction: [
			runtimeConfig.aiBot.systemPrompt,
			"",
			"Use store tools whenever the answer depends on product data, events, vouchers, support logging, or order status.",
			"Summarize tool output clearly for the customer.",
			"Do not claim that an order was placed or an event registration was completed.",
		].join("\n"),
		history,
		message: text,
		toolDeclarations: storeTools.getToolDeclarations(),
		toolHandlers: storeTools.getToolHandlers(context),
	});

	return toolReply.text || "I could not complete that store lookup.";
}

async function handleRulesRoute(text) {
	const result = await rulesGrounding.groundRulesQuery(text);
	return `${result.message} For official rulings, please consult a judge or the official Comprehensive Rules and Gatherer resources.`;
}

async function processMessage({ chatId, messageText, customerInfo }) {
	if (!runtimeConfig || !llmService) {
		throw new Error("Agent service has not been initialized");
	}

	const cleanedText = safeTextCleanup(messageText);
	const resetReason = historyManager ? historyManager.checkAndReset(chatId, cleanedText) : null;
	if (resetReason === "manual") {
		const reply = "Session cleared. Ask your MTG store question in English when you're ready.";
		addToHistory(chatId, "assistant", reply);
		return { success: true, reply, route: "reset" };
	}

	if (!cleanedText) {
		return {
			success: true,
			reply: "Please send a text question in English.",
			route: "empty",
		};
	}

	if (looksNonEnglish(cleanedText)) {
		const reply = "This assistant currently supports English only. Please resend your message in English.";
		addToHistory(chatId, "user", cleanedText);
		addToHistory(chatId, "assistant", reply);
		return { success: true, reply, route: "english_only" };
	}

	const normalizedText = cleanedText.toLowerCase();
	const route = detectRoute(normalizedText);
	const history = getHistory(chatId);

	let reply;
	if (route.type === "greeting") {
		reply = getGreetingReply();
	} else if (route.type === "unsupported_action") {
		reply = "I can help with store information, but I cannot place orders, reserve stock, or register event entries in chat yet.";
	} else if (route.type === "rag" && runtimeConfig.features.rag.enabled) {
		reply = await handleRagRoute(cleanedText, history, route.category);
	} else if (route.type === "rules") {
		reply = await handleRulesRoute(cleanedText);
	} else if (route.type === "store_tools" && runtimeConfig.features.tools.enabled) {
		reply = await handleStoreToolsRoute(cleanedText, history, {
			chatId,
			customerName: customerInfo?.name,
			contact: customerInfo?.number,
		});
	} else {
		reply = "I can help with MTG store products, events, order status, vouchers, policies, and buylist questions. Other topics are out of scope here.";
	}

	addToHistory(chatId, "user", cleanedText);
	addToHistory(chatId, "assistant", reply);

	return {
		success: true,
		reply,
		route: route.type,
	};
}

module.exports = {
	initialize,
	processMessage,
};

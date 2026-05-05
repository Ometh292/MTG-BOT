const storeTools = require("./store-tools");
const ragService = require("./rag");
const rulesGrounding = require("./rules-grounding");
const { normalizeOrderCode, safeTextCleanup } = require("../utils/helpers");

let runtimeConfig;
let historyManager;
let llmService;

const GREETING_KEYWORDS = ["hi", "hello", "hey", "help", "menu"];
const POLICY_KEYWORDS = ["policy", "policies", "return", "refund", "shipping", "pickup", "hours", "payment", "preorder", "pre-order", "hold", "store credit"];
const BUYLIST_KEYWORDS = ["buylist", "sell cards", "sell my cards", "trade in", "collection", "bulk", "cash offer", "store credit quote"];
const RULES_KEYWORDS = ["rules", "ruling", "judge", "priority", "stack", "combat", "mulligan", "commander tax", "layers", "trigger", "legal in"];
const ORDER_STATUS_KEYWORDS = [
	"order status",
	"track order",
	"tracking",
	"where is my order",
	"where is my package",
	"package status",
	"order code",
	"order id",
	"order number",
	"my order",
	"check my order",
	"check order",
	"order update",
	"order details",
];
const ORDER_INTENT_PATTERNS = [
	/\b(?:where|what|whats|what's|when|how|tell me|check|track|update)\b.*\b(?:order|tracking|shipment|delivery|package|parcel)\b/i,
	/\b(?:order|tracking|shipment|delivery|package|parcel)\b.*\b(?:status|update|details|progress|placed|date|time)\b/i,
	/\b(?:order|tracking)\s*(?:id|code|number|no\.?|#)\b/i,
];
const EVENT_KEYWORDS = ["event", "fnm", "draft", "prerelease", "commander night", "tournament", "modern night", "standard showdown"];
const VOUCHER_KEYWORDS = ["voucher", "promo code", "coupon", "discount code", "gift card"];
const SUPPORT_KEYWORDS = ["support", "issue", "problem", "damaged", "missing", "wrong item", "need help"];
const PRODUCT_KEYWORDS = ["product", "stock", "available", "price", "booster", "box", "bundle", "single", "card", "sleeves", "playmat", "deck box"];
const FAQ_KEYWORDS = ["faq", "frequently asked", "how do i", "how does", "what is", "can i", "do you", "when do", "opening hours", "contact", "email", "phone number", "mobile number", "whatsapp", "website", "social media", "facebook", "address", "location"];
const SHIPPING_KEYWORDS = ["shipping", "delivery", "ship", "deliver", "postage", "courier", "dispatch", "free shipping", "tracking"];
const UNSUPPORTED_ACTION_KEYWORDS = ["place order", "buy this", "reserve this", "hold this for me", "register me", "sign me up"];
const IMAGE_KEYWORDS = ["picture", "pictures", "image", "images", "photo", "photos", "pic", "pics", "artwork", "art of"];
const CARD_TYPE_HINTS = ["artifact", "battle", "creature", "enchantment", "instant", "land", "planeswalker", "sorcery", "legendary", "mythic", "rare", "uncommon", "common"];
const DIRECT_PRODUCT_HINTS = ["token", "tokens", "emblem", "emblems", "counter", "counters"];
const ACKNOWLEDGEMENT_PATTERNS = [
	/^(?:ok|okay|kk|k)\s*(?:thanks|thank you|ty)\b/i,
	/^(?:thanks|thank you|ty)(?:\s+so\s+much)?[.!?]*$/i,
	/^(?:got it|noted|understood|alright|all right|cool|nice)(?:\s+thanks|\s+thank you)?[.!?]*$/i,
];
const FOLLOW_UP_PRODUCT_HINT_PATTERNS = [
	/^(?:it'?s|its|it is|in|from|set|edition|collector|number|foil|nonfoil|non-foil|promo|borderless|extended art|extended-art)\b/i,
	/^(?:the set is|the name is|the card is)\b/i,
];
const PRODUCT_RETRY_PATTERNS = [
	/^(?:are\s+u\s+sure|are\s+you\s+sure|sure\??|check\s+again|search\s+again|try\s+again|look\s+again|query\s+tool\s+again|pls\s+query|please\s+query|run\s+it\s+again)\b/i,
];
const ORDER_RETRY_PATTERNS = [
	/^(?:are\s+u\s+sure|are\s+you\s+sure|check\s+again|track\s+again|status\s+again|refresh\s+status|retry|try\s+again|look\s+again|query\s+tool\s+again|run\s+it\s+again)\b/i,
];
const ORDER_CODE_CAPTURE_PATTERNS = [
	/\b(?:order(?:\s*(?:code|id|number|no\.?|#))?|tracking(?:\s*(?:code|id|number|no\.?|#))?)\s*(?:is|=|:)?\s*([A-Za-z0-9][A-Za-z0-9\-_/]{3,})\b/i,
	/\b(?:ref(?:erence)?|confirmation)\s*(?:code|id|number|no\.?|#)?\s*(?:is|=|:)?\s*([A-Za-z0-9][A-Za-z0-9\-_/]{3,})\b/i,
];

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

function isAcknowledgement(text) {
	const compact = safeTextCleanup(text);
	return ACKNOWLEDGEMENT_PATTERNS.some((pattern) => pattern.test(compact));
}

function looksLikeProductLookup(originalText, normalizedText) {
	const compactOriginal = safeTextCleanup(originalText);
	const compactNormalized = safeTextCleanup(normalizedText);

	if (!compactOriginal) {
		return false;
	}

	if (compactOriginal.includes("\n") && includesAny(compactNormalized, CARD_TYPE_HINTS)) {
		return true;
	}

	if (includesAny(compactNormalized, CARD_TYPE_HINTS)) {
		return true;
	}

	const tokenCount = compactOriginal.split(/\s+/).filter(Boolean).length;
	if (tokenCount === 1 && !GREETING_KEYWORDS.includes(compactNormalized)) {
		return /^[A-Za-z0-9'/-]{4,}$/.test(compactOriginal);
	}

	if (tokenCount >= 2 && tokenCount <= 8 && !GREETING_KEYWORDS.includes(compactNormalized)) {
		return true;
	}

	return false;
}

function shouldUseProductLookupFlow(originalText, normalizedText, history = []) {
	if (
		isAcknowledgement(originalText)
		|| GREETING_KEYWORDS.includes(normalizedText)
		|| isProductRetryMessage(originalText)
		|| shouldMergeWithRecentProductContext(originalText)
		|| shouldUseOrderLookupFlow(originalText, normalizedText, history)
		|| includesAny(normalizedText, EVENT_KEYWORDS)
		|| includesAny(normalizedText, VOUCHER_KEYWORDS)
		|| includesAny(normalizedText, SUPPORT_KEYWORDS)
		|| includesAny(normalizedText, POLICY_KEYWORDS)
		|| includesAny(normalizedText, BUYLIST_KEYWORDS)
		|| includesAny(normalizedText, RULES_KEYWORDS)
		|| includesAny(normalizedText, UNSUPPORTED_ACTION_KEYWORDS)
		|| includesAny(normalizedText, IMAGE_KEYWORDS)
	) {
		return false;
	}

	return includesAny(normalizedText, DIRECT_PRODUCT_HINTS) || includesAny(normalizedText, PRODUCT_KEYWORDS);
}

function detectRoute(originalText, normalizedText, history = []) {
	if (includesAny(normalizedText, UNSUPPORTED_ACTION_KEYWORDS)) {
		return { type: "unsupported_action" };
	}

	if (isAcknowledgement(originalText)) {
		return { type: "acknowledgement" };
	}

	if (includesAny(normalizedText, IMAGE_KEYWORDS)) {
		return { type: "image_redirect" };
	}

	if (includesAny(normalizedText, BUYLIST_KEYWORDS)) {
		return { type: "rag" };
	}

	if (includesAny(normalizedText, POLICY_KEYWORDS)) {
		return { type: "rag" };
	}

	if (includesAny(normalizedText, SHIPPING_KEYWORDS)) {
		return { type: "rag" };
	}

	if (includesAny(normalizedText, FAQ_KEYWORDS)) {
		return { type: "rag" };
	}

	if (includesAny(normalizedText, EVENT_KEYWORDS)) {
		return { type: "rag" };
	}

	if (includesAny(normalizedText, RULES_KEYWORDS)) {
		return { type: "rules" };
	}

	if (shouldUseOrderLookupFlow(originalText, normalizedText, history)) {
		return { type: "order_status" };
	}

	if (
		includesAny(normalizedText, EVENT_KEYWORDS)
		|| includesAny(normalizedText, ORDER_STATUS_KEYWORDS)
		|| includesAny(normalizedText, VOUCHER_KEYWORDS)
		|| includesAny(normalizedText, SUPPORT_KEYWORDS)
		|| includesAny(normalizedText, PRODUCT_KEYWORDS)
		|| includesAny(normalizedText, DIRECT_PRODUCT_HINTS)
	) {
		return { type: "store_tools" };
	}

	if (GREETING_KEYWORDS.includes(normalizedText)) {
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

function getAcknowledgementReply() {
	return "You're welcome. Send another card name or store question whenever you're ready.";
}

function getRecentUserMessages(history = [], limit = 3) {
	return history
		.filter((entry) => entry?.role === "user" && hasDisplayValue(entry.content))
		.slice(-limit)
		.map((entry) => entry.content);
}

function toUniqueNonEmptyStrings(values = []) {
	return [...new Set(
		values
			.flat()
			.map((value) => String(value || "").trim())
			.filter(Boolean),
	)];
}

function shouldMergeWithRecentProductContext(text) {
	const compact = safeTextCleanup(text);
	return FOLLOW_UP_PRODUCT_HINT_PATTERNS.some((pattern) => pattern.test(compact));
}

function isProductRetryMessage(text) {
	const compact = safeTextCleanup(text);
	return PRODUCT_RETRY_PATTERNS.some((pattern) => pattern.test(compact));
}

function isOrderRetryMessage(text) {
	const compact = safeTextCleanup(text);
	return ORDER_RETRY_PATTERNS.some((pattern) => pattern.test(compact));
}

function isLikelyOrderCode(value) {
	const normalized = normalizeOrderCode(value);
	if (!normalized || normalized.length < 5) {
		return false;
	}

	const digitCount = (normalized.match(/\d/g) || []).length;
	if (digitCount < 5) {
		return false;
	}

	if (/^[A-Z]+$/.test(normalized)) {
		return false;
	}

	if (/^\d+$/.test(normalized)) {
		return normalized.length >= 6;
	}

	return normalized.length >= 6;
}

function extractOrderCodeCandidates(text = "") {
	const compact = safeTextCleanup(text);
	if (!compact) {
		return [];
	}

	const foundCodes = [];
	const seen = new Set();
	const addCandidate = (candidate) => {
		const normalized = normalizeOrderCode(candidate);
		if (!isLikelyOrderCode(normalized)) {
			return;
		}

		const key = normalized.toLowerCase();
		if (seen.has(key)) {
			return;
		}

		seen.add(key);
		foundCodes.push(normalized);
	};

	for (const pattern of ORDER_CODE_CAPTURE_PATTERNS) {
		const match = compact.match(pattern);
		if (match && match[1]) {
			addCandidate(match[1]);
		}
	}

	const genericMatches = compact.match(/\b[A-Za-z0-9][A-Za-z0-9\-_/]{5,}\b/g) || [];
	for (const genericMatch of genericMatches) {
		addCandidate(genericMatch);
	}

	return foundCodes;
}

function getRecentLikelyOrderMessages(history = [], limit = 4) {
	return history
		.filter((entry) => entry?.role === "user" && hasDisplayValue(entry.content))
		.map((entry) => entry.content)
		.filter((content) => {
			const normalized = safeTextCleanup(content).toLowerCase();
			return includesAny(normalized, ORDER_STATUS_KEYWORDS) || extractOrderCodeCandidates(content).length > 0;
		})
		.slice(-limit);
}

function normalizeOrderLookupPlan(rawPlan = {}, text, history = []) {
	const shouldRetry = isOrderRetryMessage(text);
	const normalizedText = safeTextCleanup(text).toLowerCase();
	const shouldUseRecentOrderContext = shouldRetry || shouldUseOrderLookupFlow(text, normalizedText, history);
	const explicitCodes = toUniqueNonEmptyStrings([
		rawPlan.orderCode,
		rawPlan.order_code,
		rawPlan.code,
		rawPlan.reference,
		rawPlan.orderId,
		rawPlan.order_id,
		rawPlan.id,
		rawPlan.alternativeCodes,
		rawPlan.alternative_codes,
		rawPlan.possibleCodes,
		rawPlan.possible_codes,
	]).map(normalizeOrderCode).filter(isLikelyOrderCode);

	const extractedCurrentCodes = extractOrderCodeCandidates(text);
	const recentOrderCodes = getRecentLikelyOrderMessages(history, 4)
		.flatMap((message) => extractOrderCodeCandidates(message));

	const allCodes = toUniqueNonEmptyStrings([
		explicitCodes,
		extractedCurrentCodes,
		shouldUseRecentOrderContext ? recentOrderCodes : [],
	]).map(normalizeOrderCode).filter(isLikelyOrderCode);

	return {
		intent: "order_status_lookup",
		orderCode: allCodes[0] || "",
		alternativeCodes: allCodes.slice(1),
		confidence: safeTextCleanup(rawPlan.confidence || "low").toLowerCase() || "low",
	};
}

async function parseOrderLookupPlan(text, history) {
	const recentUserMessages = getRecentUserMessages(history, 4);
	try {
		const parsed = await llmService.generateJson({
			systemInstruction: [
				"You extract store order tracking intent from customer chat.",
				"Return JSON only.",
				"Do not answer the customer.",
				"Prefer exact order codes and references.",
				"If the current message is a retry, reuse order code context from recent user messages.",
			].join("\n"),
			history: [],
			message: [
				"Return a JSON object with these keys:",
				'{"intent":"order_status_lookup","orderCode":"","alternativeCodes":[],"confidence":"low|medium|high"}',
				"",
				`Recent user messages: ${JSON.stringify(recentUserMessages)}`,
				`Current user message: ${JSON.stringify(text)}`,
			].join("\n"),
		});

		return normalizeOrderLookupPlan(parsed.data, text, history);
	} catch (_error) {
		return normalizeOrderLookupPlan({}, text, history);
	}
}

function shouldUseOrderLookupFlow(originalText, normalizedText, history = []) {
	const directOrderIntent = includesAny(normalizedText, ORDER_STATUS_KEYWORDS)
		|| ORDER_INTENT_PATTERNS.some((pattern) => pattern.test(originalText));
	const hasOrderCode = extractOrderCodeCandidates(originalText).length > 0;
	const retry = isOrderRetryMessage(originalText);
	const recentOrderContext = getRecentLikelyOrderMessages(history, 3).length > 0;
	const hasOrderReference = /\b(order|tracking|shipment|delivery|package|parcel)\b/i.test(originalText);

	if (directOrderIntent || retry) {
		return true;
	}

	if (hasOrderReference && recentOrderContext) {
		return true;
	}

	const compact = safeTextCleanup(originalText);
	const tokenCount = compact ? compact.split(/\s+/).filter(Boolean).length : 0;
	return hasOrderCode && (hasOrderReference || tokenCount <= 3 || recentOrderContext);
}

function getRecentLikelyProductMessages(history = [], limit = 4) {
	return history
		.filter((entry) => entry?.role === "user" && hasDisplayValue(entry.content))
		.map((entry) => entry.content)
		.filter((content) => includesAny(content.toLowerCase(), DIRECT_PRODUCT_HINTS) || includesAny(content.toLowerCase(), PRODUCT_KEYWORDS))
		.slice(-limit);
}

function normalizeProductLookupPlan(rawPlan = {}, text, history = []) {
	const recentUserMessages = getRecentUserMessages(history, 3);
	const recentLikelyProductMessages = getRecentLikelyProductMessages(history, 4);
	const shouldMergeContext = shouldMergeWithRecentProductContext(text);
	const shouldRetry = isProductRetryMessage(text);
	const mergedContextCandidates = [
		...(shouldMergeContext && recentLikelyProductMessages.length
			? [`${recentLikelyProductMessages[recentLikelyProductMessages.length - 1]} ${text}`]
			: []),
		...(shouldRetry ? recentLikelyProductMessages : []),
	];

	const primaryName = safeTextCleanup(rawPlan.primaryName || rawPlan.primary_name || "");
	const alternativeNames = toUniqueNonEmptyStrings([
		rawPlan.alternativeNames,
		rawPlan.alternative_names,
		rawPlan.possibleNames,
		rawPlan.possible_names,
	]);
	const collectorNumber = safeTextCleanup(rawPlan.collectorNumber || rawPlan.collector_number || "");
	const searchCandidates = toUniqueNonEmptyStrings([
		rawPlan.searchCandidates,
		rawPlan.search_candidates,
		rawPlan.searchPhrases,
		rawPlan.search_phrases,
		primaryName,
		alternativeNames,
		collectorNumber ? `${primaryName || text} ${collectorNumber}` : "",
		mergedContextCandidates,
		text,
	]);

	return {
		intent: safeTextCleanup(rawPlan.intent || "product_lookup") || "product_lookup",
		primaryName,
		alternativeNames,
		searchCandidates,
		setHint: safeTextCleanup(rawPlan.setHint || rawPlan.set_hint || ""),
		typeHint: safeTextCleanup(rawPlan.typeHint || rawPlan.type_hint || ""),
		collectorNumber,
		confidence: safeTextCleanup(rawPlan.confidence || "low").toLowerCase() || "low",
	};
}

async function parseProductLookupPlan(text, history) {
	const recentUserMessages = getRecentUserMessages(history, 3);

	try {
		const parsed = await llmService.generateJson({
			systemInstruction: [
		"You extract structured MTG product search intent from messy customer chat.",
		"Return JSON only.",
		"Do not answer the customer.",
		"Use recent user messages when the current message is a follow-up hint.",
		"Restore likely punctuation in card names when strongly implied, including apostrophes and commas.",
		"Fix obvious misspellings and missing function words in official card names when confidence is high, including missing words like 'the'.",
		"Prefer exact card or product names over conversational filler.",
		"If the user included a set, collector number, or product variant, extract it separately.",
	].join("\n"),
			history: [],
			message: [
				"Return a JSON object with these keys:",
				'{"intent":"product_lookup","primaryName":"","alternativeNames":[],"searchCandidates":[],"setHint":"","typeHint":"","collectorNumber":"","confidence":"low|medium|high"}',
				"",
				`Recent user messages: ${JSON.stringify(recentUserMessages)}`,
				`Current user message: ${JSON.stringify(text)}`,
			].join("\n"),
		});

		return normalizeProductLookupPlan(parsed.data, text, history);
	} catch (_error) {
		return normalizeProductLookupPlan({}, text, history);
	}
}

async function refineProductLookupPlan(text, history, previousPlan, previousResult) {
	const recentUserMessages = getRecentUserMessages(history, 4);

	try {
		const parsed = await llmService.generateJson({
			systemInstruction: [
				"You repair failed MTG product searches.",
				"Return JSON only.",
				"Do not answer the customer.",
				"Propose corrected official product or card names when the first search likely missed punctuation, apostrophes, commas, missing words, or spelling.",
				"Be especially willing to add missing words like 'the' inside a title when that produces a likely official card name.",
				"Use recent user messages and any set hint to improve the correction.",
			].join("\n"),
			history: [],
			message: [
				"Return a JSON object with these keys:",
				'{"intent":"product_lookup","primaryName":"","alternativeNames":[],"searchCandidates":[],"setHint":"","typeHint":"","collectorNumber":"","confidence":"low|medium|high"}',
				"",
				`Recent user messages: ${JSON.stringify(recentUserMessages)}`,
				`Current user message: ${JSON.stringify(text)}`,
				`Previous parsed plan: ${JSON.stringify(previousPlan)}`,
				`Previous failed search candidates: ${JSON.stringify(previousResult?.searchCandidatesTried || [])}`,
				"Provide a better corrected official-name guess if the previous title looks close but wrong.",
			].join("\n"),
		});

		return normalizeProductLookupPlan(parsed.data, text, history);
	} catch (_error) {
		return normalizeProductLookupPlan({}, text, history);
	}
}

function hasDisplayValue(value) {
	return value !== undefined && value !== null && String(value).trim() !== "";
}

function formatCurrency(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? `$${numeric.toFixed(2)}` : "";
}

function pushDisplayLine(lines, label, value, formatter) {
	if (!hasDisplayValue(value)) {
		return;
	}

	const rendered = typeof formatter === "function" ? formatter(value) : String(value).trim();
	if (!hasDisplayValue(rendered)) {
		return;
	}

	lines.push(`${label}: ${rendered}`);
}

function formatConditionSummary(conditions = []) {
	return conditions
		.filter((condition) => Number(condition?.stocks) > 0)
		.map((condition) => {
			const parts = [];
			if (hasDisplayValue(condition.code)) {
				parts.push(String(condition.code).trim());
			}

			parts.push(`${Number(condition.stocks)} in stock`);

			const price = formatCurrency(condition.price || condition.usd_price);
			if (price) {
				parts.push(`from ${price}`);
			}

			return parts.join(" - ");
		})
		.filter(Boolean)
		.join("; ");
}

function getStartingPrice(product = {}) {
	const conditionPrices = Array.isArray(product.available_conditions)
		? product.available_conditions
			.map((condition) => Number(condition?.price || condition?.usd_price))
			.filter((value) => Number.isFinite(value) && value > 0)
		: [];

	if (conditionPrices.length > 0) {
		return Math.min(...conditionPrices);
	}

	return product.price;
}

function formatProductBlock(product, index) {
	const lines = [`${index}. ${product.title || product.original_title || "Product"}`];

	pushDisplayLine(lines, "Set", product.expansion || product.expansion_code);
	pushDisplayLine(lines, "Rarity", product.rarity || product.rarity_code);
	pushDisplayLine(lines, "Card number", product.card_number);
	pushDisplayLine(lines, "Stock", Number(product.totalStocks) > 0 ? `${Number(product.totalStocks)} total` : "");
	pushDisplayLine(lines, "Starting price", getStartingPrice(product), formatCurrency);
	pushDisplayLine(lines, "Conditions", formatConditionSummary(product.available_conditions));

	return lines.join("\n");
}

function getRequestedLookupLabel(execution, fallbackText) {
	const firstProductTitle = execution?.result?.products?.[0]?.title;
	if (hasDisplayValue(firstProductTitle)) {
		return firstProductTitle;
	}

	return execution?.result?.matchedCandidate
		|| execution?.args?.query
		|| execution?.args?.search
		|| fallbackText
		|| "your search";
}

function formatProductSearchReply(execution, fallbackText) {
	const result = execution?.result || {};
	if (!result.success) {
		return hasDisplayValue(result.error)
			? `I could not retrieve product information right now. ${result.error}`
			: "I could not retrieve product information right now.";
	}

	const products = Array.isArray(result.products) ? result.products : [];
	const requested = getRequestedLookupLabel(execution, fallbackText);
	if (!products.length) {
		return `I could not find a matching product for "${requested}". Please try the exact card name, set name, or collector number.`;
	}

	const visibleProducts = products.slice(0, 6);
	const header = [
		`Matching products for "${requested}":`,
		products.length > visibleProducts.length ? `Showing the first ${visibleProducts.length} results.` : "",
	].filter(Boolean).join(" ");

	return [
		header,
		...visibleProducts.map((product, index) => formatProductBlock(product, index + 1)),
	].join("\n\n");
}

function formatProductDetailsReply(execution, fallbackText) {
	const result = execution?.result || {};
	if (!result.success || !result.product) {
		return hasDisplayValue(result.error)
			? `I could not find product details. ${result.error}`
			: `I could not find product details for "${getRequestedLookupLabel(execution, fallbackText)}".`;
	}

	return [
		"Product details:",
		formatProductBlock(result.product, 1).replace(/^1\.\s/, ""),
	].join("\n\n");
}

function formatKeyLabel(key) {
	return String(key)
		.replace(/_/g, " ")
		.replace(/([a-z])([A-Z])/g, "$1 $2")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\w/, (character) => character.toUpperCase());
}

function formatGenericRecord(record, preferredKeys = []) {
	if (!record || typeof record !== "object") {
		return "";
	}

	const seen = new Set();
	const orderedKeys = [
		...preferredKeys,
		...Object.keys(record).filter((key) => !preferredKeys.includes(key)),
	];
	const lines = [];

	for (const key of orderedKeys) {
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);

		const value = record[key];
		if (Array.isArray(value) || (value && typeof value === "object")) {
			continue;
		}

		if (/(price|amount|total)$/i.test(key)) {
			pushDisplayLine(lines, formatKeyLabel(key), value, formatCurrency);
			continue;
		}

		pushDisplayLine(lines, formatKeyLabel(key), value);
	}

	return lines.join("\n");
}

function formatCollectionReply(title, items, formatter) {
	if (!Array.isArray(items) || !items.length) {
		return `${title} No records found.`;
	}

	const visibleItems = items.slice(0, 6);
	return [
		title,
		...visibleItems.map((item, index) => formatter(item, index + 1)),
	].join("\n\n");
}

function formatEventsReply(execution) {
	const result = execution?.result || {};
	if (!result.success) {
		return hasDisplayValue(result.error)
			? `I could not retrieve event information. ${result.error}`
			: "I could not retrieve event information.";
	}

	const events = result.events || result.raw?.events || result.raw?.data || result.raw?.items || [];
	return formatCollectionReply("Events:", events, (event, index) => {
		const lines = [`${index}. ${event.name || event.title || event.eventName || "Event"}`];
		pushDisplayLine(lines, "Date", event.date || event.start_date || event.startDate);
		pushDisplayLine(lines, "Format", event.format);
		pushDisplayLine(lines, "Location", event.location);
		pushDisplayLine(lines, "Entry fee", event.entry_fee || event.entryFee, formatCurrency);
		return lines.join("\n");
	});
}

function formatEventDetailsReply(execution) {
	const result = execution?.result || {};
	if (!result.success) {
		return hasDisplayValue(result.error)
			? `I could not retrieve event details. ${result.error}`
			: "I could not retrieve event details.";
	}

	const event = result.event || result.raw?.event || result.raw?.data || result.raw;
	const body = formatGenericRecord(event, [
		"name",
		"title",
		"date",
		"start_date",
		"startDate",
		"format",
		"location",
		"entry_fee",
		"entryFee",
	]);
	return body ? `Event details:\n\n${body}` : "Event details are available, but the response did not include displayable fields.";
}

const ORDER_EXTRA_DETAIL_FIELDS = [
	{ key: "tracking_no", label: "Tracking number", keywords: ["tracking", "tracking number"] },
	{ key: "payment_status", label: "Payment status", keywords: ["payment status"] },
	{ key: "payment_method", label: "Payment method", keywords: ["payment method", "how paid"] },
	{ key: "fulfillment_status", label: "Fulfillment status", keywords: ["fulfillment", "fulfilment"] },
	{ key: "customer_phone", label: "Customer phone", keywords: ["phone", "mobile", "contact number"] },
	{ key: "shipping_address", label: "Shipping address", keywords: ["shipping address", "delivery address", "address"] },
	{ key: "billing_address", label: "Billing address", keywords: ["billing address"] },
	{ key: "carrier", label: "Carrier", keywords: ["carrier", "courier"] },
	{ key: "created_at", label: "Order date", keywords: ["order date", "placed", "created"] },
	{ key: "updated_at", label: "Last updated", keywords: ["updated", "last update", "last updated"] },
	{ key: "notes", label: "Notes", keywords: ["note", "notes", "remark", "remarks"] },
];

function formatAmountValue(value) {
	if (!hasDisplayValue(value)) {
		return "";
	}

	const numeric = Number(String(value).replace(/,/g, "").replace(/[^\d.-]/g, ""));
	return Number.isFinite(numeric) ? `$${numeric.toFixed(2)}` : String(value).trim();
}

function parseEmbeddedJson(value) {
	if (value === undefined || value === null) {
		return value;
	}

	if (typeof value !== "string") {
		return value;
	}

	const trimmed = value.trim();
	if (!trimmed) {
		return "";
	}

	if (!((trimmed.startsWith("{") && trimmed.endsWith("}")) || (trimmed.startsWith("[") && trimmed.endsWith("]")))) {
		return value;
	}

	try {
		return JSON.parse(trimmed);
	} catch (_error) {
		return value;
	}
}

function formatCartItems(items = []) {
	if (!Array.isArray(items) || !items.length) {
		return "Not available";
	}

	const visibleItems = items.slice(0, 10);
	return visibleItems.map((item, index) => {
		const productDetailsRaw = parseEmbeddedJson(
			item?.product_details
			?? item?.productDetails
			?? item?.product_detail
			?? item?.productDetail
			?? "",
		);
		const productDetails = productDetailsRaw && typeof productDetailsRaw === "object"
			? productDetailsRaw
			: {};

			const name = safeTextCleanup(
				productDetails?.title
				|| productDetails?.name
				|| productDetails?.product_title
				|| productDetails?.product_name
				|| productDetails?.card_name
				|| item?.name
				|| item?.title
				|| item?.product_name
				|| item?.product_title
				|| item?.card_name
			|| "",
		) || "Item";
		const quantity = item?.quantity ?? item?.qty ?? "";
		const originalPrice = (
			item?.original_price
			?? item?.originalPrice
			?? item?.original_unit_price
			?? item?.unit_price
			?? item?.price
			?? ""
		);
		const lineTotal = item?.line_total ?? item?.final_total ?? item?.total ?? item?.price ?? "";

		const base = hasDisplayValue(originalPrice)
			? `${formatAmountValue(originalPrice)} - ${name}`
			: name;
		const parts = [base];
		if (hasDisplayValue(quantity)) {
			parts.push(`Qty ${String(quantity).trim()}`);
		}
		if (hasDisplayValue(lineTotal)) {
			parts.push(`Total ${formatAmountValue(lineTotal)}`);
		}

		return `${index + 1}. ${parts.join(" | ")}`;
	}).join("\n");
}

function readOrderField(order = {}, key = "") {
	switch (key) {
	case "tracking_no":
		return safeTextCleanup(order.tracking_no || order.tracking_number || order.trackingNumber || "");
	case "payment_status":
		return safeTextCleanup(order.payment_status || "");
	case "payment_method":
		return safeTextCleanup(order.payment_method || "");
	case "fulfillment_status":
		return safeTextCleanup(order.fulfillment_status || "");
	case "customer_phone":
		return safeTextCleanup(order.customer_phone || order.phone || "");
	case "shipping_address":
		return safeTextCleanup(order.shipping_address || "");
	case "billing_address":
		return safeTextCleanup(order.billing_address || "");
	case "carrier":
		return safeTextCleanup(order.carrier || "");
	case "created_at":
		return safeTextCleanup(order.created_at || "");
	case "updated_at":
		return safeTextCleanup(order.updated_at || order.last_updated || "");
	case "notes":
		return safeTextCleanup(order.notes || "");
	default:
		return "";
	}
}

function extractOrderExtraRequests(userText = "") {
	const normalized = safeTextCleanup(userText).toLowerCase();
	if (!normalized) {
		return { requested: [], broadRequest: false };
	}

	const requested = ORDER_EXTRA_DETAIL_FIELDS.filter((field) =>
		field.keywords.some((keyword) => normalized.includes(keyword)),
	);

	const broadRequest = (
		/\b(?:more|other|additional|full|all)\b.*\b(?:detail|details|info|information)\b/i.test(normalized)
		|| /\b(?:show|tell|give)\b.*\b(?:all|everything|full)\b.*\border\b/i.test(normalized)
	);

	return { requested, broadRequest };
}

function formatOrderStatusReply(execution, userText = "") {
	const result = execution?.result || {};
	const requestedCode = safeTextCleanup(result.orderCodeRequested || execution?.args?.orderCode || "");

	if (!result.success) {
		if (/order code is required/i.test(String(result.error || ""))) {
			return "Please share your order code so I can check the order status.";
		}

		if (isOrderNotFoundError(result.error)) {
			return requestedCode
				? `I could not find an order with code "${requestedCode}". Please check the code and resend it exactly as shown in your order confirmation.`
				: "I could not find that order. Please check the order code and resend it exactly as shown in your order confirmation.";
		}

		return hasDisplayValue(result.error)
			? `I could not retrieve the order status. ${result.error}`
			: "I could not retrieve the order status.";
	}

	const order = result.order || result.raw?.order || result.raw?.data || result.raw;
	const resolvedOrderCode = safeTextCleanup(order?.code || order?.orderCode || order?.order_code || requestedCode);
	const status = safeTextCleanup(order?.status || order?.order_status || "");
	const subtotal = order?.subtotal ?? order?.sub_total ?? order?.original_total ?? "";
	const discountAmount = order?.discount_amount ?? order?.discount_total ?? order?.discount ?? "";
	const finalTotal = order?.final_total ?? order?.total ?? "";
	const customerName = safeTextCleanup(order?.customer_name || order?.customerName || "");
	const customerEmail = safeTextCleanup(order?.customer_email || order?.customerEmail || "");
	const cartItems = Array.isArray(order?.cart_items) ? order.cart_items : [];

	const lines = [];
	pushDisplayLine(lines, "Code", resolvedOrderCode);
	pushDisplayLine(lines, "Status", status);
	pushDisplayLine(lines, "Subtotal", subtotal, formatAmountValue);
	lines.push(`Discount: ${hasDisplayValue(discountAmount) ? formatAmountValue(discountAmount) : "Not available"}`);
	pushDisplayLine(lines, "Final total", finalTotal, formatAmountValue);
	pushDisplayLine(lines, "Customer name", customerName);
	pushDisplayLine(lines, "Customer email", customerEmail);
	lines.push(`Cart items:\n${formatCartItems(cartItems)}`);

	const { requested, broadRequest } = extractOrderExtraRequests(userText);
	const extraFieldsToCheck = broadRequest ? ORDER_EXTRA_DETAIL_FIELDS : requested;
	const extraLines = [];
	let missingExtraField = false;

	for (const field of extraFieldsToCheck) {
		const value = readOrderField(order, field.key);
		if (hasDisplayValue(value)) {
			extraLines.push(`${field.label}: ${value}`);
		} else {
			missingExtraField = true;
		}
	}

	if (extraLines.length) {
		lines.push(`Additional details:\n${extraLines.join("\n")}`);
	}

	if ((requested.length > 0 || broadRequest) && missingExtraField) {
		lines.push("This is all the info that I am able to show. If you need further details, please contact the team.");
	}

	const header = resolvedOrderCode ? `Order details for "${resolvedOrderCode}":` : "Order details:";
	return `${header}\n\n${lines.join("\n")}`;
}

function isOrderNotFoundError(errorMessage) {
	const message = String(errorMessage || "");
	return /\b404\b/.test(message) || /\bnot found\b/i.test(message) || /\bno query results\b/i.test(message);
}

function formatVoucherReply(execution) {
	const result = execution?.result || {};
	if (!result.success) {
		return hasDisplayValue(result.error)
			? `I could not verify the voucher. ${result.error}`
			: "I could not verify the voucher.";
	}

	const voucher = result.voucher || result.raw?.voucher || result.raw?.data || result.raw;
	const body = formatGenericRecord(voucher, ["code", "status", "discount", "expires_at", "expiresAt"]);
	return body ? `Voucher details:\n\n${body}` : "The voucher check completed, but the response did not include displayable fields.";
}

function formatSupportReply(execution) {
	const result = execution?.result || {};
	if (result.success && hasDisplayValue(result.ticketId)) {
		return `Support request logged successfully.\n\nTicket ID: ${result.ticketId}`;
	}

	if (hasDisplayValue(result.fallbackTicketId)) {
		return `Support request prepared, but the support endpoint is not wired yet.\n\nReference ID: ${result.fallbackTicketId}`;
	}

	return hasDisplayValue(result.error)
		? `I could not log the support request. ${result.error}`
		: "I could not log the support request.";
}

function formatStoreToolReply(toolReply, fallbackText) {
	const executions = Array.isArray(toolReply?.toolExecutions) ? toolReply.toolExecutions : [];
	if (!executions.length) {
		return toolReply?.text || "I could not complete that store lookup.";
	}

	const preferredExecution = [...executions].reverse().find((execution) =>
		execution?.result?.success || hasDisplayValue(execution?.result?.error),
	) || executions[executions.length - 1];

	switch (preferredExecution?.name) {
	case "searchProducts":
		return formatProductSearchReply(preferredExecution, fallbackText);
		case "getProductDetails":
			return formatProductDetailsReply(preferredExecution, fallbackText);
		case "checkOrderStatus":
			return formatOrderStatusReply(preferredExecution, fallbackText);
	case "getEvents":
		return formatEventsReply(preferredExecution);
	case "getEventDetails":
		return formatEventDetailsReply(preferredExecution);
	case "checkVoucher":
		return formatVoucherReply(preferredExecution);
	case "logSupportRequest":
		return formatSupportReply(preferredExecution);
	default:
		return toolReply?.text || "I could not complete that store lookup.";
	}
}

function buildProductNoMatchReply(lookupPlan, execution, fallbackText) {
	const requested = getRequestedLookupLabel(execution, lookupPlan.primaryName || fallbackText);
	const clarification = "If possible, send the exact card name as written on the card. If you know the set name, collector number, card type, or product variant, send that too and I will narrow it down.";

	const websiteUrl = runtimeConfig?.storeInfo?.websiteUrl;
	const websiteFallback = websiteUrl
		? `You can also check the website directly here: ${websiteUrl}`
		: "";

	return [
		`I could not confirm an exact catalog match for "${requested}".`,
		clarification,
		websiteFallback,
	].filter(Boolean).join(" ");
}

async function handleProductLookupRoute(text, history) {
	const lookupPlan = await parseProductLookupPlan(text, history);
	const runSearch = async (plan) => storeTools.searchProducts({
		query: plan.primaryName || text,
		canonical_name: plan.primaryName,
		search_candidates: plan.searchCandidates,
		set_hint: plan.setHint,
		originalMessage: text,
	});

	let result = await runSearch(lookupPlan);
	let effectivePlan = lookupPlan;

	if (result.success && (!Array.isArray(result.products) || !result.products.length)) {
		const refinedPlan = await refineProductLookupPlan(text, history, lookupPlan, result);
		const refinedCandidates = JSON.stringify(refinedPlan.searchCandidates || []);
		const originalCandidates = JSON.stringify(lookupPlan.searchCandidates || []);
		const planChanged = (
			refinedPlan.primaryName !== lookupPlan.primaryName
			|| refinedPlan.setHint !== lookupPlan.setHint
			|| refinedCandidates !== originalCandidates
		);

		if (planChanged) {
			const refinedResult = await runSearch(refinedPlan);
			if (refinedResult.success && Array.isArray(refinedResult.products) && refinedResult.products.length) {
				result = refinedResult;
				effectivePlan = refinedPlan;
			} else if (refinedResult.success) {
				result = refinedResult;
				effectivePlan = refinedPlan;
			}
		}
	}

	const execution = {
		name: "searchProducts",
		args: {
			query: effectivePlan.primaryName || text,
			search_candidates: effectivePlan.searchCandidates,
			set_hint: effectivePlan.setHint,
		},
		result,
	};

	if (!result.success) {
		return formatStoreToolReply({ toolExecutions: [execution] }, text);
	}

	if (!Array.isArray(result.products) || !result.products.length) {
		return buildProductNoMatchReply(effectivePlan, execution, text);
	}

	return formatStoreToolReply({ toolExecutions: [execution] }, text);
}

function buildOrderCodePromptReply() {
	return "Please share your order code so I can check the status. Example format: 0405260001G.";
}

async function handleOrderStatusRoute(text, history) {
	const lookupPlan = await parseOrderLookupPlan(text, history);
	const candidateCodes = toUniqueNonEmptyStrings([
		lookupPlan.orderCode,
		lookupPlan.alternativeCodes,
	]).map(normalizeOrderCode).filter(isLikelyOrderCode).slice(0, 4);

	if (!candidateCodes.length) {
		return buildOrderCodePromptReply();
	}

	let fallbackExecution = null;
	for (const orderCode of candidateCodes) {
		const result = await storeTools.checkOrderStatus({ orderCode });
		const execution = {
			name: "checkOrderStatus",
			args: { orderCode },
			result,
		};

		fallbackExecution = execution;
		if (result.success || !isOrderNotFoundError(result.error)) {
			return formatStoreToolReply({ toolExecutions: [execution] }, text);
		}
	}

	return formatStoreToolReply({ toolExecutions: [fallbackExecution] }, text);
}

async function handleRagRoute(text, history) {
	const retrieval = await ragService.retrieveKnowledge(text);
	if (!retrieval.matches || !retrieval.matches.length) {
		return "I could not find guidance on this topic in the local knowledge base. Please contact store staff for a confirmed answer.";
	}

	const context = retrieval.matches
		.map((match, index) => `[${index + 1}] ${match.text}`)
		.join("\n\n");

	const prompt = [
		"Answer the user using only the supplied knowledge snippets.",
		"Be concise and store-support focused.",
		"Snippets may contain social media links (Facebook, Shopee), addresses, or contact info. If you see a link, you can confirm it exists.",
		"If the snippets are incomplete or do not contain the answer at all, say that the answer needs staff confirmation.",
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

	return response.text || `Here is the closest guidance I found:\n\n${context}`;
}

async function handleStoreToolsRoute(text, history, context) {
	const toolReply = await llmService.generateWithTools({
		systemInstruction: [
			runtimeConfig.aiBot.systemPrompt,
			"",
			"Use store tools whenever the answer depends on product data, events, vouchers, support logging, or order status.",
			"If the user sends only a card name, product name, or a short MTG-style listing, treat it as a product lookup and call searchProducts first.",
			"Never use emoji.",
			"Write in a professional tone.",
			"Keep replies clean and easy to scan.",
			"Do not show fields that are empty, null, or unavailable.",
			"Do not claim that an order was placed or an event registration was completed.",
		].join("\n"),
		history,
		message: text,
		toolDeclarations: storeTools.getToolDeclarations(),
		toolHandlers: storeTools.getToolHandlers(context),
	});

	return formatStoreToolReply(toolReply, text);
}

async function handleRulesRoute(text) {
	const result = await rulesGrounding.groundRulesQuery(text);
	return `${result.message} For official rulings, please consult a judge or the official Comprehensive Rules and Gatherer resources.`;
}

function handleImageRedirect() {
	const url = runtimeConfig?.storeInfo?.websiteUrl;
	if (url) {
		return `Card images and photos aren't available over WhatsApp. Please browse them on our website: ${url}`;
	}
	return "Card images and photos aren't available over WhatsApp. Please check our website for product galleries, or ask store staff for a direct link.";
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
	const history = getHistory(chatId);
	let route = detectRoute(cleanedText, normalizedText, history);

	// AI Intent Classification for ambiguous queries
	if (route.type === "out_of_scope") {
		try {
			const intentClassification = await llmService.generateJson({
				systemInstruction: [
					"You classify customer intent for an MTG store bot.",
					"Return JSON only: {'intent': 'product_lookup' | 'store_faq' | 'out_of_scope'}",
					"If asking to buy, check stock, or find specific MTG cards, sealed products, or accessories, use 'product_lookup'.",
					"If asking about store founders, hours, location, contact details (phone, email, website, social media), vision, return policy, or general questions, use 'store_faq'.",
					"If conversational or unrelated, use 'out_of_scope'."
				].join("\n"),
				history: [],
				message: `Classify this message: "${cleanedText}"`
			});
			
			const intent = intentClassification?.data?.intent;
			if (intent === "product_lookup") {
				route = { type: "store_tools" };
			} else if (intent === "store_faq") {
				route = { type: "rag" };
			}
		} catch (error) {
			console.error("Error classifying intent:", error);
		}
	}

	let reply;
	if (route.type === "greeting") {
		reply = getGreetingReply();
	} else if (route.type === "acknowledgement") {
		reply = getAcknowledgementReply();
	} else if (route.type === "unsupported_action") {
		reply = "I can help with store information, but I cannot place orders, reserve stock, or register event entries in chat yet.";
	} else if (route.type === "image_redirect") {
		reply = handleImageRedirect();
	} else if (route.type === "rag" && runtimeConfig.features.rag.enabled) {
		reply = await handleRagRoute(cleanedText, history);
	} else if (route.type === "rules") {
		reply = await handleRulesRoute(cleanedText);
	} else if (route.type === "order_status" && runtimeConfig.features.tools.enabled) {
		reply = await handleOrderStatusRoute(cleanedText, history);
	} else if (route.type === "store_tools" && runtimeConfig.features.tools.enabled) {
		const storeContext = {
			chatId,
			customerName: customerInfo?.name,
			contact: customerInfo?.number,
			originalMessage: cleanedText,
		};

		reply = shouldUseProductLookupFlow(cleanedText, normalizedText, history)
			? await handleProductLookupRoute(cleanedText, history)
			: await handleStoreToolsRoute(cleanedText, history, storeContext);
	} else {
		reply = "Please send the exact card name, set name, order code, or policy question you want me to check.";
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

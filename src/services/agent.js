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

function shouldUseProductLookupFlow(originalText, normalizedText) {
	if (
		isAcknowledgement(originalText)
		|| GREETING_KEYWORDS.includes(normalizedText)
		|| isProductRetryMessage(originalText)
		|| shouldMergeWithRecentProductContext(originalText)
		|| includesAny(normalizedText, ORDER_STATUS_KEYWORDS)
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

	return looksLikeProductLookup(originalText, normalizedText) || includesAny(normalizedText, DIRECT_PRODUCT_HINTS);
}

function detectRoute(originalText, normalizedText) {
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
		return { type: "rag", category: "buylist" };
	}

	if (includesAny(normalizedText, POLICY_KEYWORDS)) {
		return { type: "rag", category: "policies" };
	}

	if (includesAny(normalizedText, RULES_KEYWORDS)) {
		return { type: "rules" };
	}

	if (
		includesAny(normalizedText, ORDER_STATUS_KEYWORDS)
		|| includesAny(normalizedText, EVENT_KEYWORDS)
		|| includesAny(normalizedText, VOUCHER_KEYWORDS)
		|| includesAny(normalizedText, SUPPORT_KEYWORDS)
		|| includesAny(normalizedText, PRODUCT_KEYWORDS)
		|| includesAny(normalizedText, DIRECT_PRODUCT_HINTS)
		|| looksLikeProductLookup(originalText, normalizedText)
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

function getRecentLikelyProductMessages(history = [], limit = 4) {
	return history
		.filter((entry) => entry?.role === "user" && hasDisplayValue(entry.content))
		.map((entry) => entry.content)
		.filter((content) => looksLikeProductLookup(content, content.toLowerCase()) || includesAny(content.toLowerCase(), DIRECT_PRODUCT_HINTS))
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

function formatOrderStatusReply(execution) {
	const result = execution?.result || {};
	if (!result.success) {
		return hasDisplayValue(result.error)
			? `I could not retrieve the order status. ${result.error}`
			: "I could not retrieve the order status.";
	}

	const order = result.order || result.raw?.order || result.raw?.data || result.raw;
	const body = formatGenericRecord(order, [
		"orderCode",
		"code",
		"id",
		"status",
		"payment_status",
		"fulfillment_status",
		"tracking_number",
		"trackingNumber",
		"carrier",
		"total",
	]);
	return body ? `Order status:\n\n${body}` : "The order was found, but the response did not include displayable fields.";
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
		return formatOrderStatusReply(preferredExecution);
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
	const route = detectRoute(cleanedText, normalizedText);
	const history = getHistory(chatId);

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
		reply = await handleRagRoute(cleanedText, history, route.category);
	} else if (route.type === "rules") {
		reply = await handleRulesRoute(cleanedText);
	} else if (route.type === "store_tools" && runtimeConfig.features.tools.enabled) {
		const storeContext = {
			chatId,
			customerName: customerInfo?.name,
			contact: customerInfo?.number,
			originalMessage: cleanedText,
		};

		reply = shouldUseProductLookupFlow(cleanedText, normalizedText)
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

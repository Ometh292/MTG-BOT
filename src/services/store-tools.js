const { generateTicketId, normalizeOrderCode, safeTextCleanup } = require("../utils/helpers");

let runtimeConfig;

const CARD_TYPE_TOKENS = [
	"artifact",
	"battle",
	"creature",
	"enchantment",
	"instant",
	"land",
	"planeswalker",
	"sorcery",
	"legendary",
	"basic",
	"snow",
	"kindred",
	"wall",
];

const LEADING_CHATTER_PATTERNS = [
	/^(?:do\s+you\s+have|do\s+u\s+have|can\s+you\s+check|could\s+you\s+check|check\s+for|looking\s+for|i\s+want|i\s+need|how\s+about|what\s+about|find|search\s+for)\s+/i,
	/^(?:any|have\s+you\s+got)\s+/i,
];

const TRAILING_CHATTER_PATTERNS = [
	/\b(?:mtg\s+)?cards?\??$/i,
	/\bproduct\??$/i,
	/\bin\s+stock\??$/i,
	/\bavailable\??$/i,
];

function initialize(config) {
	runtimeConfig = config;
}

function stripWrappingQuotes(value) {
	return String(value || "")
		.replace(/^["'\u201C\u201D\u2018\u2019]+/, "")
		.replace(/["'\u201C\u201D\u2018\u2019]+$/, "")
		.trim();
}

function normalizeSearchCandidate(value) {
	let normalized = stripWrappingQuotes(String(value || ""))
		.replace(/[\u2013\u2014]/g, " ")
		.replace(/[\u2018\u2019]/g, "'")
		.replace(/[\u201C\u201D]/g, "\"")
		.replace(/[()[\]{}]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	for (const pattern of LEADING_CHATTER_PATTERNS) {
		normalized = normalized.replace(pattern, "");
	}

	for (const pattern of TRAILING_CHATTER_PATTERNS) {
		normalized = normalized.replace(pattern, "");
	}

	return normalized.trim();
}

function toUniqueNonEmptyStrings(values = []) {
	return [...new Set(
		values
			.flat()
			.map((value) => String(value || "").trim())
			.filter(Boolean),
	)];
}

function addCandidateWithVariants(addCandidate, value) {
	const candidate = normalizeSearchCandidate(value);
	if (!candidate) {
		return;
	}

	addCandidate(candidate);

	const withoutCommas = candidate.replace(/,/g, " ").replace(/\s+/g, " ").trim();
	if (withoutCommas !== candidate) {
		addCandidate(withoutCommas);
	}

	const withoutApostrophes = candidate.replace(/['`]/g, "").replace(/\s+/g, " ").trim();
	if (withoutApostrophes && withoutApostrophes !== candidate) {
		addCandidate(withoutApostrophes);
	}
}

function extractCardNamePrefix(value) {
	const tokens = normalizeSearchCandidate(value).split(/\s+/).filter(Boolean);
	if (tokens.length < 2) {
		return "";
	}

	const typeIndex = tokens.findIndex((token) => CARD_TYPE_TOKENS.includes(token.toLowerCase()));
	if (typeIndex >= 2) {
		return tokens.slice(0, typeIndex).join(" ");
	}

	return "";
}

function buildSearchCandidates({
	explicitCandidates = [],
	values = [],
	setHint = "",
}) {
	const candidates = [];
	const seen = new Set();

	function addCandidate(value) {
		const candidate = normalizeSearchCandidate(value);
		if (!candidate) {
			return;
		}

		const key = candidate.toLowerCase();
		if (seen.has(key)) {
			return;
		}

		seen.add(key);
		candidates.push(candidate);
	}

	for (const explicitCandidate of toUniqueNonEmptyStrings(explicitCandidates)) {
		addCandidateWithVariants(addCandidate, explicitCandidate);
		if (setHint) {
			addCandidateWithVariants(addCandidate, `${explicitCandidate} ${setHint}`);
		}
	}

	for (const value of values) {
		const text = String(value || "");
		if (!text.trim()) {
			continue;
		}

		addCandidateWithVariants(addCandidate, text);
		const normalized = normalizeSearchCandidate(text);
		const inSetMatch = normalized.match(/^(.+?)\s+in\s+(.+)$/i);
		if (inSetMatch) {
			addCandidateWithVariants(addCandidate, `${inSetMatch[1]} ${inSetMatch[2]}`);
			addCandidateWithVariants(addCandidate, inSetMatch[1]);
		}

		const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
		if (lines.length > 1) {
			addCandidateWithVariants(addCandidate, lines[0]);
		}

		const prefix = extractCardNamePrefix(text);
		if (prefix) {
			addCandidateWithVariants(addCandidate, prefix);
		}
	}

	const withLeadingArticles = [...candidates];
	for (const candidate of withLeadingArticles) {
		if (!/^(the|a|an)\b/i.test(candidate)) {
			addCandidateWithVariants(addCandidate, `The ${candidate}`);
		}
	}

	return candidates;
}

async function getFetch() {
	return (await import("node-fetch")).default;
}

async function requestStoreApi(endpoint, options = {}) {
	const baseUrl = runtimeConfig?.storeApi?.baseUrl;
	if (!baseUrl) {
		throw new Error("STORE_API_BASE_URL is not configured");
	}

	const fetch = await getFetch();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), runtimeConfig.storeApi.timeoutMs);

	try {
		const response = await fetch(`${baseUrl.replace(/\/$/, "")}${endpoint}`, {
			...options,
			headers: {
				"Content-Type": "application/json",
				...(runtimeConfig.storeApi.apiKey ? { "x-api-key": runtimeConfig.storeApi.apiKey } : {}),
				...(options.headers || {}),
			},
			signal: controller.signal,
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Store API ${response.status}: ${errorText}`);
		}

		return response.status === 204 ? {} : response.json();
	} finally {
		clearTimeout(timeout);
	}
}

function buildProductsQuery(params = {}) {
	const searchParams = new URLSearchParams();

	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null || value === "") {
			continue;
		}

		searchParams.set(key, String(value));
	}

	const queryString = searchParams.toString();
	return `/api/products${queryString ? `?${queryString}` : ""}`;
}

function normalizeProductsResponse(apiResult) {
	if (Array.isArray(apiResult)) {
		return apiResult;
	}

	if (Array.isArray(apiResult?.data)) {
		return apiResult.data;
	}

	if (Array.isArray(apiResult?.products)) {
		return apiResult.products;
	}

	if (Array.isArray(apiResult?.items)) {
		return apiResult.items;
	}

	return [];
}

function normalizeTitleForMatch(value) {
	return String(value || "")
		.toLowerCase()
		.replace(/[()[\]{}"'.,:;!?-]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function extractSetHint(...values) {
	for (const value of values) {
		const normalized = normalizeSearchCandidate(value);
		const match = normalized.match(/^.+?\s+in\s+(.+)$/i);
		if (match && match[1]) {
			return match[1].trim();
		}
	}

	return "";
}

function normalizeSetHint(value) {
	return normalizeSearchCandidate(value);
}

function filterProductsBySetHint(products = [], setHint = "") {
	const normalizedHint = normalizeTitleForMatch(setHint);
	if (!normalizedHint) {
		return products;
	}

	const hintTokens = normalizedHint.split(" ").filter(Boolean);
	if (!hintTokens.length) {
		return products;
	}

	const filtered = products.filter((product) => {
		const haystack = normalizeTitleForMatch([
			product.expansion,
			product.expansion_code,
			product.title,
			product.original_title,
		].filter(Boolean).join(" "));

		return hintTokens.every((token) => haystack.includes(token));
	});

	return filtered.length ? filtered : products;
}

async function searchProductsByCandidate(candidate, params = {}) {
	const apiResult = await requestStoreApi(buildProductsQuery({
		search: candidate,
		category_id: params.category_id || params.category,
		expansion_code: params.expansion_code,
		variation_code: params.variation_code,
		rarity_code: params.rarity_code,
		type_code: params.type_code,
		in_stock: params.in_stock === undefined ? true : params.in_stock,
		is_paginated: params.is_paginated === undefined ? true : params.is_paginated,
		limit: params.limit || 50,
		order_by: params.order_by,
	}));

	const products = normalizeProductsResponse(apiResult).map(summarizeProduct);
	return {
		apiResult,
		products,
	};
}

async function searchWithFallback(params = {}, context = {}) {
	const explicitCandidates = toUniqueNonEmptyStrings([
		params.canonical_name,
		params.search_candidates,
	]);
	const setHint = normalizeSetHint(
		params.set_hint
		|| extractSetHint(
			context.originalMessage,
			params.search,
			params.query,
		),
	);
	const candidates = buildSearchCandidates({
		explicitCandidates,
		values: [
			params.search,
			params.query,
			context.originalMessage,
		],
		setHint,
	});

	if (!candidates.length) {
		return {
			success: true,
			source: "store_api",
			products: [],
		};
	}

	const desiredMatches = new Set(candidates.map((candidate) => normalizeTitleForMatch(candidate)));
	let firstFilteredNonEmptyResult = null;
	let firstRawNonEmptyResult = null;

	for (const candidate of candidates) {
		const { apiResult, products } = await searchProductsByCandidate(candidate, params);
		const scopedProducts = filterProductsBySetHint(products, setHint);
		const exactProducts = scopedProducts.filter((product) => {
			const possibleTitles = [
				product.title,
				product.original_title,
			].map(normalizeTitleForMatch);
			return possibleTitles.some((title) => desiredMatches.has(title));
		});

		if (exactProducts.length > 0) {
			return {
				success: true,
				source: "store_api",
				products: exactProducts,
				pagination: {
					current_page: apiResult.current_page,
					last_page: apiResult.last_page,
					per_page: apiResult.per_page,
					total: apiResult.total,
				},
				raw: apiResult,
				searchCandidatesTried: candidates,
				matchedCandidate: candidate,
				setHintUsed: setHint,
			};
		}

		if (!firstFilteredNonEmptyResult && scopedProducts.length > 0) {
			firstFilteredNonEmptyResult = {
				success: true,
				source: "store_api",
				products: scopedProducts,
				pagination: {
					current_page: apiResult.current_page,
					last_page: apiResult.last_page,
					per_page: apiResult.per_page,
					total: apiResult.total,
				},
				raw: apiResult,
				searchCandidatesTried: candidates,
				matchedCandidate: candidate,
				setHintUsed: setHint,
			};
		}

		if (!firstRawNonEmptyResult && products.length > 0) {
			firstRawNonEmptyResult = {
				success: true,
				source: "store_api",
				products,
				pagination: {
					current_page: apiResult.current_page,
					last_page: apiResult.last_page,
					per_page: apiResult.per_page,
					total: apiResult.total,
				},
				raw: apiResult,
				searchCandidatesTried: candidates,
				matchedCandidate: candidate,
				setHintUsed: setHint,
			};
		}
	}

	if (firstFilteredNonEmptyResult) {
		return firstFilteredNonEmptyResult;
	}

	if (firstRawNonEmptyResult) {
		return firstRawNonEmptyResult;
	}

	return {
		success: true,
		source: "store_api",
		products: [],
		searchCandidatesTried: candidates,
		setHintUsed: setHint,
	};
}

function toNumber(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : 0;
}

function summarizeCondition(condition) {
	return {
		code: condition.code,
		price: condition.price,
		stocks: toNumber(condition.stocks),
		usd_price: condition.usd_price,
	};
}

function summarizeProduct(product) {
	const conditions = Array.isArray(product.conditions) ? product.conditions : [];
	const availableConditions = conditions
		.map(summarizeCondition)
		.filter((condition) => condition.stocks > 0);

	return {
		id: product.id,
		title: product.title,
		original_title: product.original_title,
		expansion_code: product.expansion_code,
		expansion: product.expansion,
		card_number: product.card_number,
		rarity_code: product.rarity_code,
		rarity: product.rarity,
		type_code: product.type_code,
		variation_code: product.variation_code,
		price: product.price,
		totalStocks: toNumber(product.totalStocks),
		default_condition_code: product.default_condition_code,
		available: toNumber(product.totalStocks) > 0 || availableConditions.length > 0,
		available_conditions: availableConditions,
		mana_cost: product.mana_cost,
		mana_value: product.mana_value,
		artist: product.artist,
		ability: product.ability,
		ruling: product.ruling,
		scryfall_id: product.scryfall_id,
	};
}

function unsupportedTool(toolName) {
	return {
		success: false,
		source: "store_api",
		error: `${toolName} is not wired yet. The required store API endpoint was not provided.`,
	};
}

async function searchProducts({
	query,
	search,
	search_candidates,
	canonical_name,
	set_hint,
	category,
	category_id,
	expansion_code,
	variation_code,
	rarity_code,
	type_code,
	in_stock,
	is_paginated,
	limit,
	order_by,
	originalMessage,
}) {
	try {
		return await searchWithFallback({
			query,
			search,
			search_candidates,
			canonical_name,
			set_hint,
			category,
			category_id,
			expansion_code,
			variation_code,
			rarity_code,
			type_code,
			in_stock,
			is_paginated,
			limit,
			order_by,
		}, {
			originalMessage,
		});
	} catch (error) {
		return {
			success: false,
			source: "store_api",
			error: error.message,
		};
	}
}

async function getProductDetails({
	id,
	product_id,
	search,
	query,
	search_candidates,
	canonical_name,
	set_hint,
	expansion_code,
	variation_code,
	rarity_code,
	type_code,
	category_id,
	originalMessage,
}) {
	const identifier = safeTextCleanup(id || product_id || search || query);

	try {
		if (identifier && /^\d+$/.test(identifier)) {
			const apiResult = await requestStoreApi(`/api/products/${encodeURIComponent(identifier)}`);
			return {
				success: true,
				source: "store_api",
				product: summarizeProduct(apiResult.product || apiResult.data || apiResult),
				raw: apiResult,
			};
		}

		const searchResult = await searchWithFallback({
			search: identifier,
			search_candidates,
			canonical_name,
			set_hint,
			category_id,
			expansion_code,
			variation_code,
			rarity_code,
			type_code,
			in_stock: true,
			is_paginated: true,
			limit: 10,
		}, {
			originalMessage,
		});

		const products = Array.isArray(searchResult.products) ? searchResult.products : [];
		return {
			success: products.length > 0,
			source: "store_api",
			product: products[0] || null,
			raw: searchResult.raw,
			...(products.length === 0 ? { error: `No product matched "${identifier}"` } : {}),
		};
	} catch (error) {
		return {
			success: false,
			source: "store_api",
			error: error.message,
		};
	}
}

async function checkOrderStatus({ orderCode }) {
	const normalizedOrderCode = normalizeOrderCode(orderCode);

	try {
		const apiResult = await requestStoreApi(`/api/orders/${encodeURIComponent(normalizedOrderCode)}`);
		return {
			success: true,
			source: "store_api",
			order: apiResult.order || apiResult.data || apiResult,
			raw: apiResult,
		};
	} catch (error) {
		return {
			success: false,
			source: "store_api",
			error: error.message,
		};
	}
}

async function getEvents({ format, dateRange }) {
	return unsupportedTool("getEvents");
}

async function getEventDetails({ eventId }) {
	return unsupportedTool("getEventDetails");
}

async function checkVoucher({ code }) {
	return unsupportedTool("checkVoucher");
}

async function logSupportRequest({ customerName, contact, topic, details, priority, chatId }) {
	const payload = {
		customerName: safeTextCleanup(customerName || "Unknown customer"),
		contact: safeTextCleanup(contact || chatId || "WhatsApp"),
		topic: safeTextCleanup(topic),
		details: safeTextCleanup(details),
		priority: safeTextCleanup(priority || "normal"),
		chatId: safeTextCleanup(chatId || ""),
	};

	return {
		success: false,
		source: "store_api",
		error: "logSupportRequest is not wired yet. The required support API endpoint was not provided.",
		fallbackTicketId: generateTicketId("MTG"),
		payload,
	};
}

function getToolDeclarations() {
	return [
		{
			name: "searchProducts",
			description: "Search the MTG store catalog for singles, sealed product, or accessories.",
			parametersJsonSchema: {
				type: "object",
				properties: {
					query: { type: "string", description: "Product keywords from the customer." },
					search: { type: "string", description: "Search string for /api/products." },
					category_id: { type: "string", description: "Category ID filter." },
					expansion_code: { type: "string", description: "Expansion code filter such as LEA." },
					variation_code: { type: "string", description: "Variation code filter." },
					rarity_code: { type: "string", description: "Rarity code filter." },
					type_code: { type: "string", description: "Type code filter." },
					in_stock: { type: "boolean", description: "Filter to in-stock products." },
					is_paginated: { type: "boolean", description: "Whether to request paginated results." },
					limit: { type: "number", description: "Maximum number of results." },
					order_by: { type: "string", description: "Sort order such as Price High to Low." },
				},
				required: [],
			},
		},
		{
			name: "getProductDetails",
			description: "Get product details by product ID if available, otherwise search for the closest product match.",
			parametersJsonSchema: {
				type: "object",
				properties: {
					id: { type: "string", description: "Product ID for /api/products/{id} if known." },
					product_id: { type: "string", description: "Alias for product ID." },
					search: { type: "string", description: "Search string when an exact product ID is not known." },
					query: { type: "string", description: "Alias for search string." },
					category_id: { type: "string", description: "Optional category ID filter." },
					expansion_code: { type: "string", description: "Optional expansion code filter." },
					variation_code: { type: "string", description: "Optional variation code filter." },
					rarity_code: { type: "string", description: "Optional rarity code filter." },
					type_code: { type: "string", description: "Optional type code filter." },
				},
				required: [],
			},
		},
		{
			name: "checkOrderStatus",
			description: "Look up the status of an existing store order via /api/orders/{id}.",
			parametersJsonSchema: {
				type: "object",
				properties: {
					orderCode: { type: "string", description: "Customer order ID or order reference." },
				},
				required: ["orderCode"],
			},
		},
		{
			name: "getEvents",
			description: "List current or upcoming MTG store events.",
			parametersJsonSchema: {
				type: "object",
				properties: {
					format: { type: "string", description: "Optional event format such as Draft or Commander." },
					dateRange: { type: "string", description: "Optional date window." },
				},
			},
		},
		{
			name: "getEventDetails",
			description: "Get details for a specific MTG store event.",
			parametersJsonSchema: {
				type: "object",
				properties: {
					eventId: { type: "string", description: "Internal store event ID." },
				},
				required: ["eventId"],
			},
		},
		{
			name: "checkVoucher",
			description: "Check whether a voucher or promo code is valid.",
			parametersJsonSchema: {
				type: "object",
				properties: {
					code: { type: "string", description: "Voucher, gift code, or promo code." },
				},
				required: ["code"],
			},
		},
		{
			name: "logSupportRequest",
			description: "Create a support request for a store staff follow-up.",
			parametersJsonSchema: {
				type: "object",
				properties: {
					customerName: { type: "string" },
					contact: { type: "string" },
					topic: { type: "string" },
					details: { type: "string" },
					priority: { type: "string", enum: ["low", "normal", "high"] },
				},
				required: ["topic", "details"],
			},
		},
	];
}

function getToolHandlers(context = {}) {
	return {
		searchProducts: (args) =>
			searchProducts({
				...args,
				originalMessage: context.originalMessage,
			}),
		getProductDetails: (args) =>
			getProductDetails({
				...args,
				originalMessage: context.originalMessage,
			}),
		checkOrderStatus,
		getEvents,
		getEventDetails,
		checkVoucher,
		logSupportRequest: (args) =>
			logSupportRequest({
				...args,
				customerName: args.customerName || context.customerName,
				contact: args.contact || context.contact,
				chatId: context.chatId,
			}),
	};
}

module.exports = {
	initialize,
	searchProducts,
	getProductDetails,
	checkOrderStatus,
	getEvents,
	getEventDetails,
	checkVoucher,
	logSupportRequest,
	getToolDeclarations,
	getToolHandlers,
};

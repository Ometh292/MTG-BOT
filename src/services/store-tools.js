const { generateTicketId, normalizeOrderCode, safeTextCleanup } = require("../utils/helpers");

let runtimeConfig;

function initialize(config) {
	runtimeConfig = config;
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
}) {
	const cleanSearch = safeTextCleanup(search || query);

	try {
		const apiResult = await requestStoreApi(buildProductsQuery({
			search: cleanSearch,
			category_id: category_id || category,
			expansion_code,
			variation_code,
			rarity_code,
			type_code,
			in_stock: in_stock === undefined ? true : in_stock,
			is_paginated: is_paginated === undefined ? true : is_paginated,
			limit: limit || 50,
			order_by,
		}));

		return {
			success: true,
			source: "store_api",
			products: normalizeProductsResponse(apiResult).map(summarizeProduct),
			pagination: {
				current_page: apiResult.current_page,
				last_page: apiResult.last_page,
				per_page: apiResult.per_page,
				total: apiResult.total,
			},
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

async function getProductDetails({
	id,
	product_id,
	search,
	query,
	expansion_code,
	variation_code,
	rarity_code,
	type_code,
	category_id,
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

		const apiResult = await requestStoreApi(buildProductsQuery({
			search: identifier,
			category_id,
			expansion_code,
			variation_code,
			rarity_code,
			type_code,
			in_stock: true,
			is_paginated: true,
			limit: 1,
		}));

		const products = normalizeProductsResponse(apiResult);
		return {
			success: products.length > 0,
			source: "store_api",
			product: products[0] ? summarizeProduct(products[0]) : null,
			raw: apiResult,
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
		searchProducts,
		getProductDetails,
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

const { generateTicketId, normalizeOrderCode, safeTextCleanup } = require("../utils/helpers");

let runtimeConfig;
let moxAccessToken = null;
let moxLoginPromise = null;

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
	clearMoxToken();
	moxLoginPromise = null;
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

function getMoxConfig() {
	const moxApi = runtimeConfig?.moxApi || {};
	return {
		baseUrl: String(moxApi.baseUrl || "").trim(),
		username: String(moxApi.username || "").trim(),
		password: String(moxApi.password || "").trim(),
		userType: String(moxApi.userType || "Customer").trim(),
		timeoutMs: Number(moxApi.timeoutMs || runtimeConfig?.storeApi?.timeoutMs || 10000),
	};
}

function hasMoxCredentials() {
	const config = getMoxConfig();
	return Boolean(config.baseUrl && config.username && config.password);
}

function hasMoxBaseUrl() {
	return Boolean(getMoxConfig().baseUrl);
}

function getApiErrorMessage(payload, fallback = "") {
	if (!payload || typeof payload !== "object") {
		return fallback;
	}

	if (typeof payload.message === "string" && payload.message.trim()) {
		return payload.message.trim();
	}

	return fallback;
}

function truncateForError(value, maxLength = 280) {
	const text = String(value || "").replace(/\s+/g, " ").trim();
	if (!text) {
		return "";
	}

	return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function parseApiPayload(text = "") {
	const trimmed = String(text || "").trim();
	if (!trimmed) {
		return {};
	}

	return JSON.parse(trimmed);
}

function isAbortError(error) {
	if (!error) {
		return false;
	}

	const name = String(error.name || "").toLowerCase();
	const message = String(error.message || "").toLowerCase();
	return name === "aborterror" || message.includes("aborted");
}

async function requestMoxApi(method, endpoint, options = {}) {
	const config = getMoxConfig();
	if (!config.baseUrl) {
		throw new Error("MOX_API_BASE_URL is not configured");
	}

	const runRequest = async () => {
		const token = await getMoxAccessToken();
		const fetch = await getFetch();
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

		try {
			const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}${endpoint}`, {
				...options,
				method,
				headers: {
					Accept: "application/json",
					"Content-Type": "application/json",
					Authorization: `Bearer ${token}`,
					...(options.headers || {}),
				},
				signal: controller.signal,
			});

			if (response.status === 401) {
				return { unauthorized: true, response };
			}

			const payloadText = await response.text();
			if (!response.ok) {
				let message = "";
				try {
					const payload = parseApiPayload(payloadText);
					message = getApiErrorMessage(payload, "");
				} catch (_error) {
					message = truncateForError(payloadText);
				}

				throw new Error(`Mox API ${response.status}: ${message || "Request failed"}`);
			}

			let payload = {};
			if (response.status !== 204) {
				try {
					payload = parseApiPayload(payloadText);
				} catch (_error) {
					const contentType = response.headers.get("content-type") || "unknown";
					throw new Error(`Mox API returned non-JSON response (${contentType}) for ${endpoint}`);
				}
			}

			return {
				unauthorized: false,
				response,
				payload,
			};
		} catch (error) {
			if (isAbortError(error)) {
				throw new Error(`Mox API request timed out after ${config.timeoutMs}ms (${method} ${endpoint}).`);
			}

			throw error;
		} finally {
			clearTimeout(timeout);
		}
	};

	let result = await runRequest();
	if (result.unauthorized) {
		clearMoxToken();
		result = await runRequest();
		if (result.unauthorized) {
			const errorText = await result.response.text();
			throw new Error(`Mox API 401: ${errorText}`);
		}
	}

	return result.payload;
}

async function getMoxAccessToken() {
	if (moxAccessToken) {
		return moxAccessToken;
	}

	if (!moxLoginPromise) {
		moxLoginPromise = loginToMoxApi().finally(() => {
			moxLoginPromise = null;
		});
	}

	moxAccessToken = await moxLoginPromise;
	return moxAccessToken;
}

async function loginToMoxApi() {
	const config = getMoxConfig();
	if (!config.baseUrl || !config.username || !config.password) {
		throw new Error("MOX API credentials are not fully configured");
	}

	const fetch = await getFetch();
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

	try {
		const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/login`, {
			method: "POST",
			headers: {
				Accept: "application/json",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				username: config.username,
				password: config.password,
				type: config.userType || "Customer",
				remember: true,
			}),
			signal: controller.signal,
		});

		const payloadText = await response.text();
		let payload = {};
		if (payloadText) {
			try {
				payload = JSON.parse(payloadText);
			} catch (_error) {
				payload = {};
			}
		}

		if (!response.ok) {
			const message = getApiErrorMessage(payload, payloadText);
			throw new Error(`Mox login failed (${response.status}): ${message}`);
		}

			const token = safeTextCleanup(payload.token);
			if (!token) {
				throw new Error("Mox login response did not include a token");
			}

			return token;
	} catch (error) {
		if (isAbortError(error)) {
			throw new Error(`Mox login timed out after ${config.timeoutMs}ms.`);
		}

		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

function clearMoxToken() {
	moxAccessToken = null;
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

function toBoundedInteger(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) {
		return fallback;
	}

	const normalized = Math.trunc(parsed);
	if (normalized < min) {
		return min;
	}
	if (normalized > max) {
		return max;
	}
	return normalized;
}

function wait(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getProductApiConfig() {
	const productApi = runtimeConfig?.productApi || {};
	const storeApi = runtimeConfig?.storeApi || {};

	return {
		baseUrl: safeTextCleanup(productApi.baseUrl || storeApi.baseUrl || ""),
		searchPath: safeTextCleanup(productApi.searchPath || "/cards/search") || "/cards/search",
		timeoutMs: toBoundedInteger(productApi.timeoutMs || storeApi.timeoutMs || 10000, 10000, 1000, 120000),
		defaultLimit: toBoundedInteger(productApi.defaultLimit || 24, 24, 1, 100),
		maxUserVisibleResults: toBoundedInteger(productApi.maxUserVisibleResults || 6, 6, 1, 20),
		maxSearchCandidates: toBoundedInteger(productApi.maxSearchCandidates || 5, 5, 1, 12),
		maxRetries: toBoundedInteger(productApi.maxRetries || 2, 2, 0, 5),
		retryDelayMs: toBoundedInteger(productApi.retryDelayMs || 500, 500, 50, 10000),
	};
}

function normalizeEndpointPath(value, fallback = "/") {
	const normalized = safeTextCleanup(value || fallback) || fallback;
	return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function isTransientStatusCode(statusCode) {
	return statusCode === 408 || statusCode === 409 || statusCode === 425 || statusCode === 429 || statusCode >= 500;
}

function isTransientNetworkError(error) {
	const message = String(error?.message || error || "").toLowerCase();
	return (
		message.includes("fetch failed")
		|| message.includes("econnreset")
		|| message.includes("socket hang up")
		|| message.includes("etimedout")
		|| message.includes("timed out")
		|| message.includes("eai_again")
		|| message.includes("enotfound")
	);
}

async function requestProductApi(endpoint, options = {}) {
	const config = getProductApiConfig();
	if (!config.baseUrl) {
		throw new Error("PRODUCT_API_BASE_URL is not configured");
	}

	const fetch = await getFetch();
	const normalizedEndpoint = normalizeEndpointPath(endpoint, config.searchPath);
	const baseUrl = config.baseUrl.replace(/\/$/, "");
	const url = `${baseUrl}${normalizedEndpoint}`;

	let lastError = null;
	for (let attempt = 0; attempt <= config.maxRetries; attempt += 1) {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

		try {
			const response = await fetch(url, {
				...options,
				headers: {
					Accept: "*/*",
					...(options.headers || {}),
				},
				signal: controller.signal,
			});

			const payloadText = await response.text();
			if (!response.ok) {
				let message = "";
				try {
					const payload = parseApiPayload(payloadText);
					message = getApiErrorMessage(payload, "");
				} catch (_error) {
					message = truncateForError(payloadText);
				}

				const error = new Error(`Product API ${response.status}: ${message || "Request failed"}`);
				if (attempt < config.maxRetries && isTransientStatusCode(response.status)) {
					lastError = error;
					await wait(config.retryDelayMs * (attempt + 1));
					continue;
				}

				throw error;
			}

			if (response.status === 204) {
				return {};
			}

			try {
				return parseApiPayload(payloadText);
			} catch (_error) {
				const contentType = response.headers.get("content-type") || "unknown";
				throw new Error(`Product API returned non-JSON response (${contentType}) for ${normalizedEndpoint}`);
			}
		} catch (error) {
			if (isAbortError(error)) {
				lastError = new Error(`Product API request timed out after ${config.timeoutMs}ms (${normalizedEndpoint}).`);
			} else {
				lastError = error;
			}

			if (attempt < config.maxRetries && (isAbortError(error) || isTransientNetworkError(error))) {
				await wait(config.retryDelayMs * (attempt + 1));
				continue;
			}

			throw lastError;
		} finally {
			clearTimeout(timeout);
		}
	}

	throw lastError || new Error("Product API request failed.");
}

function buildLegacyProductsQuery(params = {}) {
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

function buildCardSearchQuery(params = {}) {
	const searchParams = new URLSearchParams();
	for (const [key, value] of Object.entries(params)) {
		if (value === undefined || value === null || value === "") {
			continue;
		}
		searchParams.set(key, String(value));
	}
	return searchParams.toString();
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

function normalizeCardSearchResponse(apiResult) {
	if (Array.isArray(apiResult)) {
		return apiResult;
	}

	const candidateArrays = [
		apiResult?.data,
		apiResult?.data?.cards,
		apiResult?.data?.items,
		apiResult?.payload?.data,
		apiResult?.cards,
		apiResult?.items,
		apiResult?.results,
		apiResult?.rows,
	];
	for (const value of candidateArrays) {
		if (Array.isArray(value)) {
			return value;
		}
	}

	return [];
}

function shouldTryAlternateProductSearchPath(error) {
	const message = String(error?.message || error || "").toLowerCase();
	return (
		message.includes("non-json response")
		|| message.includes(" 404")
		|| message.includes(" 405")
		|| message.includes("cannot get")
		|| message.includes("not found")
	);
}

function getProductSearchPaths() {
	const config = getProductApiConfig();
	const primaryPath = normalizeEndpointPath(config.searchPath || "/cards/search", "/cards/search").replace(/\/+$/, "") || "/cards/search";
	const secondaryPath = primaryPath.startsWith("/api/")
		? primaryPath.replace(/^\/api/, "") || "/cards/search"
		: `/api${primaryPath}`;
	return [...new Set([primaryPath, secondaryPath].filter(Boolean))];
}

function normalizeTitleForMatch(value) {
	return String(value || "")
		.toLowerCase()
		.replace(/[()[\]{}"'.,:;!?-]/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function tokenizeForMatch(value) {
	return normalizeTitleForMatch(value).split(" ").filter(Boolean);
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

function scoreProductForCandidate(product = {}, candidate = "", setHint = "") {
	const normalizedCandidate = normalizeTitleForMatch(candidate);
	const candidateTokens = tokenizeForMatch(candidate);
	const title = normalizeTitleForMatch(product.title || product.original_title || "");
	const setValue = normalizeTitleForMatch(`${product.expansion || ""} ${product.expansion_code || ""}`);
	const setHintTokens = tokenizeForMatch(setHint);
	const collectorNumber = normalizeTitleForMatch(product.card_number || "");

	let score = 0;
	if (title && normalizedCandidate && title === normalizedCandidate) {
		score += 1000;
	}
	if (title && normalizedCandidate && title.startsWith(normalizedCandidate)) {
		score += 700;
	}

	let tokenMatches = 0;
	for (const token of candidateTokens) {
		if (title.includes(token)) {
			tokenMatches += 1;
		}
	}
	score += tokenMatches * 60;
	if (candidateTokens.length > 0 && tokenMatches === candidateTokens.length) {
		score += 240;
	}

	if (setHintTokens.length > 0) {
		let setMatches = 0;
		for (const token of setHintTokens) {
			if (setValue.includes(token)) {
				setMatches += 1;
			}
		}
		score += setMatches * 80;
		if (setMatches === setHintTokens.length) {
			score += 180;
		} else if (setMatches === 0) {
			score -= 80;
		}
	}

	if (candidateTokens.some((token) => token === collectorNumber) && collectorNumber) {
		score += 120;
	}

	return score;
}

function rankProductsForCandidate(products = [], candidate = "", setHint = "") {
	return products
		.map((product, index) => ({
			...product,
			_rankScore: scoreProductForCandidate(product, candidate, setHint),
			_rankIndex: index,
		}))
		.sort((a, b) => {
			if (b._rankScore !== a._rankScore) {
				return b._rankScore - a._rankScore;
			}

			const titleCompare = normalizeTitleForMatch(a.title || a.original_title || "")
				.localeCompare(normalizeTitleForMatch(b.title || b.original_title || ""));
			if (titleCompare !== 0) {
				return titleCompare;
			}

			const setCompare = normalizeTitleForMatch(a.expansion || a.expansion_code || "")
				.localeCompare(normalizeTitleForMatch(b.expansion || b.expansion_code || ""));
			if (setCompare !== 0) {
				return setCompare;
			}

			const numberCompare = normalizeTitleForMatch(a.card_number || "")
				.localeCompare(normalizeTitleForMatch(b.card_number || ""));
			if (numberCompare !== 0) {
				return numberCompare;
			}

			return a._rankIndex - b._rankIndex;
		})
		.map((product) => {
			const { _rankScore, _rankIndex, ...cleaned } = product;
			return cleaned;
		});
}

function buildProductVersionKey(product = {}) {
	const parts = [
		product.title || product.original_title,
		product.expansion || product.expansion_code,
		product.card_number,
		product.variation_code || product.finish,
		product.id,
	].map((value) => normalizeTitleForMatch(value));

	const normalized = parts.filter(Boolean).join("|");
	return normalized || normalizeTitleForMatch(product.title || product.original_title || "");
}

function toDistinctProducts(products = [], maxResults = 24) {
	const distinctProducts = [];
	const seen = new Set();

	for (const product of products) {
		const versionKey = buildProductVersionKey(product);
		if (!versionKey || seen.has(versionKey)) {
			continue;
		}

		seen.add(versionKey);
		distinctProducts.push(product);
		if (distinctProducts.length >= maxResults) {
			break;
		}
	}

	return distinctProducts;
}

function extractResultTotal(apiResult, fallbackCount = 0) {
	const candidates = [
		apiResult?.total,
		apiResult?.count,
		apiResult?.totalCount,
		apiResult?.total_count,
		apiResult?.totalElements,
		apiResult?.meta?.total,
		apiResult?.meta?.totalCount,
		apiResult?.meta?.total_count,
	];

	for (const value of candidates) {
		const numeric = Number(value);
		if (Number.isFinite(numeric) && numeric >= 0) {
			return numeric;
		}
	}

	return fallbackCount;
}

function finalizeProductSearchResult({
	apiResult,
	products = [],
	candidate = "",
	candidates = [],
	setHint = "",
	source = "card_catalog_api",
}) {
	const productApiConfig = getProductApiConfig();
	const maxVisible = toBoundedInteger(productApiConfig.maxUserVisibleResults, 6, 1, 20);
	const maxDistinct = Math.max(maxVisible, toBoundedInteger(productApiConfig.defaultLimit, 24, 1, 100));
	const distinctProducts = toDistinctProducts(products, maxDistinct);
	const visibleProducts = distinctProducts.slice(0, maxVisible);

	return {
		success: true,
		source,
		products: visibleProducts,
		totalMatches: extractResultTotal(apiResult, products.length),
		distinctVersionCount: distinctProducts.length,
		pagination: {
			current_page: apiResult?.current_page,
			last_page: apiResult?.last_page,
			per_page: apiResult?.per_page,
			total: apiResult?.total,
		},
		raw: apiResult,
		searchCandidatesTried: candidates,
		matchedCandidate: candidate,
		setHintUsed: setHint,
	};
}

function toNumber(value) {
	const numeric = Number(value);
	return Number.isFinite(numeric) ? numeric : 0;
}

function summarizeCondition(condition = {}) {
	return {
		code: condition.code || condition.condition || condition.condition_code,
		price: resolveFirstRawValue([condition.price, condition.amount, condition.value]),
		stocks: toNumber(condition.stocks ?? condition.stock ?? condition.quantity),
		usd_price: resolveFirstRawValue([condition.usd_price, condition.usdPrice]),
	};
}

function resolveCardPrice(product = {}) {
	const directCandidates = [
		product.price,
		product.usd_price,
		product.usdPrice,
		product.market_price,
		product.marketPrice,
		product.low_price,
		product.lowPrice,
		product.retail_price,
		product.retailPrice,
		product.eur_price,
		product.eurPrice,
		product.price_usd,
	];

	for (const candidate of directCandidates) {
		const numeric = toNumberValue(candidate);
		if (numeric !== null) {
			return numeric;
		}
	}

	return resolveFirstRawValue(directCandidates);
}

function summarizeProduct(product = {}) {
	const conditions = Array.isArray(product.conditions) ? product.conditions : [];
	const availableConditions = conditions
		.map(summarizeCondition)
		.filter((condition) => condition.stocks > 0);
	const totalStocksRaw = resolveFirstRawValue([
		product.totalStocks,
		product.total_stocks,
		product.stock,
		product.quantity,
	]);
	const totalStocksNumber = toNumberValue(totalStocksRaw);
	const hasKnownStock = totalStocksNumber !== null || availableConditions.length > 0;

	return {
		id: resolveFirstRawValue([
			product.id,
			product.uuid,
			product.card_id,
			product.cardId,
			product.scryfall_id,
		]),
		title: resolveFirstDisplayValue([
			product.title,
			product.name,
			product.card_name,
			product.cardName,
			product.oracle_name,
		]),
		original_title: resolveFirstDisplayValue([
			product.original_title,
			product.originalTitle,
			product.name,
			product.card_name,
		]),
		expansion_code: resolveFirstDisplayValue([
			product.expansion_code,
			product.expansionCode,
			product.set_code,
			product.setCode,
			product.set_id,
			product.setId,
		]),
		expansion: resolveFirstDisplayValue([
			product.expansion,
			product.set_name,
			product.setName,
			product.set,
			product.edition,
			product.edition_name,
			product.editionName,
		]),
		card_number: resolveFirstDisplayValue([
			product.card_number,
			product.cardNumber,
			product.collector_number,
			product.collectorNumber,
			product.number,
		]),
		rarity_code: resolveFirstDisplayValue([
			product.rarity_code,
			product.rarityCode,
			product.rarity,
		]),
		rarity: resolveFirstDisplayValue([
			product.rarity,
			product.rarity_name,
			product.rarityName,
			product.rarity_code,
		]),
		type_code: resolveFirstDisplayValue([
			product.type_code,
			product.typeCode,
			product.layout,
		]),
		variation_code: resolveFirstDisplayValue([
			product.variation_code,
			product.variationCode,
			product.finish,
			product.printing,
			product.frame_effect,
			product.frameEffect,
		]),
		price: resolveCardPrice(product),
		totalStocks: hasKnownStock ? totalStocksNumber : null,
		default_condition_code: resolveFirstDisplayValue([
			product.default_condition_code,
			product.defaultConditionCode,
		]),
		available: hasKnownStock ? (toNumber(totalStocksNumber) > 0 || availableConditions.length > 0) : null,
		available_conditions: hasKnownStock ? availableConditions : [],
		mana_cost: resolveFirstDisplayValue([
			product.mana_cost,
			product.manaCost,
		]),
		mana_value: resolveFirstRawValue([
			product.mana_value,
			product.manaValue,
			product.cmc,
			product.converted_mana_cost,
		]),
		artist: resolveFirstDisplayValue([
			product.artist,
		]),
		ability: resolveFirstDisplayValue([
			product.ability,
			product.oracle_text,
			product.oracleText,
			product.text,
		]),
		ruling: resolveFirstDisplayValue([
			product.ruling,
			product.flavor_text,
			product.flavorText,
		]),
		scryfall_id: resolveFirstDisplayValue([
			product.scryfall_id,
			product.scryfallId,
		]),
		type_line: resolveFirstDisplayValue([
			product.type_line,
			product.typeLine,
			product.type,
		]),
		image_url: resolveFirstDisplayValue([
			product.image_url,
			product.imageUrl,
			product.image,
			product.image_uri,
			product.imageUri,
			product?.image_uris?.normal,
			product?.image_uris?.small,
		]),
		release_date: resolveFirstDisplayValue([
			product.released_at,
			product.release_date,
			product.releaseDate,
		]),
		stock_unavailable: !hasKnownStock,
	};
}

async function searchProductsByCandidateLegacy(candidate, params = {}) {
	const apiResult = await requestStoreApi(buildLegacyProductsQuery({
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
		source: "store_api",
	};
}

function isLegacyFallbackError(error) {
	const message = String(error?.message || error || "").toLowerCase();
	return (
		message.includes(" 404")
		|| message.includes(" 405")
		|| message.includes("not found")
		|| message.includes("cannot get")
	);
}

async function searchProductsByCandidateCardApi(candidate, params = {}) {
	const productApiConfig = getProductApiConfig();
	const limit = toBoundedInteger(params.limit || productApiConfig.defaultLimit, productApiConfig.defaultLimit, 1, 100);
	const offset = toBoundedInteger(params.offset || 0, 0, 0, 10000);
	const searchPaths = getProductSearchPaths();
	let lastError = null;

	for (const searchPath of searchPaths) {
		const queryString = buildCardSearchQuery({
			offset,
			limit,
			fuzzyName: candidate,
		});
		const endpoint = `${searchPath}${queryString ? `?${queryString}` : ""}`;

		try {
			const apiResult = await requestProductApi(endpoint);
			const products = normalizeCardSearchResponse(apiResult).map(summarizeProduct);

			return {
				apiResult,
				products,
				source: "card_catalog_api",
				searchPathUsed: searchPath,
			};
		} catch (error) {
			lastError = error;
			if (shouldTryAlternateProductSearchPath(error)) {
				continue;
			}
			throw error;
		}
	}

	throw lastError || new Error("Product API search failed.");
}

async function searchProductsByCandidate(candidate, params = {}) {
	try {
		return await searchProductsByCandidateCardApi(candidate, params);
	} catch (error) {
		if (!runtimeConfig?.storeApi?.baseUrl || !isLegacyFallbackError(error)) {
			throw error;
		}

		return searchProductsByCandidateLegacy(candidate, params);
	}
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
	const builtCandidates = buildSearchCandidates({
		explicitCandidates,
		values: [
			params.search,
			params.query,
			context.originalMessage,
		],
		setHint,
	});
	const maxSearchCandidates = toBoundedInteger(
		params.max_search_candidates || getProductApiConfig().maxSearchCandidates,
		getProductApiConfig().maxSearchCandidates,
		1,
		12,
	);
	const candidates = builtCandidates.slice(0, maxSearchCandidates);

	if (!candidates.length) {
		return {
			success: true,
			source: "card_catalog_api",
			products: [],
			searchCandidatesTried: [],
			setHintUsed: setHint,
			totalMatches: 0,
			distinctVersionCount: 0,
		};
	}

	const desiredMatches = new Set(candidates.map((candidate) => normalizeTitleForMatch(candidate)));
	let firstFilteredNonEmptyResult = null;
	let firstRawNonEmptyResult = null;

	for (const candidate of candidates) {
		const { apiResult, products, source } = await searchProductsByCandidate(candidate, params);
		const scopedProducts = rankProductsForCandidate(filterProductsBySetHint(products, setHint), candidate, setHint);
		const rankedProducts = rankProductsForCandidate(products, candidate, setHint);
		const exactProducts = scopedProducts.filter((product) => {
			const possibleTitles = [
				product.title,
				product.original_title,
			].map(normalizeTitleForMatch);
			return possibleTitles.some((title) => desiredMatches.has(title));
		});

		if (exactProducts.length > 0) {
			return finalizeProductSearchResult({
				apiResult,
				products: exactProducts,
				candidate,
				candidates,
				setHint,
				source,
			});
		}

		if (!firstFilteredNonEmptyResult && scopedProducts.length > 0) {
			firstFilteredNonEmptyResult = finalizeProductSearchResult({
				apiResult,
				products: scopedProducts,
				candidate,
				candidates,
				setHint,
				source,
			});
		}

		if (!firstRawNonEmptyResult && rankedProducts.length > 0) {
			firstRawNonEmptyResult = finalizeProductSearchResult({
				apiResult,
				products: rankedProducts,
				candidate,
				candidates,
				setHint,
				source,
			});
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
		source: "card_catalog_api",
		products: [],
		searchCandidatesTried: candidates,
		setHintUsed: setHint,
		totalMatches: 0,
		distinctVersionCount: 0,
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
	offset,
	category,
	category_id,
	expansion_code,
	variation_code,
	rarity_code,
	type_code,
	in_stock,
	is_paginated,
	limit,
	max_search_candidates,
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
			offset,
			category,
			category_id,
			expansion_code,
			variation_code,
			rarity_code,
			type_code,
			in_stock,
			is_paginated,
			limit,
			max_search_candidates,
			order_by,
		}, {
			originalMessage,
		});
	} catch (error) {
		return {
			success: false,
			source: "card_catalog_api",
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
			try {
				const apiResult = await requestStoreApi(`/api/products/${encodeURIComponent(identifier)}`);
				return {
					success: true,
					source: "store_api",
					product: summarizeProduct(apiResult.product || apiResult.data || apiResult),
					raw: apiResult,
				};
			} catch (_legacyProductDetailsError) {
				// Continue with fuzzy card search path when legacy product-id lookup is unavailable.
			}
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
			limit: 10,
		}, {
			originalMessage,
		});

		const products = Array.isArray(searchResult.products) ? searchResult.products : [];
		return {
			success: products.length > 0,
			source: searchResult.source || "card_catalog_api",
			product: products[0] || null,
			raw: searchResult.raw,
			...(products.length === 0 ? { error: `No product matched "${identifier}"` } : {}),
		};
	} catch (error) {
		return {
			success: false,
			source: "card_catalog_api",
			error: error.message,
		};
	}
}

function resolveOrderCodeInput(args = {}) {
	const candidates = [
		args.orderCode,
		args.order_code,
		args.code,
		args.reference,
		args.orderId,
		args.order_id,
		args.id,
	];

	for (const candidate of candidates) {
		const normalized = normalizeOrderCode(candidate);
		if (normalized) {
			return normalized;
		}
	}

	return "";
}

function normalizeOrdersList(apiResult) {
	if (Array.isArray(apiResult)) {
		return apiResult;
	}

	if (Array.isArray(apiResult?.data)) {
		return apiResult.data;
	}

	if (Array.isArray(apiResult?.orders)) {
		return apiResult.orders;
	}

	if (Array.isArray(apiResult?.items)) {
		return apiResult.items;
	}

	return [];
}

function resolveOrderCodeFromRecord(order = {}) {
	return normalizeOrderCode(
		order.code
		|| order.orderCode
		|| order.order_code
		|| order.reference
		|| order.order_reference,
	);
}

function pickBestOrderRecord(orders = [], normalizedOrderCode = "") {
	if (!orders.length) {
		return null;
	}

	const normalizedRequested = normalizeOrderCode(normalizedOrderCode);
	if (!normalizedRequested) {
		return orders[0];
	}

	const exactMatch = orders.find((order) => resolveOrderCodeFromRecord(order) === normalizedRequested);
	if (exactMatch) {
		return exactMatch;
	}

	return orders[0];
}

function hasDisplayValue(value) {
	return value !== undefined && value !== null && String(value).trim() !== "";
}

function resolveFirstRawValue(values = []) {
	for (const value of values) {
		if (value === undefined || value === null) {
			continue;
		}

		if (typeof value === "object") {
			continue;
		}

		if (typeof value === "number") {
			if (!Number.isNaN(value)) {
				return value;
			}
			continue;
		}

		if (hasDisplayValue(value)) {
			return value;
		}
	}

	return "";
}

function resolveFirstAnyValue(values = []) {
	for (const value of values) {
		if (value === undefined || value === null) {
			continue;
		}

		if (typeof value === "number") {
			if (!Number.isNaN(value)) {
				return value;
			}
			continue;
		}

		if (typeof value === "object") {
			return value;
		}

		if (hasDisplayValue(value)) {
			return value;
		}
	}

	return "";
}

function resolveFirstDisplayValue(values = []) {
	const value = resolveFirstRawValue(values);
	return hasDisplayValue(value) ? safeTextCleanup(value) : "";
}

function parsePossiblyJson(value) {
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

function normalizeOrderDetailsPayload(payload) {
	const parsedPayload = parsePossiblyJson(payload);
	if (!parsedPayload || typeof parsedPayload !== "object") {
		return {};
	}

	if (parsedPayload.data && typeof parsedPayload.data === "object") {
		return parsedPayload.data;
	}

	return parsedPayload;
}

function normalizeMetaData(metaDataValue) {
	const parsed = parsePossiblyJson(metaDataValue);
	return parsed && typeof parsed === "object" ? parsed : {};
}

function toNumberValue(value) {
	if (typeof value === "number") {
		return Number.isFinite(value) ? value : null;
	}

	if (!hasDisplayValue(value)) {
		return null;
	}

	const sanitized = String(value).replace(/,/g, "").replace(/[^\d.-]/g, "");
	if (!sanitized) {
		return null;
	}

	const numeric = Number(sanitized);
	return Number.isFinite(numeric) ? numeric : null;
}

function normalizeAddress(value) {
	if (!value) {
		return "";
	}

	if (typeof value === "string") {
		return safeTextCleanup(value);
	}

	if (typeof value !== "object") {
		return "";
	}

	const parts = [
		value.name,
		value.address_line_1,
		value.address_line_2,
		value.city,
		value.state,
		value.postal_code || value.zip,
		value.country,
	].map((part) => safeTextCleanup(part)).filter(Boolean);

	return parts.join(", ");
}

function extractArrayFromObject(value) {
	if (!value || typeof value !== "object") {
		return [];
	}

	const arrayKeys = [
		"cart_items",
		"cartItems",
		"items",
		"order_items",
		"orderItems",
		"products",
		"order_products",
		"orderProducts",
		"cards",
	];

	for (const key of arrayKeys) {
		if (Array.isArray(value[key])) {
			return value[key];
		}
	}

	return [];
}

function resolveCartItemsSource(sources = []) {
	for (const source of sources) {
		const parsed = parsePossiblyJson(source);
		if (Array.isArray(parsed)) {
			return parsed;
		}

		const fromObject = extractArrayFromObject(parsed);
		if (fromObject.length) {
			return fromObject;
		}
	}

	return [];
}

function getCartLineTotals(item = {}) {
	const quantityRaw = resolveFirstRawValue([
		item.quantity,
		item.qty,
		item.count,
		item.units,
		item?.pivot?.quantity,
	]);

	const quantity = toNumberValue(quantityRaw);
	const originalUnitPriceRaw = resolveFirstRawValue([
		item.original_price,
		item.originalPrice,
		item.original_unit_price,
		item.originalUnitPrice,
		item.unit_price,
		item.unitPrice,
		item.regular_price,
		item.base_price,
		item.price,
	]);

	const finalUnitPriceRaw = resolveFirstRawValue([
		item.final_price,
		item.finalPrice,
		item.discounted_price,
		item.discountedPrice,
		item.sale_price,
		item.selling_price,
	]);

	const lineTotalRaw = resolveFirstRawValue([
		item.line_total,
		item.lineTotal,
		item.final_total,
		item.total,
		item.subtotal,
		item.price_total,
		item.pivot?.total,
		item.pivot?.subtotal,
	]);

	const discountRaw = resolveFirstRawValue([
		item.discount_amount,
		item.discount_total,
		item.discount,
		item.total_discount,
	]);

	const originalUnitPrice = toNumberValue(originalUnitPriceRaw);
	const finalUnitPrice = toNumberValue(finalUnitPriceRaw);
	const lineTotal = toNumberValue(lineTotalRaw);
	const discountAmount = toNumberValue(discountRaw);
	const normalizedQuantity = quantity && quantity > 0 ? quantity : null;

	const lineOriginalTotal = (
		normalizedQuantity !== null && originalUnitPrice !== null
			? originalUnitPrice * normalizedQuantity
			: null
	);

	return {
		quantityRaw,
		originalUnitPriceRaw,
		finalUnitPriceRaw,
		lineTotalRaw,
		discountRaw,
		quantity: normalizedQuantity,
		originalUnitPrice,
		finalUnitPrice,
		lineTotal,
		discountAmount,
		lineOriginalTotal,
	};
}

function normalizeCartItems(...sources) {
	const rawItems = resolveCartItemsSource(sources);
	if (!rawItems.length) {
		return [];
	}

	return rawItems
		.map((item = {}) => {
			const productDetailsRaw = parsePossiblyJson(
				item.product_details
				?? item.productDetails
				?? item.product_detail
				?? item.productDetail
				?? "",
			);
			const productDetails = productDetailsRaw && typeof productDetailsRaw === "object"
				? productDetailsRaw
				: {};
			const productRaw = parsePossiblyJson(item.product);
			const product = productRaw && typeof productRaw === "object" ? productRaw : {};

			const name = resolveFirstDisplayValue([
				productDetails.title,
				productDetails.name,
				productDetails.product_title,
				productDetails.product_name,
				productDetails.card_name,
				item.title,
				item.name,
				item.product_name,
				item.product_title,
				item.card_name,
				item.variant_name,
				item.sku_name,
				product.title,
				product.name,
			]);

			const totals = getCartLineTotals(item);

			return {
				name,
				title: name,
				quantity: hasDisplayValue(totals.quantityRaw) ? totals.quantityRaw : "",
				original_price: hasDisplayValue(totals.originalUnitPriceRaw) ? totals.originalUnitPriceRaw : "",
				final_price: hasDisplayValue(totals.finalUnitPriceRaw) ? totals.finalUnitPriceRaw : "",
				line_total: hasDisplayValue(totals.lineTotalRaw) ? totals.lineTotalRaw : "",
				discount_amount: hasDisplayValue(totals.discountRaw) ? totals.discountRaw : "",
				_computed: totals,
			};
		})
		.filter((item) => hasDisplayValue(item.name) || hasDisplayValue(item.quantity) || hasDisplayValue(item.line_total));
}

function computeCartFinancials(cartItems = []) {
	let subtotalFromOriginal = 0;
	let hasSubtotalFromOriginal = false;
	let discountFromLines = 0;
	let hasDiscountFromLines = false;

	for (const item of cartItems) {
		const computed = item?._computed;
		if (!computed) {
			continue;
		}

		if (computed.lineOriginalTotal !== null) {
			subtotalFromOriginal += computed.lineOriginalTotal;
			hasSubtotalFromOriginal = true;
		}

		if (computed.discountAmount !== null) {
			discountFromLines += computed.discountAmount;
			hasDiscountFromLines = true;
		}
	}

	return {
		subtotalFromOriginal: hasSubtotalFromOriginal ? subtotalFromOriginal : null,
		discountFromLines: hasDiscountFromLines ? discountFromLines : null,
	};
}

function stripInternalCartFields(cartItems = []) {
	return cartItems.map((item) => {
		const { _computed, ...cleanItem } = item || {};
		return cleanItem;
	});
}

function buildOrderStatusSummary(order = {}, detailsPayload = null, statusPayload = null) {
	const metaData = normalizeMetaData(order?.meta_data);
	const detailsData = normalizeOrderDetailsPayload(detailsPayload);
	const detailsOrder = detailsData?.order && typeof detailsData.order === "object" ? detailsData.order : detailsData;
	const statusData = statusPayload && typeof statusPayload === "object"
		? normalizeOrderDetailsPayload(statusPayload)
		: {};
	const customerData = detailsData?.customer && typeof detailsData.customer === "object"
		? detailsData.customer
		: (detailsOrder?.customer && typeof detailsOrder.customer === "object" ? detailsOrder.customer : {});
	const paymentDetails = detailsOrder?.payment_details && typeof detailsOrder.payment_details === "object"
		? detailsOrder.payment_details
		: {};

	const orderCode = resolveFirstDisplayValue([
		detailsOrder.order_code,
		detailsOrder.orderCode,
		detailsOrder.code,
		statusData.order_code,
		statusData.orderCode,
		order.code,
		order.order_code,
		order.orderCode,
	]);

	const status = resolveFirstDisplayValue([
		detailsOrder.order_status,
		detailsOrder.status,
		statusData.order_status,
		statusData.status,
		order.order_status,
		order.status,
		order.fulfillment_status,
	]);

	const trackingNo = resolveFirstDisplayValue([
		detailsOrder.tracking_no,
		detailsOrder.tracking_number,
		detailsOrder.trackingNumber,
		statusData.tracking_no,
		statusData.tracking_number,
		statusData.trackingNumber,
		order.tracking_no,
		order.tracking_number,
		order.trackingNumber,
	]);

	const customerName = resolveFirstDisplayValue([
		customerData.name,
		customerData.full_name,
		customerData.customer_name,
		detailsOrder.customer_name,
		detailsData.customer_name,
		order.customer_name,
		order.customerName,
	]);

	const customerEmail = resolveFirstDisplayValue([
		customerData.email,
		detailsOrder.customer_email,
		detailsData.customer_email,
		order.customer_email,
		order.customerEmail,
	]);

	const cartItemsWithComputations = normalizeCartItems(
		detailsData.cart_items,
		detailsData.cartItems,
		detailsData.items,
		detailsData.order_items,
		detailsData.orderItems,
		detailsData.products,
		detailsData.order_products,
		detailsData.cards,
		detailsOrder.cart_items,
		detailsOrder.cartItems,
		detailsOrder.items,
		detailsOrder.order_items,
		detailsOrder.orderItems,
		detailsOrder.products,
		detailsOrder.order_products,
		detailsOrder.cards,
		order.cart_items,
		order.cartItems,
		order.items,
		order.order_items,
		order.orderItems,
		order.products,
		order.order_products,
		order.cards,
		metaData.cart_items,
		metaData.cartItems,
		metaData.items,
		metaData.order_items,
		metaData.orderItems,
		metaData.products,
		metaData.order_products,
		metaData.cards,
	);
	const cartFinancials = computeCartFinancials(cartItemsWithComputations);

	const finalTotalRaw = resolveFirstRawValue([
		detailsOrder.final_total,
		detailsOrder.total,
		detailsOrder.grand_total,
		detailsData.final_total,
		detailsData.total,
		detailsData.grand_total,
		order.final_total,
		order.total,
		order.grand_total,
		metaData.final_total,
		metaData.total,
	]);
	const subtotalRaw = resolveFirstRawValue([
		detailsOrder.sub_total,
		detailsOrder.subtotal,
		detailsOrder.original_total,
		detailsOrder.cart_total,
		detailsData.sub_total,
		detailsData.subtotal,
		detailsData.original_total,
		detailsData.cart_total,
		order.sub_total,
		order.subtotal,
		order.original_total,
		order.cart_total,
		metaData.sub_total,
		metaData.subtotal,
		metaData.original_total,
		metaData.cart_total,
	]);
	const discountRaw = resolveFirstRawValue([
		detailsOrder.discount_amount,
		detailsOrder.discount_total,
		detailsOrder.total_discount,
		detailsOrder.discount,
		detailsData.discount_amount,
		detailsData.discount_total,
		detailsData.total_discount,
		detailsData.discount,
		order.discount_amount,
		order.discount_total,
		order.total_discount,
		order.discount,
		metaData.discount_amount,
		metaData.discount_total,
		metaData.total_discount,
		metaData.discount,
	]);

	const finalTotalNumber = toNumberValue(finalTotalRaw);
	const subtotalNumberFromApi = toNumberValue(subtotalRaw);

	const subtotalComputed = subtotalNumberFromApi !== null
		? subtotalRaw
		: (cartFinancials.subtotalFromOriginal !== null ? cartFinancials.subtotalFromOriginal : "");

	let discountComputed = discountRaw;
	if (!hasDisplayValue(discountComputed) && cartFinancials.discountFromLines !== null) {
		discountComputed = cartFinancials.discountFromLines;
	}
	if (!hasDisplayValue(discountComputed) && subtotalNumberFromApi !== null && finalTotalNumber !== null) {
		const diff = subtotalNumberFromApi - finalTotalNumber;
		discountComputed = diff > 0 ? diff : 0;
	}
	if (!hasDisplayValue(discountComputed) && subtotalNumberFromApi === null && finalTotalNumber !== null && cartFinancials.subtotalFromOriginal !== null) {
		const diff = cartFinancials.subtotalFromOriginal - finalTotalNumber;
		discountComputed = diff > 0 ? diff : 0;
	}

	return {
		id: resolveFirstRawValue([detailsOrder.id, order.id, statusData.order_id]),
		orderCode,
		code: orderCode,
		status,
		order_status: status,
		subtotal: subtotalComputed,
		discount_amount: discountComputed,
		discount: discountComputed,
		final_total: finalTotalRaw,
		total: finalTotalRaw,
		customer_name: customerName,
		customer_email: customerEmail,
		cart_items: stripInternalCartFields(cartItemsWithComputations),
		payment_status: resolveFirstDisplayValue([
			detailsOrder.payment_status,
			statusData.payment_status,
			order.payment_status,
		]),
		fulfillment_status: resolveFirstDisplayValue([
			detailsOrder.fulfillment_status,
			statusData.fulfillment_status,
			order.fulfillment_status,
		]),
		tracking_no: trackingNo,
		created_at: resolveFirstDisplayValue([
			detailsOrder.created_at,
			detailsData.created_at,
			order.created_at,
		]),
		updated_at: resolveFirstDisplayValue([
			detailsOrder.updated_at,
			detailsData.updated_at,
			statusData.last_updated,
			order.updated_at,
		]),
		last_updated: resolveFirstDisplayValue([
			statusData.last_updated,
			detailsOrder.updated_at,
			order.updated_at,
		]),
		payment_method: resolveFirstDisplayValue([
			detailsOrder.payment_method,
			paymentDetails.payment_method,
			order.payment_method,
		]),
		customer_phone: resolveFirstDisplayValue([
			customerData.phone,
			customerData.mobile,
			detailsOrder.customer_phone,
			detailsData.customer_phone,
		]),
		shipping_address: normalizeAddress(resolveFirstAnyValue([
			detailsData.shipping_address,
			detailsOrder.shipping_address,
		])),
		billing_address: normalizeAddress(resolveFirstAnyValue([
			detailsData.billing_address,
			detailsOrder.billing_address,
		])),
		carrier: resolveFirstDisplayValue([
			detailsOrder.carrier,
			statusData.carrier,
			order.carrier,
		]),
		notes: resolveFirstDisplayValue([
			detailsOrder.notes,
			detailsData.notes,
			order.notes,
		]),
	};
}

function extractStatusFromDetailsPayload(detailsPayload = null) {
	const detailsData = normalizeOrderDetailsPayload(detailsPayload);
	const detailsOrder = detailsData?.order && typeof detailsData.order === "object" ? detailsData.order : detailsData;
	return resolveFirstDisplayValue([
		detailsOrder.order_status,
		detailsOrder.status,
		detailsData.order_status,
		detailsData.status,
	]);
}

function isNotFoundErrorMessage(errorMessage) {
	const message = String(errorMessage || "");
	return /\b404\b/.test(message) || /\bnot found\b/i.test(message) || /\bno query results\b/i.test(message);
}

async function fetchMoxOrderRecordByCode(normalizedOrderCode) {
	const searchPayload = await requestMoxApi("GET", `/orders?search=${encodeURIComponent(normalizedOrderCode)}`);
	const orders = normalizeOrdersList(searchPayload);
	const matchedOrder = pickBestOrderRecord(orders, normalizedOrderCode);

	return {
		searchPayload,
		matchedOrder,
		orders,
	};
}

async function fetchMoxOrderDetailsById(orderId) {
	if (!orderId) {
		return null;
	}

	try {
		const payload = await requestMoxApi("GET", `/fetch-order-details/${encodeURIComponent(orderId)}`);
		const statusCode = Number(payload?.status);
		if (statusCode === 404 || /order not found/i.test(String(payload?.message || ""))) {
			return null;
		}
		return payload;
	} catch (error) {
		if (isNotFoundErrorMessage(error.message)) {
			return null;
		}

		// Non-critical route: keep the main order search result instead of failing the whole request.
		return null;
	}
}

async function fetchMoxOrderStatusById(orderId) {
	if (!orderId) {
		return null;
	}

	try {
		const payload = await requestMoxApi("GET", `/fetch-order-status/${encodeURIComponent(orderId)}`);
		const statusCode = Number(payload?.status);
		if (statusCode === 404 || /order not found/i.test(String(payload?.message || ""))) {
			return null;
		}
		return payload;
	} catch (error) {
		if (isNotFoundErrorMessage(error.message)) {
			return null;
		}

		// Non-critical route: keep the main order search result instead of failing the whole request.
		return null;
	}
}

async function checkOrderStatus(args = {}) {
	const normalizedOrderCode = resolveOrderCodeInput(args);
	if (!normalizedOrderCode) {
		return {
			success: false,
			source: "store_api",
			error: "Order code is required.",
		};
	}

	try {
		if (hasMoxBaseUrl() && !hasMoxCredentials()) {
			return {
				success: false,
				source: "mox_api",
				orderCodeRequested: normalizedOrderCode,
				error: "MOX API credentials are incomplete. Configure MOX_API_USERNAME and MOX_API_PASSWORD.",
			};
		}

		const useMoxApi = hasMoxCredentials();
		const apiResult = useMoxApi
			? await (async () => {
				const { searchPayload, matchedOrder } = await fetchMoxOrderRecordByCode(normalizedOrderCode);
				if (!matchedOrder) {
					return {
						notFound: true,
						raw: searchPayload,
					};
				}

				const orderDetailsPayload = await fetchMoxOrderDetailsById(matchedOrder.id);
				const statusFromDetails = extractStatusFromDetailsPayload(orderDetailsPayload);
				const hasStatusFromDetails = hasDisplayValue(statusFromDetails);
				const orderStatusPayload = hasStatusFromDetails ? null : await fetchMoxOrderStatusById(matchedOrder.id);

				return {
					notFound: false,
					order: buildOrderStatusSummary(matchedOrder, orderDetailsPayload, orderStatusPayload),
					raw: {
						search: searchPayload,
						details: orderDetailsPayload,
						status: orderStatusPayload,
					},
				};
			})()
			: await requestStoreApi(`/api/orders/${encodeURIComponent(normalizedOrderCode)}`);

		if (useMoxApi && apiResult.notFound) {
			return {
				success: false,
				source: "mox_api",
				orderCodeRequested: normalizedOrderCode,
				error: `Order not found for code "${normalizedOrderCode}".`,
				raw: apiResult.raw,
			};
		}

		return {
			success: true,
			source: useMoxApi ? "mox_api" : "store_api",
			orderCodeRequested: normalizedOrderCode,
			order: useMoxApi
				? apiResult.order
				: (apiResult.order || apiResult.data || apiResult),
			raw: useMoxApi ? apiResult.raw : apiResult,
		};
	} catch (error) {
		return {
			success: false,
			source: hasMoxCredentials() ? "mox_api" : "store_api",
			orderCodeRequested: normalizedOrderCode,
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
			description: "Search MTG cards using fuzzy name matching and return a few distinct card versions.",
			parametersJsonSchema: {
				type: "object",
				properties: {
					query: { type: "string", description: "Card name or MTG product keywords from the customer." },
					search: { type: "string", description: "Alias of query for fuzzy card search." },
					search_candidates: { type: "array", items: { type: "string" }, description: "Optional candidate names to try in deterministic order." },
					canonical_name: { type: "string", description: "Preferred exact canonical card name if known." },
					set_hint: { type: "string", description: "Optional set/edition hint to rank versions." },
					offset: { type: "number", description: "Pagination offset for card search." },
					limit: { type: "number", description: "Maximum API matches to request before ranking." },
				},
				required: [],
			},
		},
		{
			name: "getProductDetails",
			description: "Get card details for the best fuzzy match when an exact product identifier is unavailable.",
			parametersJsonSchema: {
				type: "object",
				properties: {
					id: { type: "string", description: "Product ID for /api/products/{id} if known." },
					product_id: { type: "string", description: "Alias for product ID." },
					search: { type: "string", description: "Card name search string when exact product ID is not known." },
					query: { type: "string", description: "Alias for search string." },
					search_candidates: { type: "array", items: { type: "string" }, description: "Optional candidate names to try in deterministic order." },
					canonical_name: { type: "string", description: "Preferred exact canonical card name if known." },
					set_hint: { type: "string", description: "Optional set/edition hint to rank versions." },
				},
				required: [],
			},
		},
		{
			name: "checkOrderStatus",
			description: "Look up an existing order by order code or reference and return current order status details.",
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

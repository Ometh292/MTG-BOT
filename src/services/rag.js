const logger = require("../utils/logger");

let runtimeConfig;

function initialize(config) {
	runtimeConfig = config;
}

function getRemoteConfig() {
	const remote = runtimeConfig?.rag?.remote;
	if (!remote || !remote.baseUrl) {
		throw new Error("RAG remote config missing: set MOX_RAG_BASE_URL");
	}
	return remote;
}

function buildRetrieveUrl(baseUrl) {
	const trimmed = String(baseUrl).replace(/\/+$/, "");
	return `${trimmed}/api/rag/retrieve`;
}

// Mox returns context as chunks joined by "\n\n---\n\n" (see
// backend/src/services/rag/retrieval_service.py::_format_context).
function splitContextIntoChunks(context) {
	return String(context || "")
		.split(/\n\n---\n\n/g)
		.map((chunk) => chunk.trim())
		.filter(Boolean);
}

async function postRetrieve({ baseUrl, query, tenantId, category, timeoutMs }) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const response = await fetch(buildRetrieveUrl(baseUrl), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				query,
				tenant_id: tenantId,
				category: category || null,
			}),
			signal: controller.signal,
		});

		if (!response.ok) {
			const body = await response.text().catch(() => "");
			throw new Error(`Mox retrieve failed: ${response.status} ${body.slice(0, 200)}`);
		}

		return await response.json();
	} finally {
		clearTimeout(timer);
	}
}

async function retrieveKnowledge(query, category) {
	if (!runtimeConfig) {
		throw new Error("RAG service has not been initialized");
	}

	if (!runtimeConfig.rag.categories.includes(category)) {
		throw new Error(`Unsupported RAG category: ${category}`);
	}

	const { baseUrl, tenantId, timeoutMs } = getRemoteConfig();

	let payload;
	try {
		payload = await postRetrieve({ baseUrl, query, tenantId, category, timeoutMs });
	} catch (error) {
		logger.error(`Mox RAG retrieve error: ${error.message}`);
		return { success: false, category, matches: [] };
	}

	if (payload.status !== "success" || !payload.context) {
		return { success: true, category, matches: [] };
	}

	const sourcesLabel = Array.isArray(payload.sources) ? payload.sources.join(", ") : "";
	const chunks = splitContextIntoChunks(payload.context);
	const matches = chunks.map((text, index) => ({
		category,
		score: chunks.length - index,
		source: sourcesLabel,
		text,
	}));

	return {
		success: true,
		category,
		matches: matches.slice(0, runtimeConfig.rag.maxResults),
	};
}

module.exports = {
	initialize,
	retrieveKnowledge,
};

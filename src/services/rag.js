const fs = require("fs");
const path = require("path");

let runtimeConfig;

function initialize(config) {
	runtimeConfig = config;
}

function getCategoryFiles(category) {
	const root = runtimeConfig?.rag?.sourcePath;
	if (!root || !fs.existsSync(root)) {
		return [];
	}

	const directCandidates = [
		path.join(root, `${category}.md`),
		path.join(root, `${category}.txt`),
	];

	const nestedDir = path.join(root, category);
	const nestedFiles = fs.existsSync(nestedDir)
		? fs.readdirSync(nestedDir).map((name) => path.join(nestedDir, name))
		: [];

	return [...directCandidates, ...nestedFiles].filter((filePath) => fs.existsSync(filePath));
}

function tokenize(value) {
	return String(value || "")
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

function scoreChunk(queryTokens, chunk) {
	const chunkTokens = new Set(tokenize(chunk));
	let score = 0;
	for (const token of queryTokens) {
		if (chunkTokens.has(token)) {
			score += 1;
		}
	}
	return score;
}

function splitIntoChunks(text) {
	return String(text || "")
		.split(/\n\s*\n/g)
		.map((chunk) => chunk.trim())
		.filter(Boolean);
}

async function retrieveKnowledge(query, category) {
	if (!runtimeConfig) {
		throw new Error("RAG service has not been initialized");
	}

	if (!runtimeConfig.rag.categories.includes(category)) {
		throw new Error(`Unsupported RAG category: ${category}`);
	}

	const files = getCategoryFiles(category);
	const queryTokens = tokenize(query);
	const matches = [];

	for (const filePath of files) {
		const content = fs.readFileSync(filePath, "utf8");
		const chunks = splitIntoChunks(content);

		for (const chunk of chunks) {
			const score = scoreChunk(queryTokens, chunk);
			if (score > 0) {
				matches.push({
					category,
					score,
					source: filePath,
					text: chunk,
				});
			}
		}
	}

	matches.sort((left, right) => right.score - left.score);

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

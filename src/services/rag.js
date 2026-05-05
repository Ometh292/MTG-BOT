/**
 * Self-contained RAG pipeline for MTG-BOT.
 *
 * Pipeline:
 *   buildIndex()  → reads rag/ markdown files → chunks → embeddingService → vectra index
 *   retrieveKnowledge() → embeds query → cosine search → filter by category → return matches
 *
 * Uses:
 *   - embedding_service.js (for text-embedding-004 with robust retries)
 *   - vectra         (local JSON-backed vector store, zero external service)
 *
 * Public API (unchanged from previous version so agent.js needs no edits):
 *   initialize(config)
 *   buildIndex()
 *   retrieveKnowledge(query, category)  → { success, category, matches: [{text, source, score, category}] }
 */

const fs = require("fs");
const path = require("path");
const { LocalIndex } = require("vectra");
const logger = require("../utils/logger");
const embeddingService = require("./embedding_service");

// ─── module state ──────────────────────────────────────────────────────────────
let runtimeConfig = null;
let vectorIndex = null;
let indexReady = false;

// ─── public: initialize ────────────────────────────────────────────────────────

function initialize(config) {
	runtimeConfig = config;
}

// ─── public: buildIndex ────────────────────────────────────────────────────────

/**
 * Read all .md files from the configured rag/ folder, chunk them, embed via
 * Gemini, and persist to a local vectra index file.
 *
 * Called once at bot startup. Safe to call multiple times — skips rebuild
 * if the index already has data and source files haven't changed.
 */
async function buildIndex() {
	if (!runtimeConfig) {
		throw new Error("RAG service has not been initialized. Call initialize(config) first.");
	}

	const sourcePath = runtimeConfig.rag.sourcePath;
	const indexPath = runtimeConfig.rag.indexPath;

	await embeddingService.initialize();

	// Create/open vectra index
	vectorIndex = new LocalIndex(indexPath);
	if (!(await vectorIndex.isIndexCreated())) {
		await vectorIndex.createIndex();
		logger.info("[RAG] Created new vectra index at " + indexPath);
	}

	// Discover all .md files in the rag folder
	const mdFiles = fs
		.readdirSync(sourcePath)
		.filter((f) => f.endsWith(".md") && !f.startsWith("."))
		.map((f) => path.join(sourcePath, f));

	if (!mdFiles.length) {
		logger.warning("[RAG] No .md files found in " + sourcePath + ". RAG will return empty results.");
		indexReady = true;
		return;
	}

	// Check if we need to (re)index: compare stored metadata vs file mtimes
	const needsRebuild = await checkRebuildNeeded(mdFiles);
	if (!needsRebuild) {
		logger.info(`[RAG] Index is up-to-date (${mdFiles.length} source files). Skipping rebuild.`);
		indexReady = true;
		return;
	}

	// Rebuild: wipe existing items and re-index from scratch
	logger.info(`[RAG] (Re)building index from ${mdFiles.length} file(s)...`);
	await vectorIndex.deleteIndex();
	await vectorIndex.createIndex();

	let totalChunks = 0;
	for (const filePath of mdFiles) {
		const category = inferCategory(filePath);
		const source = path.basename(filePath, ".md");
		const text = fs.readFileSync(filePath, "utf8");
		const mtime = fs.statSync(filePath).mtimeMs;

		const chunks = chunkText(text, runtimeConfig.rag.chunkSize, runtimeConfig.rag.chunkOverlap);
		logger.info(`[RAG] Embedding ${chunks.length} chunks from ${source} (category: ${category})`);

		// Embed in small batches to avoid rate limits using the robust embedding service
        // We use RETRIEVAL_DOCUMENT for indexing
		const embeddings = await embeddingService.embedTexts(chunks, "RETRIEVAL_DOCUMENT");

		for (let i = 0; i < chunks.length; i++) {
			await vectorIndex.insertItem({
				vector: embeddings[i],
				metadata: {
					text: chunks[i],
					source,
					category,
					chunkIndex: i,
					mtime,
				},
			});
		}

		totalChunks += chunks.length;
		logger.info(`[RAG] Indexed ${chunks.length} chunks from ${source}`);
	}

	// Persist build manifest so we know what we indexed
	saveBuildManifest(indexPath, mdFiles);

	logger.info(`[RAG] Index ready — ${totalChunks} chunks from ${mdFiles.length} files.`);
	indexReady = true;
}

/**
 * Retrieve relevant knowledge chunks for a query.
 */
async function retrieveKnowledge(query) {
	if (!runtimeConfig) {
		throw new Error("RAG service has not been initialized");
	}

	let vectorMatches = [];
	
	// 1. Try Vector Search first if index is ready
	if (indexReady && vectorIndex) {
		try {
			await embeddingService.initialize();
			const queryVector = await embeddingService.embedQuery(query);
			const topK = (runtimeConfig.rag.maxResults || 3) * 4;
			const results = await vectorIndex.queryItems(queryVector, topK);

			const threshold = runtimeConfig.rag.similarityThreshold || 0.40;
			vectorMatches = results
				.filter((r) => r.score >= threshold)
				.map((r) => ({
					text: r.item.metadata.text,
					source: r.item.metadata.source,
					category: r.item.metadata.category,
					score: Math.round(r.score * 1000) / 1000,
					method: "vector"
				}));
		} catch (error) {
			logger.error(`[RAG] Vector search error: ${error.message}`);
		}
	}

	// 2. If vector search found nothing or was skipped, try Keyword Search (The "Search Every File" Fallback)
	if (vectorMatches.length === 0) {
		logger.info(`[RAG] Vector search yielded no results for "${query}". Falling back to keyword search.`);
		const keywordMatches = keywordSearch(query);
		
		if (keywordMatches.length > 0) {
			return { success: true, matches: keywordMatches.slice(0, runtimeConfig.rag.maxResults || 3) };
		}
	} else {
		return { success: true, matches: vectorMatches.slice(0, runtimeConfig.rag.maxResults || 3) };
	}

	return { success: true, matches: [] };
}

/**
 * Simple case-insensitive keyword search across all markdown files.
 * This is highly reliable for specific queries like "hours", "location", etc.
 */
function keywordSearch(query) {
	const sourcePath = runtimeConfig.rag.sourcePath;
	if (!fs.existsSync(sourcePath)) return [];

	const normalizedQuery = query.toLowerCase();
	const keywords = normalizedQuery.split(/\s+/).filter(w => w.length > 3);
	
	const mdFiles = fs
		.readdirSync(sourcePath)
		.filter((f) => f.endsWith(".md") && !f.startsWith("."))
		.map((f) => path.join(sourcePath, f));

	const matches = [];

	for (const filePath of mdFiles) {
		const content = fs.readFileSync(filePath, "utf8");
		const source = path.basename(filePath, ".md");
		const category = inferCategory(filePath);

		// Check if query or main keywords appear in the file
		const hasFullQuery = content.toLowerCase().includes(normalizedQuery);
		const matchingKeywords = keywords.filter(k => content.toLowerCase().includes(k));
		
		if (hasFullQuery || matchingKeywords.length > 0) {
			// Split by one or more newlines to be safe
			const segments = content.split(/\n+/).map(s => s.trim()).filter(s => s.length > 10);
			
			for (const segment of segments) {
				const lowerSegment = segment.toLowerCase();
				if (lowerSegment.includes(normalizedQuery) || 
					keywords.some(k => lowerSegment.includes(k))) {
					
					matches.push({
						text: segment,
						source,
						category,
						score: 0.95, // Manual matches get a high synthetic score
						method: "keyword"
					});
					
					if (matches.length >= 10) break;
				}
			}
		}
	}

	if (matches.length > 0) {
		logger.info(`[RAG] Keyword search found ${matches.length} potential matches for "${query}"`);
	}

	return matches.sort((a, b) => b.text.length - a.text.length);
}

// ─── text chunking ─────────────────────────────────────────────────────────────

/**
 * Split markdown text into overlapping word-based chunks.
 *
 * Strategy:
 *   1. Split into paragraphs (double newline)
 *   2. Accumulate paragraphs until chunkSize words is reached
 *   3. Start next chunk by overlapping the last `chunkOverlap` words
 */
function chunkText(text, chunkSizeWords = 400, overlapWords = 50) {
	// Normalise line endings and collapse excessive blank lines
	const clean = text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

	// Split on paragraph boundaries first
	const paragraphs = clean.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);

	const chunks = [];
	let current = [];
	let currentWordCount = 0;

	for (const para of paragraphs) {
		const paraWords = para.split(/\s+/);

		// If adding this paragraph would overflow, flush and start new chunk
		if (currentWordCount + paraWords.length > chunkSizeWords && current.length > 0) {
			chunks.push(current.join("\n\n"));

			// Carry over trailing words for overlap
			const overlapText = current.join(" ").split(/\s+/).slice(-overlapWords).join(" ");
			current = overlapText ? [overlapText] : [];
			currentWordCount = current.length ? current[0].split(/\s+/).length : 0;
		}

		// If a single paragraph is larger than chunk size, split it by words
		if (paraWords.length > chunkSizeWords) {
			for (let i = 0; i < paraWords.length; i += chunkSizeWords - overlapWords) {
				const slice = paraWords.slice(i, i + chunkSizeWords).join(" ");
				chunks.push(slice);
			}
			current = [];
			currentWordCount = 0;
		} else {
			current.push(para);
			currentWordCount += paraWords.length;
		}
	}

	if (current.length > 0) {
		chunks.push(current.join("\n\n"));
	}

	return chunks.filter((c) => c.trim().length > 20);
}

// ─── category inference ────────────────────────────────────────────────────────

/**
 * Infer document category from filename.
 * buylist.md → "buylist", store-policies.md → "policies", etc.
 */
function inferCategory(filePath) {
	const base = path.basename(filePath, ".md").toLowerCase();
	const categoryMap = {
		buylist: "buylist",
		"buy-list": "buylist",
		policies: "policies",
		policy: "policies",
		"store-policies": "policies",
		faq: "faq",
		shipping: "shipping",
		delivery: "shipping",
		events: "events",
		event: "events",
		general: "general",
	};

	for (const [key, cat] of Object.entries(categoryMap)) {
		if (base.includes(key)) {
			return cat;
		}
	}

	// Default to general if no keyword matches
	return "general";
}

// ─── rebuild detection ─────────────────────────────────────────────────────────

function manifestPath(indexPath) {
	return path.join(path.dirname(indexPath), ".rag-manifest.json");
}

function saveBuildManifest(indexPath, mdFiles) {
	const manifest = {};
	for (const f of mdFiles) {
		manifest[f] = fs.statSync(f).mtimeMs;
	}

	try {
		fs.writeFileSync(manifestPath(indexPath), JSON.stringify(manifest, null, 2), "utf8");
	} catch (_err) {
		// Non-fatal — worst case we'll rebuild next time
	}
}

async function checkRebuildNeeded(mdFiles) {
	const mpath = manifestPath(runtimeConfig.rag.indexPath);

	if (!fs.existsSync(mpath)) {
		return true;
	}

	let manifest;
	try {
		manifest = JSON.parse(fs.readFileSync(mpath, "utf8"));
	} catch (_err) {
		return true;
	}

	const manifestFiles = Object.keys(manifest).sort();
	const currentFiles = mdFiles.slice().sort();

	if (manifestFiles.length !== currentFiles.length) {
		return true;
	}

	for (let i = 0; i < currentFiles.length; i++) {
		if (manifestFiles[i] !== currentFiles[i]) {
			return true;
		}

		const currentMtime = fs.statSync(currentFiles[i]).mtimeMs;
		if (manifest[currentFiles[i]] !== currentMtime) {
			return true;
		}
	}

	// Also check that the vector index actually exists on disk
	const indexFilePath = path.join(runtimeConfig.rag.indexPath, "index.json");
	if (!fs.existsSync(indexFilePath)) {
		return true;
	}

	return false;
}

// ─── utility ───────────────────────────────────────────────────────────────────

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── exports ───────────────────────────────────────────────────────────────────

module.exports = {
	initialize,
	buildIndex,
	retrieveKnowledge,
};

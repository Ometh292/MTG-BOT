const logger = require("../utils/logger");

const _MAX_EMBED_RETRIES = 6;
const _INITIAL_BACKOFF_SECONDS = 2.0;

class EmbeddingService {
    constructor() {
        this.modelName = process.env.RAG_EMBEDDING_MODEL || "text-embedding-004";
        this.projectId = process.env.GOOGLE_CLOUD_PROJECT;
        this.location = process.env.GOOGLE_CLOUD_LOCATION || "us-central1";
        this.genaiClient = null;
        this.initialized = false;
    }

    async _ensureInitialized() {
        if (!this.initialized) {
            const { GoogleGenAI } = await import("@google/genai");
            this.genaiClient = new GoogleGenAI({
                vertexai: true,
                project: this.projectId,
                location: this.location,
            });
            this.initialized = true;
            logger.info(`[EmbeddingService] Initialized with model: ${this.modelName} (Vertex AI)`);
        }
    }

    async initialize() {
        if (!this.initialized) {
            logger.info(`[EmbeddingService] Pre-warming (${this.modelName})...`);
            await this._ensureInitialized();
        }
    }

    /**
     * Embed a single query (for search). Uses RETRIEVAL_QUERY task type.
     */
    async embedQuery(query) {
        return await this.embedText(query, "RETRIEVAL_QUERY");
    }

    /**
     * Embed a single document (for indexing). Uses RETRIEVAL_DOCUMENT task type.
     */
    async embedDocument(text) {
        return await this.embedText(text, "RETRIEVAL_DOCUMENT");
    }

    async embedText(text, taskType) {
        const embeddings = await this.embedTexts([text], taskType);
        return embeddings[0];
    }

    /**
     * Embed an array of strings in small batches, applying robust retry logic.
     * Uses the specified taskType (RETRIEVAL_DOCUMENT or RETRIEVAL_QUERY).
     */
    async embedTexts(texts, taskType) {
        await this._ensureInitialized();
        const allVectors = [];
        const batchSize = 5;

        for (let i = 0; i < texts.length; i += batchSize) {
            const batch = texts.slice(i, i + batchSize);
            const vectors = await Promise.all(batch.map((t) => this._embedSingleWithRetry(t, taskType)));
            allVectors.push(...vectors);

            // Small delay between batches to stay under rate limits
            if (i + batchSize < texts.length) {
                await this._sleep(300);
            }
        }
        return allVectors;
    }

    async _embedSingleWithRetry(text, taskType) {
        let backoff = _INITIAL_BACKOFF_SECONDS * 1000;

        for (let attempt = 1; attempt <= _MAX_EMBED_RETRIES; attempt++) {
            try {
                const response = await this.genaiClient.models.embedContent({
                    model: this.modelName,
                    contents: text,
                    config: taskType ? { taskType } : undefined
                });

                const values = response?.embeddings?.[0]?.values;
                if (!Array.isArray(values) || !values.length) {
                    throw new Error("[EmbeddingService] Vertex AI embedContent returned no values");
                }
                return values;

            } catch (error) {
                const isRetryable = this._isRetryableError(error);

                if (!isRetryable || attempt === _MAX_EMBED_RETRIES) {
                    logger.error(`[EmbeddingService] Embedding failed after ${attempt} attempts: ${error.message}`);
                    throw error;
                }

                const sleepFor = backoff + (Math.random() * backoff * 0.25);
                logger.warning(`[EmbeddingService] Transient error (attempt ${attempt}/${_MAX_EMBED_RETRIES}); sleeping ${Math.round(sleepFor)}ms. Details: ${error.message}`);
                
                await this._sleep(sleepFor);
                backoff *= 2;
            }
        }
    }

    _isRetryableError(error) {
        const msg = error?.message?.toLowerCase() || "";
        const code = error?.code || error?.status;

        // Rate limits
        if (msg.includes("429") || msg.includes("resource_exhausted") || msg.includes("quota")) {
            return true;
        }

        // Service Unavailable
        if (msg.includes("503") || msg.includes("unavailable") || code === 14) {
            return true;
        }

        // Transient Connection Resets (10054 on Windows / generic gRPC drops)
        if (msg.includes("10054") || msg.includes("connection reset") || msg.includes("timeout") || msg.includes("deadline_exceeded") || code === 4) {
            return true;
        }

        return false;
    }

    _sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}

// Export a singleton instance
const embeddingService = new EmbeddingService();
module.exports = embeddingService;

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const RESET_KEYWORDS = ["reset", "restart", "start over", "clear chat", "new chat"];

class HistoryManager {
	constructor(limit = 30) {
		this.limit = limit;
		this.sessions = new Map();
		this.cleanupTimer = setInterval(() => this.cleanupExpiredSessions(), CLEANUP_INTERVAL_MS);

		if (this.cleanupTimer.unref) {
			this.cleanupTimer.unref();
		}
	}

	checkAndReset(chatId, messageText) {
		const session = this.sessions.get(chatId);

		if (session && this.isExpired(session)) {
			this.clearHistory(chatId);
			return "expired";
		}

		if (!session || !messageText) {
			return null;
		}

		const normalized = String(messageText).trim().toLowerCase();
		if (RESET_KEYWORDS.includes(normalized)) {
			this.clearHistory(chatId);
			return "manual";
		}

		return null;
	}

	addMessage(chatId, message) {
		if (!this.sessions.has(chatId)) {
			this.sessions.set(chatId, { messages: [], lastActivity: Date.now() });
		}

		const session = this.sessions.get(chatId);
		session.messages.push(message);
		session.lastActivity = Date.now();

		if (session.messages.length > this.limit) {
			session.messages = session.messages.slice(-this.limit);
		}
	}

	getMessages(chatId) {
		const session = this.sessions.get(chatId);
		if (!session) {
			return [];
		}

		session.lastActivity = Date.now();
		return [...session.messages];
	}

	clearHistory(chatId) {
		this.sessions.delete(chatId);
	}

	getActiveSessionCount() {
		return this.sessions.size;
	}

	destroy() {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
		}
	}

	isExpired(session) {
		return Date.now() - session.lastActivity > SESSION_TIMEOUT_MS;
	}

	cleanupExpiredSessions() {
		for (const [chatId, session] of this.sessions.entries()) {
			if (this.isExpired(session)) {
				this.sessions.delete(chatId);
			}
		}
	}
}

module.exports = HistoryManager;

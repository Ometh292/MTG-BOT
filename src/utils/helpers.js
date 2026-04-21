function formatTranscript(messages) {
	return messages
		.filter((message) => message.role === "user" || message.role === "assistant")
		.map((message) => {
			if (message.role === "user") {
				return `User: ${message.content}`;
			}

			return `Assistant: ${message.content}`;
		})
		.join("\n");
}

function generateTicketId(prefix = "SUP") {
	const date = new Date().toISOString().slice(0, 10).replace(/-/g, "");
	const suffix = Math.random().toString(36).slice(2, 8).toUpperCase();
	return `${prefix}-${date}-${suffix}`;
}

function normalizeOrderCode(value) {
	return String(value || "")
		.toUpperCase()
		.replace(/[^A-Z0-9-]/g, "")
		.replace(/-{2,}/g, "-")
		.trim();
}

function safeTextCleanup(value) {
	return String(value || "")
		.replace(/[\u200B-\u200D\uFEFF]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

module.exports = {
	formatTranscript,
	generateTicketId,
	normalizeOrderCode,
	safeTextCleanup,
};

let enabled = false;

function initialize(config) {
	enabled = Boolean(config?.features?.rulesGrounding?.enabled);
}

async function groundRulesQuery(query) {
	return {
		success: false,
		available: enabled,
		query,
		message: enabled
			? "Rules grounding is enabled in config but no adapter has been implemented yet."
			: "MTG rules grounding is not available in this deployment yet.",
	};
}

module.exports = {
	initialize,
	groundRulesQuery,
};

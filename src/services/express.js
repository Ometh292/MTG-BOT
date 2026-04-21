const express = require("express");
const cors = require("cors");

const logger = require("../utils/logger");

let app;
let whatsappService;

function initializeServer(whatsappSvc) {
	whatsappService = whatsappSvc;
	app = express();

	const apiPort = process.env.API_PORT || 3000;

	app.use(cors());
	app.use(express.json());

	setupRoutes();

	app.listen(apiPort, () => {
		console.log(`Express server listening on http://localhost:${apiPort}`);
	});

	return app;
}

function setupRoutes() {
	app.get("/api/health", (req, res) => {
		const status = whatsappService.getStatus();
		res.json({
			status: "ok",
			whatsappReady: status.ready,
			connectedAs: status.info,
			reconnectAttempts: status.reconnectAttempts,
		});
	});

	app.get("/api/status", (req, res) => {
		res.json(whatsappService.getStatus());
	});

	app.get("/api/logs", (req, res) => {
		const limit = Number(req.query.limit || 100);
		res.json({
			success: true,
			logs: logger.getLogs(limit),
		});
	});

	app.get("/api/logs/stream", (req, res) => {
		res.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		});

		res.write(`data: ${JSON.stringify({ type: "initial", logs: logger.getLogs(50) })}\n\n`);

		const removeListener = logger.addListener((entry) => {
			res.write(`data: ${JSON.stringify(entry)}\n\n`);
		});

		req.on("close", () => {
			removeListener();
		});
	});

	app.get("/api/admin/qr", (req, res) => {
		const qrData = logger.getQRCode();
		if (!qrData.qr && !qrData.qrImage) {
			return res.status(404).json({
				success: false,
				message: "No QR code available",
			});
		}

		return res.json({
			success: true,
			qr: qrData.qr,
			qrImage: qrData.qrImage,
		});
	});

	app.post("/api/admin/send-message", async (req, res) => {
		try {
			const status = whatsappService.getStatus();
			if (!status.ready) {
				return res.status(503).json({
					success: false,
					error: "WhatsApp client is not ready",
				});
			}

			const { phone, message } = req.body;
			if (!phone || !message) {
				return res.status(400).json({
					success: false,
					error: "phone and message are required",
				});
			}

			let cleanNumber = String(phone).replace(/\D/g, "");
			if (cleanNumber.startsWith("0")) {
				cleanNumber = `94${cleanNumber.slice(1)}`;
			} else if (!cleanNumber.startsWith("94")) {
				cleanNumber = `94${cleanNumber}`;
			}

			const chatId = `${cleanNumber}@c.us`;
			const client = whatsappService.getClient();

			let targetId = chatId;
			try {
				const numberDetails = await client.getNumberId(chatId);
				if (numberDetails) {
					targetId = numberDetails._serialized;
				}
			} catch (error) {
				console.warn("Number validation failed:", error.message);
			}

			await client.sendMessage(targetId, message);
			return res.json({
				success: true,
				recipient: cleanNumber,
				chatId: targetId,
			});
		} catch (error) {
			return res.status(500).json({
				success: false,
				error: error.message,
			});
		}
	});
}

module.exports = {
	initializeServer,
};

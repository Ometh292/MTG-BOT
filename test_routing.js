require("dotenv").config();
const agent = require("./src/services/agent");
const geminiService = require("./src/services/gemini");
const HistoryManager = require("./history");

// Mock config
const config = {
    features: {
        tools: { enabled: true },
        rag: { enabled: true }
    },
    aiBot: {
        systemPrompt: "You are a helpful assistant."
    }
};

async function test() {
    console.log("Initializing...");
    geminiService.initialize(config);
    const historyManager = new HistoryManager();
    agent.initialize({ config, historyManager, geminiService });

    console.log("Processing message: 'Who is the founder of mox and lotus?'");
    const result1 = await agent.processMessage({
        chatId: "test-user-1",
        messageText: "Who is the founder of mox and lotus?",
        customerInfo: { name: "Test", number: "123" }
    });
    console.log("Result 1:", JSON.stringify(result1, null, 2));

    console.log("\nProcessing message: 'what is black lotus?'");
    const result2 = await agent.processMessage({
        chatId: "test-user-2",
        messageText: "what is black lotus?",
        customerInfo: { name: "Test", number: "123" }
    });
    console.log("Result 2:", JSON.stringify(result2, null, 2));
}

test().catch(console.error);

/**
 * Web Crawler Service for MTG-BOT (Puppeteer edition)
 *
 * Uses a headless Chromium browser to fully render moxandlotus.sg pages
 * (which are JS-rendered) before extracting content. Extracted HTML is then
 * stripped of navigation/footers/product-grids and converted to clean
 * Markdown, which is saved into rag/ so the RAG pipeline can embed it.
 *
 * Mirrors the Python website_crawler.py from MoxVoice-by-vertex.
 *
 * Public API:
 *   runCrawler()                          - Run a full crawl immediately
 *   scheduleDaily(hour, minute, ragSvc)  - Schedule daily crawl + index rebuild
 */

"use strict";

const fs   = require("fs");
const path = require("path");
const TurndownService = require("turndown");
const logger = require("../utils/logger");

// ─── Configuration ─────────────────────────────────────────────────────────────

const BASE_URL        = "https://www.moxandlotus.sg";
const PAGE_TIMEOUT_MS = 30_000;   // max wait for JS to load
const WAIT_AFTER_LOAD = 3_000;    // extra settling time after networkidle2

// Output folder — the rag/ directory that buildIndex() reads from
const RAG_DIR = path.join(__dirname, "..", "..", "rag");

/**
 * Pages verified to have real content on moxandlotus.sg.
 * [ urlPath, outputFilename (no .md) ]
 *
 * Filenames drive inferCategory() in rag.js:
 *   faq*      → "faq"    buylist*  → "buylist"
 *   shipping* → "shipping"          policies* → "policies"
 *   general*  → "general"
 */
const POLICY_PAGES = [
    ["/about",           "general-about"],
    ["/privacy-policy",  "policies-privacy"],
    ["/tos",             "policies-terms"],
    ["/contact-us",      "general-contact"],
    ["/pudo",            "shipping-pudo"],
    ["/events",          "events"],
    ["/operating-hours", "general-hours"],
    ["/buylist",         "buylist"],
    // Homepage: stripped to deal/product summary (general knowledge)
    ["/",                "general-home"],
];

// No working collection pages found on moxandlotus.sg at this time.
const CATEGORY_PAGES = [];

// CSS tags always removed before Markdown conversion
const STRIP_TAGS = [
    "script", "style", "noscript",
    "header", "footer", "nav", "form", "svg", "iframe",
];

// Site-specific selectors to remove nav / cart noise that appears on every page
const SITE_NOISE_SELECTORS = [
    ".navbar", ".nav-bar", ".navigation",
    ".cart", ".cart-icon", "#cart",
    ".sign-in", ".register",
    ".footer", ".site-footer",
    "[class*='header']",
    "[class*='navbar']",
    "[class*='cart']",
    // Product grids (homepage)
    "[class*='product-card']",
    "[class*='product-item']",
    ".product",
];

// Extra selectors stripped on category pages
const CATEGORY_EXTRA_SELECTORS = [
    ".product-card", ".product-item", ".products",
    "[class*='product-grid']", "[class*='collection-grid']",
    "[data-product-id]",
];

// ─── Turndown (HTML → Markdown) ────────────────────────────────────────────────

const turndown = new TurndownService({
    headingStyle:   "atx",
    hr:             "---",
    bulletListMarker: "-",
    codeBlockStyle: "fenced",
});

// Clean up empty anchor text
turndown.addRule("cleanLinks", {
    filter: "a",
    replacement: (content) => content.trim() || "",
});

// ─── Puppeteer helpers ─────────────────────────────────────────────────────────

/**
 * Launch a single shared browser instance for the whole crawl run.
 * We share it across pages to save memory & startup time.
 */
async function launchBrowser() {
    const puppeteer = require("puppeteer");

    const os   = require("os");
    const crypto = require("crypto");
    // Use a unique temp dir per crawl run so we never conflict with
    // the WhatsApp Chromium session or other running Chrome instances.
    const uniqueDir = path.join(os.tmpdir(), `mtgbot_crawler_${crypto.randomBytes(6).toString("hex")}`);

    const browser = await puppeteer.launch({
        headless: true,
        userDataDir: uniqueDir,
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
            "--window-size=1280,800",
        ],
    });

    logger.info("[Crawler] Headless Chromium launched");
    return browser;
}

/**
 * Navigate to `url`, wait for network to settle, and return the rendered HTML.
 *
 * @param {import('puppeteer').Browser} browser
 * @param {string}   url
 * @param {string[]} extraSelectors  CSS selectors to strip before returning HTML
 * @returns {{ title: string, markdown: string } | null}
 */
async function renderPage(browser, url, extraSelectors = []) {
    const page = await browser.newPage();

    try {
        // Block images / fonts / media to speed up rendering
        await page.setRequestInterception(true);
        page.on("request", (req) => {
            const type = req.resourceType();
            if (["image", "media", "font"].includes(type)) {
                req.abort();
            } else {
                req.continue();
            }
        });

        await page.setUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
            "AppleWebKit/537.36 (KHTML, like Gecko) " +
            "Chrome/120.0.0.0 Safari/537.36 MTG-BOT-Crawler/1.0"
        );

        await page.goto(url, {
            waitUntil: "networkidle2",
            timeout:   PAGE_TIMEOUT_MS,
        });

        // Extra settling time for SPAs that render after network is quiet
        await new Promise((r) => setTimeout(r, WAIT_AFTER_LOAD));

        // Strip noise elements inside the browser before we grab HTML
        // Always strip structural tags, site-wide noise, and any page-specific selectors
        const allSelectors = [...extraSelectors];
        await page.evaluate((stripTags, siteNoise, extraSels) => {
            // Remove noisy HTML tags
            stripTags.forEach((tag) =>
                document.querySelectorAll(tag).forEach((el) => el.remove())
            );
            // Remove site-specific nav/cart/header noise
            siteNoise.forEach((sel) => {
                try { document.querySelectorAll(sel).forEach((el) => el.remove()); } catch (_) {}
            });
            // Remove any page-specific selectors
            extraSels.forEach((sel) => {
                try { document.querySelectorAll(sel).forEach((el) => el.remove()); } catch (_) {}
            });
        }, STRIP_TAGS, SITE_NOISE_SELECTORS, allSelectors);

        const title = await page.title();

        // Prefer <main> > <article> > <body>
        const html = await page.evaluate(() => {
            const el =
                document.querySelector("main") ||
                document.querySelector("article") ||
                document.body;
            return el ? el.innerHTML : "";
        });

        const rawMarkdown = turndown.turndown(html || "").trim();
        const markdown    = rawMarkdown.replace(/\n{3,}/g, "\n\n");

        return { title, markdown };

    } catch (err) {
        logger.warning(`[Crawler] Failed to render ${url}: ${err.message}`);
        return null;
    } finally {
        await page.close();
    }
}

// ─── File helpers ──────────────────────────────────────────────────────────────

function saveMarkdown(filename, title, markdown) {
    if (!fs.existsSync(RAG_DIR)) {
        fs.mkdirSync(RAG_DIR, { recursive: true });
    }

    const header  = title ? `# ${title}\n\n` : "";
    const content = header + markdown;

    if (content.trim().length < 100) {
        logger.warning(`[Crawler] Skipping ${filename}: content too short (${content.trim().length} chars)`);
        return false;
    }

    const outPath = path.join(RAG_DIR, `${filename}.md`);
    fs.writeFileSync(outPath, content, "utf8");
    logger.info(`[Crawler] Saved ${filename}.md (${content.length} chars)`);
    return true;
}

// ─── Crawl functions ───────────────────────────────────────────────────────────

async function crawlPages(browser, pages, extraSelectors = []) {
    const results = [];

    for (const [urlPath, filename] of pages) {
        const url = BASE_URL + urlPath;
        logger.info(`[Crawler] Fetching ${url}...`);

        const rendered = await renderPage(browser, url, extraSelectors);
        if (!rendered) {
            results.push({ url, filename, status: "render_failed" });
            continue;
        }

        const { title, markdown } = rendered;
        const saved = saveMarkdown(filename, title || urlPath, markdown);
        results.push({ url, filename, status: saved ? "ok" : "empty" });
    }

    return results;
}

// ─── Public API ────────────────────────────────────────────────────────────────

/**
 * Run a full website crawl:
 *   1. Launch headless Chromium
 *   2. Render and scrape policy + category pages
 *   3. Save as .md files into rag/
 *   4. Close the browser
 *
 * After this, call rag.buildIndex() to re-embed the fresh files.
 *
 * @returns {{ policy: Array, category: Array, savedCount: number }}
 */
async function runCrawler() {
    logger.info("[Crawler] Starting full crawl of moxandlotus.sg (Puppeteer)...");
    const startedAt = Date.now();

    let browser = null;

    try {
        browser = await launchBrowser();

        logger.info(`[Crawler] Crawling ${POLICY_PAGES.length} policy/info pages...`);
        const policy = await crawlPages(browser, POLICY_PAGES, []);

        const category = CATEGORY_PAGES.length > 0
            ? await crawlPages(browser, CATEGORY_PAGES, CATEGORY_EXTRA_SELECTORS)
            : [];

        const savedCount = [...policy, ...category].filter((r) => r.status === "ok").length;
        const elapsed    = ((Date.now() - startedAt) / 1000).toFixed(1);

        logger.info(`[Crawler] Crawl complete: ${savedCount} pages saved in ${elapsed}s`);
        return { policy, category, savedCount };

    } finally {
        if (browser) {
            await browser.close();
            logger.info("[Crawler] Browser closed");
        }
    }
}

/**
 * Schedule a daily crawl using node-cron.
 * After each crawl, triggers ragService.buildIndex() to re-embed the updated files.
 *
 * @param {number} hour       Hour (0-23), default midnight
 * @param {number} minute     Minute (0-59), default 0
 * @param {object} ragService RAG service with buildIndex()
 */
function scheduleDaily(hour = 0, minute = 0, ragService = null) {
    const cron     = require("node-cron");
    const cronExpr = `${minute} ${hour} * * *`;

    logger.info(
        `[Crawler] Daily crawl scheduled at ` +
        `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")} ` +
        `(Asia/Colombo)`
    );

    cron.schedule(cronExpr, async () => {
        logger.info("[Crawler] Running scheduled daily crawl...");
        try {
            const result = await runCrawler();

            if (result.savedCount > 0 && ragService) {
                logger.info("[Crawler] Triggering RAG index rebuild after crawl...");
                await ragService.buildIndex();
                logger.info("[Crawler] RAG index rebuilt successfully.");
            } else if (result.savedCount === 0) {
                logger.warning("[Crawler] No pages saved — skipping index rebuild.");
            }
        } catch (err) {
            logger.error(`[Crawler] Scheduled crawl failed: ${err.message}`);
        }
    }, { timezone: "Asia/Colombo" });
}

module.exports = { runCrawler, scheduleDaily };

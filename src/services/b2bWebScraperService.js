/**
 * B2B Web Scraper Service
 *
 * Primary: Puppeteer (full browser rendering for JS-heavy sites).
 * Fallback: axios + cheerio (lightweight, works without Chrome — e.g. Render).
 */

const axios = require('axios');
const { query } = require('../config/database');

let puppeteer;
try {
    puppeteer = require('puppeteer');
} catch (e) {
    console.warn('[B2B Web Scraper] Puppeteer not installed. Will use cheerio fallback.');
}

let cheerio;
try {
    cheerio = require('cheerio');
} catch (e) {
    console.warn('[B2B Web Scraper] Cheerio not installed.');
}

/**
 * Scrape a URL using axios + cheerio (no browser needed).
 */
async function scrapeWithCheerio(url) {
    const response = await axios.get(url, {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
        },
        timeout: 30000,
    });

    const html = response.data;
    const $ = cheerio.load(html);

    // Remove non-content elements
    $('script, style, noscript, iframe, svg, nav, footer, header, link, meta').remove();

    // Extract visible text
    const textParts = [];
    $('body *').each((_, el) => {
        const $el = $(el);
        // Only get direct text (not from children) to avoid duplication
        const directText = $el.contents()
            .filter((__, node) => node.type === 'text')
            .text()
            .trim();
        if (directText.length > 1) {
            textParts.push(directText);
        }
    });

    const text = textParts.join('\n');
    console.log(`[B2B Web Scraper] Cheerio scraped ${url}: ${text.length} chars extracted`);
    return { html, text };
}

/**
 * Scrape a URL using Puppeteer (full browser).
 */
async function scrapeWithPuppeteer(url) {
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
            ],
        });

        const page = await browser.newPage();
        await page.setUserAgent(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        );

        await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
        await new Promise(resolve => setTimeout(resolve, 2000));

        const html = await page.content();
        const text = await page.evaluate(() => {
            document.querySelectorAll('script, style, noscript, iframe, svg, nav, footer, header')
                .forEach(el => el.remove());

            const body = document.body;
            if (!body) return '';

            const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, {
                acceptNode: (node) => {
                    const parent = node.parentElement;
                    if (!parent) return NodeFilter.FILTER_REJECT;
                    const style = window.getComputedStyle(parent);
                    if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
                    return NodeFilter.FILTER_ACCEPT;
                }
            });

            const parts = [];
            let node;
            while ((node = walker.nextNode())) {
                const t = node.textContent.trim();
                if (t.length > 1) parts.push(t);
            }
            return parts.join('\n');
        });

        console.log(`[B2B Web Scraper] Puppeteer scraped ${url}: ${text.length} chars extracted`);
        return { html, text };
    } finally {
        if (browser) await browser.close();
    }
}

/**
 * Scrape a URL — tries Puppeteer first, falls back to cheerio.
 */
async function scrapeUrl(url) {
    // Try Puppeteer first
    if (puppeteer) {
        try {
            return await scrapeWithPuppeteer(url);
        } catch (puppeteerErr) {
            console.warn(`[B2B Web Scraper] Puppeteer failed for ${url}: ${puppeteerErr.message}. Falling back to cheerio.`);
        }
    }

    // Fallback to cheerio
    if (cheerio) {
        return await scrapeWithCheerio(url);
    }

    throw new Error('No scraping engine available. Install puppeteer or cheerio.');
}

/**
 * Scrape a URL and store the result in the database.
 */
async function scrapeAndStore(scrapeUrlId, b2bClientId, url) {
    try {
        await query(
            "UPDATE b2b_web_scrape_urls SET scrape_status = 'scraping' WHERE id = $1",
            [scrapeUrlId]
        );

        const { html, text } = await scrapeUrl(url);

        await query('DELETE FROM b2b_web_scraped_content WHERE scrape_url_id = $1', [scrapeUrlId]);

        const result = await query(
            `INSERT INTO b2b_web_scraped_content (scrape_url_id, b2b_client_id, raw_html, extracted_text)
       VALUES ($1, $2, $3, $4) RETURNING id`,
            [scrapeUrlId, b2bClientId, html, text]
        );

        await query(
            "UPDATE b2b_web_scrape_urls SET scrape_status = 'done', last_scraped_at = CURRENT_TIMESTAMP WHERE id = $1",
            [scrapeUrlId]
        );

        console.log(`[B2B Web Scraper] Stored scraped content for URL ${scrapeUrlId}: ${text.length} chars`);

        return {
            id: result.rows[0].id,
            text_length: text.length,
            extracted_text: text,
        };

    } catch (error) {
        await query(
            "UPDATE b2b_web_scrape_urls SET scrape_status = 'error' WHERE id = $1",
            [scrapeUrlId]
        );
        console.error(`[B2B Web Scraper] Error scraping ${url}:`, error.message);
        throw error;
    }
}

/**
 * Scrape all URLs for a specific B2B client.
 */
async function scrapeAllForClient(b2bClientId) {
    const urls = await query(
        'SELECT id, url FROM b2b_web_scrape_urls WHERE b2b_client_id = $1',
        [b2bClientId]
    );

    let scraped = 0;
    let errors = 0;

    for (const row of urls.rows) {
        try {
            await scrapeAndStore(row.id, b2bClientId, row.url);
            scraped++;
        } catch (e) {
            errors++;
        }
    }

    return { scraped, errors };
}

module.exports = {
    scrapeUrl,
    scrapeAndStore,
    scrapeAllForClient,
};

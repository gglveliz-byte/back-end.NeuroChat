/**
 * B2B Web Scrape Job
 * 
 * Weekly CronJob that re-scrapes all URLs for all agente_web clients.
 * Updates the knowledge base with fresh content.
 * 
 * Schedule: Every Sunday at 2:00 AM (or configured interval)
 */

const { query } = require('../config/database');
const { scrapeAndStore } = require('../services/b2bWebScraperService');
const { indexScrapedContent } = require('../services/b2bWebEmbeddingService');

/**
 * Run the weekly scrape job.
 * Scrapes all configured URLs for all active agente_web clients.
 */
async function runB2bWebScrapeJob() {
    console.log('[B2B Web Scrape Job] Starting weekly scrape...');

    try {
        // Get all scrape URLs for active agente_web clients
        const urlsResult = await query(`
      SELECT su.id as url_id, su.url, su.b2b_client_id
      FROM b2b_web_scrape_urls su
      JOIN b2b_clients bc ON su.b2b_client_id = bc.id
      WHERE bc.status = 'active' AND bc.client_type = 'agente_web'
      ORDER BY su.b2b_client_id, su.created_at
    `);

        const urls = urlsResult.rows;
        console.log(`[B2B Web Scrape Job] Found ${urls.length} URLs to scrape`);

        let scraped = 0;
        let indexed = 0;
        let errors = 0;

        for (const row of urls) {
            try {
                console.log(`[B2B Web Scrape Job] Scraping: ${row.url}`);

                // Scrape
                const scrapeResult = await scrapeAndStore(row.url_id, row.b2b_client_id, row.url);

                if (scrapeResult.extracted_text) {
                    // Index for RAG
                    const indexResult = await indexScrapedContent(
                        row.b2b_client_id,
                        row.url_id,
                        scrapeResult.extracted_text
                    );
                    indexed += indexResult.indexed;
                }

                scraped++;

                // Small delay between scrapes to be gentle on servers
                await new Promise(resolve => setTimeout(resolve, 3000));

            } catch (error) {
                errors++;
                console.error(`[B2B Web Scrape Job] Error scraping ${row.url}:`, error.message);
            }
        }

        console.log(`[B2B Web Scrape Job] Complete: ${scraped} scraped, ${indexed} chunks indexed, ${errors} errors`);
        return { scraped, indexed, errors };

    } catch (error) {
        console.error('[B2B Web Scrape Job] Fatal error:', error.message);
        throw error;
    }
}

module.exports = { runB2bWebScrapeJob };

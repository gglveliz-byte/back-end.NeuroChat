/**
 * B2B Web Crawler Service (Agentic)
 * 
 * Navigates websites guided by Vision AI (GPT-4o-mini).
 */

const puppeteer = require('puppeteer');
const fs = require('fs-extra');
const path = require('path');
const { analyzeNavigationStep } = require('./b2bWebVisionService');

const STORAGE_PATH = path.join(__dirname, '../../storage/screenshots');
const DEBUG_PATH = path.join(STORAGE_PATH, 'debug');
const VALUABLE_PATH = path.join(STORAGE_PATH, 'valuable');

/**
 * Runs the agentic scraping loop.
 * 
 * @param {string} url 
 * @param {string} clientId 
 */
async function runAgenticScrape(url, clientId) {
    console.log(`[Agentic Scraper] Starting for URL: ${url}`);
    
    // Ensure folders exist
    await fs.ensureDir(DEBUG_PATH);
    await fs.ensureDir(VALUABLE_PATH);

    const browser = await puppeteer.launch({
        headless: false, // Ahora podrás ver el navegador abriéndose
        slowMo: 50,     // Un pequeño retraso para que los ojos humanos sigan el ritmo
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--window-size=1366,768']
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1366, height: 768 });

    try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 60000 });
        
        let step = 0;
        const maxSteps = 10;
        let isReady = false;

        while (step < maxSteps && !isReady) {
            step++;
            console.log(`[Agentic Scraper] Step ${step} analyzing...`);

            // Take screenshot for AI analysis
            const screenshot = await page.screenshot({ fullPage: false });
            
            // Save debug image
            const debugFilename = `debug_${clientId}_${Date.now()}.png`;
            await fs.writeFile(path.join(DEBUG_PATH, debugFilename), screenshot);

            // Ask Vision AI what to do
            const decision = await analyzeNavigationStep(screenshot);
            console.log(`[Agentic Scraper] Decision: ${decision.action} - ${decision.explanation}`);

            if (decision.action === 'READY') {
                isReady = true;
                // Take full page screenshot as the "valuable" result
                const finalScreenshot = await page.screenshot({ fullPage: true });
                const finalFilename = `valuable_${clientId}_${Date.now()}.png`;
                await fs.writeFile(path.join(VALUABLE_PATH, finalFilename), finalScreenshot);
                console.log(`[Agentic Scraper] Valuable capture saved: ${finalFilename}`);
            } 
            else if (decision.action === 'CLICK' && decision.x && decision.y) {
                await page.mouse.click(decision.x, decision.y);
                await new Promise(r => setTimeout(r, 2000)); // Wait for animation/load
            } 
            else if (decision.action === 'SCROLL') {
                await page.evaluate(() => window.scrollBy(0, 500));
                await new Promise(r => setTimeout(r, 1000));
            }
        }

        if (!isReady) {
            console.warn(`[Agentic Scraper] Loop reached max steps (${maxSteps}) without READY status.`);
        }

        return { success: true, steps: step, ready: isReady };

    } catch (error) {
        console.error(`[Agentic Scraper] Fatal error:`, error.message);
        return { success: false, error: error.message };
    } finally {
        await browser.close();
    }
}

module.exports = {
    runAgenticScrape
};

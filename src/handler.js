import { chromium } from 'playwright-core'
import fs from 'fs/promises'
import path from 'path'
import {
    sendJobAlertEmail,
    filterJobWithGemini
} from './helpers.js'
import { fakeExtractedJobs } from './fakeJobs.data.js'

const tempFilePath = path.resolve('temp_linkedin_jobs.json');

const keyword = "Software"
// const LinkedinSearchUrl = `https://in.linkedin.com/jobs/search?keywords=${keyword}&location=India&f_TPR=r3600&position=1&pageNum=0`
const LinkedinSearchUrl = "https://in.linkedin.com/jobs/search?keywords=JavaScript&location=India&geoId=102713980&f_TPR=r3600&original_referer=https%3A%2F%2Fin.linkedin.com%2Fjobs%2Fsearch%3Fkeywords%3DJavaScript%26location%3DIndia%26geoId%3D102713980%26trk%3Dpublic_jobs_jobs-search-bar_search-submit%26position%3D1%26pageNum%3D0&position=1&pageNum=0"


// --- Helper Function: Delay ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function runScraper() {
    console.log(`Starting Linkedin job scrape at: ${new Date().toLocaleString()}`);
    let jobsFromFile = [];
    let browser;

    try {
        console.log("Launching browser...");
        browser = await chromium.launch({
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-gpu',
                '--disable-blink-features=AutomationControlled',
            ]
        });
        const context = await browser.newContext({
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
            viewport: { width: 1280, height: 720 },
            locale: 'en-US',
        });


        console.log("Browser launched.");

        const page = await context.newPage();
        await page.goto(LinkedinSearchUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });

        try {
            const dismissButton = page.getByRole('button', { name: 'Dismiss' }).first();
            if (await dismissButton.isVisible({ timeout: 3000 })) { // Check if visible quickly
                 console.log("Clicking 'Dismiss' button.");
                 await dismissButton.click();
                 await sleep(1000); // Short pause after clicking
            } else {
                 console.log("'Dismiss' button not found or not visible.");
            }
        } catch (error) {
            console.log("'Dismiss' button check failed (might not exist):", error.message);
        }
    
        // check whether jobs are loaded are not
        const jobListSelector = 'ul.jobs-search__results-list'
        const jobCountHeaderSelector = 'span.results-context-header__job-count';
    
        try {
            await page.waitForSelector(jobListSelector, {
                state: "visible",
                timeout: 30000,
            })
        } catch (error) {
            console.error("Failed to find the job list container")
            return
        }
    
        // --- Get Target Job Count ---
        let targetJobCount = 0;
        try {
            const countText = await page.locator(jobCountHeaderSelector).first().innerText({ timeout: 10000 });
            // Remove commas and parse as integer
            targetJobCount = parseInt(countText.replace(/,/g, ''), 10);
            if (isNaN(targetJobCount)) {
                 console.warn(`Could not parse job count from header text: "${countText}". Proceeding without target count.`);
                 targetJobCount = 0; // Set to 0 if parsing fails
            } else {
                 console.log(`Target job count from header: ${targetJobCount}`);
            }
        } catch (error) {
            console.warn(`Could not find or read job count header (${jobCountHeaderSelector}): ${error.message.split('\n')[0]}. Proceeding without target count.`);
            targetJobCount = 0;
        }
    
        // --- Scroll to bottom ---
        console.log("Scrolling to load all jobs...");
        let previousHeight = 0
        let currentHeight = await page.evaluate(() => document.body.scrollHeight);
    
        let scrollAttempts = 0
        let currentLiCount = 0;
        const maxScrollAttempts = 50
    
        const seeMoreButtonSelector = 'button.infinite-scroller__show-more-button:has-text("See more jobs")'
        const jobItemsLocator = page.locator(`${jobListSelector} > li`);
    
        while (scrollAttempts < maxScrollAttempts) {
    
            currentLiCount = await jobItemsLocator.count();
            console.log(`Current LI count: ${currentLiCount}`);
    
            if (targetJobCount > 0 && currentLiCount >= targetJobCount) {
                console.log(`Current LI count (${currentLiCount}) meets or exceeds target count (${targetJobCount}). Stopping loop.`);
                break;
            }
    
            // scroll down
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
            await sleep(2000)
    
            const seeMoreButton = page.locator(seeMoreButtonSelector)
            let buttonClicked = false
            
            try {
                if (await seeMoreButton.isVisible({ timeout: 1000 })) { 
                    console.log("Found 'See more jobs' button. Clicking...");
                    await seeMoreButton.click()
                    await sleep(3000);
                    buttonClicked = true
                }
            } catch (error) {
                console.error(`Info: Checking/clicking 'See more jobs' button: ${error.message.split('\n')[0]}`)
            }
    
            if (buttonClicked) {
                scrollAttempts++
                continue
            }
    
            // scroll down
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
            await sleep(2000)
    
            // check height again
            previousHeight = currentHeight
            currentHeight = await page.evaluate(() => document.body.scrollHeight)
    
            // If height didn't change much, assume end of scrollable content
            if (currentHeight <= previousHeight + 10) {
                currentLiCount = await jobItemsLocator.count();
                if (targetJobCount > 0 && currentLiCount >= targetJobCount) {
                    console.log("Target job count reached after scroll stagnation.");
                    break;
                } else {
                    console.log("Stopping based on scroll height stagnation, target count not met.");
                }
                break;
            }
            scrollAttempts++
        }
        if (scrollAttempts >= maxScrollAttempts) {
            console.warn("Reached maximum scroll attempts.");
        }
    
        console.log("Scrolling finished.");
        await sleep(1000);
    
        // --- Extract Job Details ---
        console.log("Extracting job details")
        const jobItems = await page.locator(`${jobListSelector} > li`)
        const jobCount = await jobItems.count();
        console.log(`Found ${jobCount} job items.`);
    
        const extractedJobs = []
        for (let i=0; i < jobCount; i ++) {
            const jobItem = jobItems.nth(i)
            let job = { title: null, company: null, url: null }
    
            try {
                job.title = await jobItem.locator('h3.base-search-card__title').innerText({ timeout: 1000 }).catch(() => 'N/A');
                job.company = await jobItem.locator('h4.base-search-card__subtitle a').innerText({ timeout: 1000 }).catch(() => 'N/A');
                job.url = await jobItem.locator('a.base-card__full-link').getAttribute('href', { timeout: 1000 }).catch(() => null);
    
                if (job.title && job.url && job.title !== 'N/A') {
                    extractedJobs.push(job)
                } else {
                    console.warn(`Skipping job item ${i} due to missing title or URL.`)
                }
            } catch (error) {
                console.error(`Error extracting details for job item ${i}:`, error.message);
            }
            await sleep(100);
        }
        console.log(`Successfully extracted ${extractedJobs.length} jobs with details.`);

        // --- Write jobs to temporary file ---
        try {
            console.log(`Writing ${extractedJobs.length} jobs to temporary file: ${tempFilePath}`);
            await fs.writeFile(tempFilePath, JSON.stringify(extractedJobs, null, 2)); // Use null, 2 for pretty printing
        } catch (writeError) {
            console.error("Error writing jobs to temporary file:", writeError);
            // Decide if you want to proceed without the file or stop
            // For now, we'll log the error and let it continue to browser close
        }
    
        console.log("Closing browser instance to free up resources...");
        await browser.close();
        console.log("Browser closed.");
        await sleep(2000); // Add a small delay to let resources fully release
    
        // console.log(extractedJobs)

        // --- Read jobs back from temporary file ---
        try {
            console.log(`Reading jobs from temporary file: ${tempFilePath}`);
            const fileContent = await fs.readFile(tempFilePath, 'utf-8');
            jobsFromFile = JSON.parse(fileContent);
        } catch (readError) {
            console.error("Error reading jobs from temporary file:", readError);
            // Handle the error, maybe stop the process or try to use extractedJobs if still available
            // For this example, we'll log and proceed with an empty array if read fails
            jobsFromFile = []; // Ensure it's an empty array on error
        }

    
        // --- Filter Jobs with Gemini ---
        console.log("Filtering jobs with Gemini AI...");
        const relevantJobs = await filterJobWithGemini(jobsFromFile);
        // const relevantJobs = await filterJobWithGemini(fakeExtractedJobs);
        
    
        // --- Send Email Alert ---
        console.log("Sending email with relevant jobs...");
        await sendJobAlertEmail(relevantJobs);
    } catch(error) {
        console.error("An error occured during the test", error)
        if (browser && browser.isConnected()) {
            await browser.close()
        }
    } finally {
        // --- Deleting the temporary file ---
        try {
            console.log(`Attempting to delete temporary file: ${tempFilePath}`)
            await fs.unlink(tempFilePath)
        } catch (deleteError) {
            if (deleteError.code !== 'ENOENT') { // ENOENT means file not found, which is okay if writing failed
                console.warn("Could not delete temporary file:", deleteError.message);
           } else {
                console.log("Temporary file not found (already deleted or never created).")
           }
        }
    }
}

runScraper().catch(err => {
    console.error("Script execution failed:", err);
    process.exit(1); // Exit with a non-zero code to indicate failure to GitHub Actions
});
import { GoogleGenerativeAI, SchemaType } from "@google/generative-ai";
import nodemailer from "nodemailer"
import https from "https"

// --- Gemini Configuration ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY

// --- nodemailer config ----
const EMAIL_USER = process.env.EMAIL_USER
const EMAIL_PASS = process.env.EMAIL_PASS
const EMAIL_RECIPIENT = process.env.EMAIL_RECIPIENT

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: EMAIL_USER,
        pass: EMAIL_PASS,
    },
});

// --- Helper Function: Send Email ---
export async function sendJobAlertEmail(jobs) {
    if (!jobs || jobs.length === 0) {
        console.log("No relevant jobs found to email.");
        return;
    }
    
    if (!EMAIL_USER || !EMAIL_PASS || !EMAIL_RECIPIENT) {
        console.error("Email credentials or recipient not configured in .env file. Skipping email.");
        return;
    }

    let emailBody = `<h2>Potentially Relevant LinkedIn Jobs Found:</h2><ul>`;
    jobs.forEach(job => {
        emailBody += `<li>
            <strong>Title:</strong> ${job.title}<br/>
            <strong>Company:</strong> ${job.company}<br/>
            <strong>URL:</strong> <a href="${job.url}">${job.url}</a>
        </li><hr/>`;
    });
    emailBody += `</ul>`;

    const mailOptions = {
        from: `"LinkedIn Job Bot" <${EMAIL_USER}>`,
        to: EMAIL_RECIPIENT,
        subject: `LinkedIn Job Alert - ${jobs.length} Potential Matches`,
        html: emailBody,
    };

    try {
        let info = await transporter.sendMail(mailOptions);
        console.log('Email sent: ' + info.response);
    } catch (error) {
        console.error('Error sending email:', error);
    }

}

const filterSchema = {
    description: "Filtering Jobs as per experience",
    type: SchemaType.ARRAY, // Expecting an array
    items: {
        type: SchemaType.OBJECT,
        properties: {
            title: {
                type: SchemaType.STRING,
                description: "Title of the Job",
                nullable: false,
            },
            company: {
                type: SchemaType.STRING,
                description: "Name of the Company",
                nullable: false,
            },
            url: {
                type: SchemaType.STRING,
                description: "URL link of the job",
                nullable: false,
            },
        },
        required: ["title", "company", "url"]
    }
}

// --- Gemini AI - for filtering jobs ---
export async function filterJobWithGemini(allJobs) {
    if (!allJobs || allJobs.length === 0) {
        console.log("No jobs provided to filter.");
        return [];
    }

    // const httpsAgent = new https.Agent({
    //     keepAlive: true,
    //     timeout: 30000, // 30 seconds timeout
    //     rejectUnauthorized: false // Dont Verify SSL certificates
    // })

    const genAi = new GoogleGenerativeAI(GEMINI_API_KEY)

    

    const model = genAi.getGenerativeModel({
        // gemini-2.5-pro-exp-03-25
        model: "gemini-2.0-flash",
        systemInstruction: `You are an expert job filter. Filter the provided JSON list of jobs based on the following criteria for a candidate:
        - Experience: Fresher with 0-1 year of experience.
        - Desired Roles: Software Developer, Full Stack Developer, Junior Developer, Entry-Level Software Engineer, Software Engineer 1, Associate Software Engineer, or similar roles suitable for 0-1 year experience.
        - Relevant Skills: Java, Python, JavaScript (React/Node useful but not mandatory).
        - Exclude: Senior roles, Lead roles, Manager roles, Architect roles, Staff Engineer, Principal Engineer, or roles requiring 2+ years of experience explicitly or implicitly (e.g., "SE II", "Senior SWE").
        Return ONLY a JSON array containing the jobs that STRICTLY match these criteria, adhering to the provided JSON schema. If no jobs match, return an empty array [].`,
        generationConfig: {
            responseMimeType: "application/json",
            responseSchema: filterSchema,
        },
    })

    // Convert the job list to a JSON string for the prompt
    const prompt = JSON.stringify(allJobs);

    try {
        console.log(`Sending ${allJobs.length} jobs to Gemini for filtering...`);
        const result = await model.generateContent(prompt);
        console.log(result)
        const filteredJobs = JSON.parse(result.response.text())
        console.log(filteredJobs)
        return filteredJobs

    } catch(error) {
        console.error("Error calling Gemini API:", error);
        return [];
    }
    
}
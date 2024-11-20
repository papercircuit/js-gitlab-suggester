import 'dotenv/config'; // Load environment variables from .env file
import axios from 'axios';
import express from 'express';
import { create } from 'express-handlebars';
import winston from 'winston';
import stringSimilarity from 'string-similarity';
const app = express();
const port = 3000;

// Environment variables
const GITLAB_TOKEN = process.env.GITLAB_TOKEN;
const GITLAB_URL = process.env.GITLAB_URL || 'https://gitlab.com';
const DEFAULT_USERNAME = process.env.USERNAME || 'kjohnson';

if (!GITLAB_TOKEN) {
    console.error('GitLab token is not set in the environment variables.');
    process.exit(1);
}

// Middleware to parse JSON bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Set up Handlebars as the template engine without a default layout
const hbs = create({
    defaultLayout: false, // Disable default layout
    helpers: {
        jsonStringify: function(context) {
            return JSON.stringify(context);
        },
        eq: function(a, b) {
            return a === b;
        }
    }
});

app.engine('handlebars', hbs.engine);
app.set('view engine', 'handlebars');
app.set('views', './views');

// Configure Winston logger
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.json()
  ),
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Function to get issues assigned to a user
async function getUserIssues(username) {
    try {
        logger.info('Fetching issues for user', { username });
        const response = await axios.get(`${GITLAB_URL}/api/v4/issues`, {
            headers: {
                'PRIVATE-TOKEN': GITLAB_TOKEN
            },
            params: {
                assignee_username: username,
                state: 'opened',
                scope: 'assigned_to_me',
                per_page: 100
            }
        });
        
        const rateLimit = await getRateLimitInfo(response);
        logger.info('Successfully fetched issues', { 
            count: response.data.length,
            rateLimit 
        });
        
        return {
            issues: response.data,
            rateLimit
        };
    } catch (error) {
        logger.error('Error fetching issues:', {
            error: error.message,
            username
        });
        throw new Error('Failed to fetch issues. Please try again later.');
    }
}

// Add this function to server.js
function preprocessTitle(title) {
    // Remove special characters and convert to lowercase
    const processed = title.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    
    // Remove common words that don't add meaning
    const stopWords = ['a', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'is', 'are'];
    const words = processed.split(' ').filter(word => 
        word.length > 2 && !stopWords.includes(word)
    );
    
    return words;
}

function calculateRelevanceScore(sourceTitle, targetTitle) {
    // Preprocess titles
    const sourceWords = preprocessTitle(sourceTitle);
    const targetWords = preprocessTitle(targetTitle);
    
    // Calculate word match score
    const matchingWords = sourceWords.filter(word => 
        targetWords.includes(word)
    ).length;
    
    // Calculate word order similarity
    let orderScore = 0;
    sourceWords.forEach((word, index) => {
        const targetIndex = targetWords.indexOf(word);
        if (targetIndex !== -1) {
            orderScore += 1 / (1 + Math.abs(index - targetIndex));
        }
    });
    
    // Combine scores with weights
    const matchScore = matchingWords / Math.max(sourceWords.length, targetWords.length);
    const orderWeight = orderScore / sourceWords.length;
    
    return (matchScore * 0.7) + (orderWeight * 0.3);
}

// Update the getSimilarClosedIssues function
async function getSimilarClosedIssues(sourceIssue, groupId = 8) {
    try {
        logger.info('Starting similar issues search', { 
            sourceIssue,
            groupId
        });

        // Use the search API to find similar issues within the group
        const response = await axios.get(`${GITLAB_URL}/api/v4/groups/${groupId}/search`, {
            headers: {
                'PRIVATE-TOKEN': GITLAB_TOKEN
            },
            params: {
                scope: 'issues',
                search: preprocessTitle(sourceIssue.title).join(' '),
                state: 'closed',
                per_page: 100
            }
        });

        // Score and filter results
        const scoredIssues = response.data
            .map(issue => ({
                ...issue,
                relevanceScore: calculateRelevanceScore(sourceIssue.title, issue.title)
            }))
            .filter(issue => 
                issue.relevanceScore > 0.3 && 
                issue.id.toString() !== sourceIssue.id.toString()
            )
            .sort((a, b) => b.relevanceScore - a.relevanceScore)
            .slice(0, 10)
            .map(issue => ({
                ...issue,
                similarity: Math.round(issue.relevanceScore * 100) + '%'
            }));

        return scoredIssues;
    } catch (error) {
        logger.error('Error in getSimilarClosedIssues', {
            error: error.message,
            sourceIssue
        });
        throw error;
    }
}

// Helper function to parse duration strings
function parseDuration(duration) {
    const units = {
        days: 24 * 60 * 60 * 1000,
        weeks: 7 * 24 * 60 * 60 * 1000,
        months: 30 * 24 * 60 * 60 * 1000,
        years: 365 * 24 * 60 * 60 * 1000
    };
    
    const match = duration.match(/^(\d+)(days|weeks|months|years)$/);
    if (!match) return 6 * units.months; // default to 6 months
    
    return parseInt(match[1]) * units[match[2]];
}

// Function to get merge requests that closed an issue
async function getMergeRequestsForIssue(issueId) {
    try {
        const response = await axios.get(`${GITLAB_URL}/api/v4/issues/${issueId}/closed_by`, {
            headers: {
                'PRIVATE-TOKEN': GITLAB_TOKEN
            }
        });
        return response.data;
    } catch (error) {
        console.error('Error fetching merge requests for issue:', error);
        throw new Error('Failed to fetch merge requests. Please try again later.');
    }
}

// Function to get merge request details
async function getMergeRequestDetails(mergeRequestId) {
    try {
        const response = await axios.get(`${GITLAB_URL}/api/v4/merge_requests/${mergeRequestId}/changes`, {
            headers: {
                'PRIVATE-TOKEN': GITLAB_TOKEN
            }
        });
        
        return {
            ...response.data,
            changes: response.data.changes.map(change => ({
                oldPath: change.old_path,
                newPath: change.new_path,
                diff: change.diff
            }))
        };
    } catch (error) {
        logger.error('Error fetching merge request details:', error);
        throw error;
    }
}

function calculateSimilarityScore(source, target, description = '', tags = []) {
    // Title similarity (50% weight)
    const titleScore = stringSimilarity.compareTwoStrings(
        preprocessText(source.title), 
        preprocessText(target.title)
    ) * 0.5;

    // Description similarity (30% weight)
    const descScore = description ? 
        stringSimilarity.compareTwoStrings(
            preprocessText(source.description || ''), 
            preprocessText(description)
        ) * 0.3 : 0;

    // Tags similarity (20% weight)
    const tagsScore = tags.length ? 
        stringSimilarity.compareTwoStrings(
            (source.labels || []).join(' '), 
            tags.join(' ')
        ) * 0.2 : 0;

    return titleScore + descScore + tagsScore;
}

function preprocessText(text) {
    return text.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Endpoint to display the main page
app.get('/', (req, res) => {
    res.render('index', {
        username: DEFAULT_USERNAME,
        issues: [],
        similarIssues: [],
        mergeRequests: [],
        mergeRequestDetails: null,
        error: ''
    });
});

// Endpoint to get user issues
app.post('/fetch-user-issues', async (req, res) => {
    const username = req.body.username || DEFAULT_USERNAME;
    try {
        const { issues, rateLimit } = await getUserIssues(username);
        res.render('index', { 
            username,
            issues,
            rateLimit,
            similarIssues: [],
            mergeRequests: [],
            mergeRequestDetails: null,
            error: ''
        });
    } catch (error) {
        res.render('index', {
            username,
            issues: [],
            rateLimit: {
                remaining: 'N/A',
                limit: 'N/A',
                resetTime: 'N/A'
            },
            similarIssues: [],
            mergeRequests: [],
            mergeRequestDetails: null,
            error: error.message
        });
    }
});

// Endpoint to get similar closed issues
app.post('/fetch-similar-closed-issues', async (req, res) => {
    const { issueId, issueTitle } = req.body;
    const GROUP_ID = 8;
    
    if (!issueId || !issueTitle) {
        logger.error('Missing required parameters', { issueId, issueTitle });
        return res.status(400).json({
            error: 'Missing required issue information'
        });
    }

    try {
        const similarIssues = await getSimilarClosedIssues({ id: issueId, title: issueTitle }, GROUP_ID);
        
        // Fetch merge requests for each similar issue
        const issuesWithMRs = await Promise.all(
            similarIssues.map(async (issue) => {
                try {
                    const mergeRequests = await getMergeRequestsForIssue(issue.id);
                    const mrDetails = await Promise.all(
                        mergeRequests.map(async (mr) => {
                            try {
                                const details = await getMergeRequestDetails(mr.iid);
                                return {
                                    id: mr.id,
                                    title: mr.title,
                                    description: mr.description,
                                    changes: details.changes || [],
                                    webUrl: mr.web_url
                                };
                            } catch (mrError) {
                                logger.warn(`Error fetching MR details for ${mr.iid}`, mrError);
                                return {
                                    id: mr.id,
                                    title: mr.title,
                                    description: mr.description,
                                    changes: [],
                                    webUrl: mr.web_url
                                };
                            }
                        })
                    );
                    return {
                        ...issue,
                        mergeRequests: mrDetails
                    };
                } catch (error) {
                    logger.warn(`Error fetching MRs for issue ${issue.id}`, error);
                    return {
                        ...issue,
                        mergeRequests: []
                    };
                }
            })
        );

        res.json(issuesWithMRs);
    } catch (error) {
        logger.error('Error finding similar issues', {
            error: error.message,
            issueId,
            issueTitle
        });
        res.status(500).json({ error: error.message });
    }
});

// Endpoint to get merge requests for an issue
app.post('/fetch-merge-requests', async (req, res) => {
    const issueId = req.body.issueId;
    try {
        const mergeRequests = await getMergeRequestsForIssue(issueId);
        res.render('index', { userId: req.body.userId, issues: req.body.issues, similarIssues: req.body.similarIssues, mergeRequests, mergeRequestDetails: null, error: '' });
    } catch (error) {
        res.render('index', { userId: req.body.userId, issues: req.body.issues, similarIssues: req.body.similarIssues, mergeRequests: [], mergeRequestDetails: null, error: error.message });
    }
});

// Endpoint to get merge request details
app.post('/fetch-merge-request-details', async (req, res) => {
    const mergeRequestId = req.body.mergeRequestId;
    try {
        const mergeRequestDetails = await getMergeRequestDetails(mergeRequestId);
        res.render('index', { userId: req.body.userId, issues: req.body.issues, similarIssues: req.body.similarIssues, mergeRequests: req.body.mergeRequests, mergeRequestDetails, error: '' });
    } catch (error) {
        res.render('index', { userId: req.body.userId, issues: req.body.issues, similarIssues: req.body.similarIssues, mergeRequests: req.body.mergeRequests, mergeRequestDetails: null, error: error.message });
    }
});

async function checkGitLabAccess() {
    try {
        await axios.get(`${GITLAB_URL}/api/v4/user`, {
            headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
        });
        logger.info('Successfully authenticated with GitLab API');
    } catch (error) {
        logger.error('GitLab authentication failed', {
            error: error.message,
            status: error.response?.status,
            data: error.response?.data
        });
        throw new Error(`GitLab authentication failed: ${error.response?.data?.message || error.message}`);
    }
}

// Add this to your server startup
app.listen(port, async () => {
    try {
        await checkGitLabAccess();
        logger.info(`Server running on http://localhost:${port}`);
    } catch (error) {
        logger.error('Server startup failed', { error: error.message });
        process.exit(1);
    }
});

// Handle process termination signals
process.on('SIGINT', () => {
    console.log('Received SIGINT. Shutting down server...');
    server.close(() => {
        console.log('Server closed.');
        process.exit(0);
    });
});

process.on('SIGTERM', () => {
    console.log('Received SIGTERM. Shutting down server...');
    server.close(() => {
        console.log('Server closed.');
        process.exit(0);
    });
});

app.get('/api-status', async (req, res) => {
    try {
        const response = await axios.get(`${GITLAB_URL}/api/v4/user`, {
            headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
        });
        res.json({
            status: 'ok',
            user: response.data,
            gitlabUrl: GITLAB_URL
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: error.message,
            response: error.response?.data,
            gitlabUrl: GITLAB_URL
        });
    }
});

// Add this after your routes
app.use((err, req, res, next) => {
    logger.error('Unhandled error', {
        error: err.message,
        stack: err.stack,
        path: req.path,
        method: req.method
    });
    
    res.status(500).render('index', {
        error: 'An unexpected error occurred. Please check the logs for details.',
        userId: req.body.userId,
        issues: req.body.issues || []
    });
});

async function getRateLimitInfo(response) {
    return {
        remaining: response.headers['x-ratelimit-remaining'] || 'N/A',
        limit: response.headers['x-ratelimit-limit'] || 'N/A',
        resetTime: response.headers['x-ratelimit-reset'] ? 
            new Date(parseInt(response.headers['x-ratelimit-reset']) * 1000).toLocaleTimeString() : 'N/A'
    };
}
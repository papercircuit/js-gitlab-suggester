import 'dotenv/config'; // Load environment variables from .env file
import axios from 'axios';
import express from 'express';
import { create } from 'express-handlebars';
import winston from 'winston';
import stringSimilarity from 'string-similarity';
import fs from 'fs/promises';
import path from 'path';
import natural from 'natural';
import nlp from 'compromise';
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

// Initialize NLP tools
const tokenizer = new natural.WordTokenizer();
const TfIdf = natural.TfIdf;

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
    logger.debug('Preprocessing title:', { 
        title,
        type: typeof title,
        hasValue: !!title
    });

    if (!title) {
        logger.warn('Empty or undefined title received in preprocessTitle');
        return [];
    }

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
    
    logger.debug('Processed title result:', { 
        processedWords: words,
        wordCount: words.length 
    });

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
async function getSimilarClosedIssues(sourceIssue, groupId = 8, threshold) {
    try {
        logger.info('Starting enhanced similar issues search', { 
            sourceIssue: JSON.stringify(sourceIssue),
            groupId
        });

        if (!sourceIssue?.title) {
            logger.warn('Missing title in source issue');
            return [];
        }

        // Extract key concepts using compromise
        const doc = nlp(sourceIssue.title + ' ' + (sourceIssue.description || ''));
        const nouns = doc.nouns().out('array');
        const verbs = doc.verbs().out('array');
        const terms = [...new Set([...nouns, ...verbs])];

        // Create search patterns for SQL-specific terms
        const sqlAndJspPatterns = [
            'view', 'grid', 'column', 'status', 'query', 'sp_Set', 
            'stored procedure', 'update', 'exclude', 'filter',
            // JSP specific patterns
            'pano:field', 'pano:form', 'tiles:insert', 'html:submit',
            'display_name', 'edit', 'select', 'insert', 'common'
        ];

        const hasSqlTerms = terms.some(term => 
            sqlAndJspPatterns.some(pattern => term.toLowerCase().includes(pattern))
        );

        // Multiple search strategies
        const searchTerms = sourceIssue.title.toLowerCase().split(' ');
        const keyTerms = searchTerms.filter(term => 
            sqlAndJspPatterns.some(pattern => term.includes(pattern.toLowerCase())) ||
            term.length > 3  // Include meaningful words
        );

        // Add SQL/JSP specific terms if detected
        if (sourceIssue.title.toLowerCase().includes('grid')) {
            keyTerms.push('view', 'column', 'query');
        }

        const searchPromises = [
            // Exact title match
            axios.get(`${GITLAB_URL}/api/v4/groups/${groupId}/search`, {
                headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN },
                params: {
                    scope: 'issues',
                    search: sourceIssue.title,
                    state: 'closed',
                    per_page: 100
                }
            }),
            
            // Key terms search with broader scope
            axios.get(`${GITLAB_URL}/api/v4/groups/${groupId}/search`, {
                headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN },
                params: {
                    scope: 'issues',
                    search: keyTerms.slice(0, 3).join(' OR '), // Use first 3 key terms
                    state: 'closed',
                    per_page: 100
                }
            }),

            // SQL/JSP specific search
            axios.get(`${GITLAB_URL}/api/v4/groups/${groupId}/search`, {
                headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN },
                params: {
                    scope: 'issues',
                    search: 'sp_Set OR pano:field OR tiles:insert',
                    state: 'closed',
                    per_page: 100
                }
            })
        ];

        // Add SQL-specific search if relevant
        if (hasSqlTerms) {
            searchPromises.push(
                axios.get(`${GITLAB_URL}/api/v4/groups/${groupId}/search`, {
                    headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN },
                    params: {
                        scope: 'issues',
                        search: 'sp_SetView OR sp_SetQueryColumn OR sp_SetViewset',
                        state: 'closed',
                        per_page: 100
                    }
                })
            );
        }

        const responses = await Promise.all(searchPromises);
        const allIssues = responses.flatMap(r => r.data)
            .filter((issue, index, self) => 
                index === self.findIndex(i => i.id === issue.id)
            );

        // Enhanced similarity calculation
        const tfidf = new TfIdf();
        tfidf.addDocument(sourceIssue.title + ' ' + (sourceIssue.description || ''));

        const scoredIssues = allIssues.map(issue => {
            // Basic string similarity
            const stringSim = stringSimilarity.compareTwoStrings(
                sourceIssue.title.toLowerCase(),
                issue.title.toLowerCase()
            );

            // Term overlap score
            const issueTerms = issue.title.toLowerCase().split(' ');
            const termOverlap = keyTerms.filter(term => 
                issueTerms.some(t => t.includes(term))
            ).length / keyTerms.length;

            // Pattern matching score
            const patternScore = (issue.title + ' ' + (issue.description || '')).toLowerCase()
                .split(' ')
                .some(word => sqlAndJspPatterns.some(pattern => 
                    word.includes(pattern.toLowerCase())
                )) ? 0.3 : 0;

            // View-specific scoring
            const viewScore = issue.title.toLowerCase().includes('view') && 
                (issue.description || '').toLowerCase().includes('sp_setview') ? 0.2 : 0;

            // Adjust combined score weights
            const combinedScore = (stringSim * 0.4) + (termOverlap * 0.3) + 
                (patternScore * 0.2) + (viewScore * 0.1);

            return {
                ...issue,
                similarity: combinedScore,
                similarityDisplay: `${Math.round(combinedScore * 100)}%`
            };
        });

        return scoredIssues
            .filter(issue => issue.similarity >= threshold)
            .sort((a, b) => b.similarity - a.similarity);

    } catch (error) {
        logger.error('Error in enhanced getSimilarClosedIssues', {
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
}

// Function to get merge requests that closed an issue
async function getMergeRequestsForIssue(projectId, issueIid) {
    if (!projectId || !issueIid) {
        logger.error('Invalid parameters', { projectId, issueIid });
        return []; // Return empty array instead of throwing error for better handling
    }

    try {
        logger.debug('Fetching merge requests', {
            projectId,
            issueIid,
            url: `${GITLAB_URL}/api/v4/projects/${projectId}/merge_requests`
        });

        const mergeRequestsResponse = await axios.get(
            `${GITLAB_URL}/api/v4/projects/${projectId}/merge_requests`,
            {
                headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN },
                params: {
                    search: issueIid.toString(), // Remove the # symbol from search
                    state: 'merged',
                    order_by: 'updated_at',
                    sort: 'desc',
                    per_page: 100
                }
            }
        );

        // Filter to ensure we only get MRs that actually reference this issue
        const mergeRequests = mergeRequestsResponse.data.filter(mr => {
            const description = (mr.description || '').toLowerCase();
            const title = (mr.title || '').toLowerCase();
            const issueRef = issueIid.toString();
            
            // Check for different formats of issue references
            return description.includes(`#${issueRef}`) || 
                   description.includes(`closes #${issueRef}`) ||
                   description.includes(`closed #${issueRef}`) ||
                   description.includes(`fixes #${issueRef}`) ||
                   description.includes(`fixed #${issueRef}`) ||
                   description.includes(`resolves #${issueRef}`) ||
                   description.includes(`resolved #${issueRef}`) ||
                   title.includes(`#${issueRef}`);
        });

        logger.debug('Fetched merge requests', {
            projectId,
            issueIid,
            count: mergeRequests.length,
            mergeRequests: mergeRequests.map(mr => ({
                id: mr.id,
                iid: mr.iid,
                title: mr.title
            }))
        });

        return mergeRequests;
    } catch (error) {
        logger.error('Error fetching merge requests:', {
            error: error.message,
            projectId,
            issueIid
        });
        return []; // Return empty array on error
    }
}

// Function to get merge request details
async function getMergeRequestDetails(projectId, mergeRequestIid) {
    try {
        const response = await axios.get(
            `${GITLAB_URL}/api/v4/projects/${projectId}/merge_requests/${mergeRequestIid}`,
            {
                headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
            }
        );

        // Get the changes for this merge request
        const changesResponse = await axios.get(
            `${GITLAB_URL}/api/v4/projects/${projectId}/merge_requests/${mergeRequestIid}/changes`,
            {
                headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
            }
        );

        return {
            ...response.data,
            changes: changesResponse.data.changes
        };
    } catch (error) {
        logger.error('Error fetching merge request details:', {
            error: error.message,
            projectId,
            mergeRequestIid
        });
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
        res.json({ 
            username,
            issues,
            rateLimit,
            error: ''
        });
    } catch (error) {
        res.status(500).json({
            username,
            issues: [],
            rateLimit: {
                remaining: 'N/A',
                limit: 'N/A',
                resetTime: 'N/A'
            },
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
        return res.render('index', { 
            error: 'Missing required issue information',
            issues: req.body.issues || [],
            userId: req.body.userId
        });
    }

    try {
        const similarIssues = await getSimilarClosedIssues({ id: issueId, title: issueTitle }, GROUP_ID);
        
        // Fetch merge requests for each similar issue
        const issuesWithMergeRequests = await Promise.all(
            similarIssues.map(async (issue) => {
                const mergeRequests = await getMergeRequestsForIssue(issue.project_id, issue.iid);
                return {
                    ...issue,
                    mergeRequests
                };
            })
        );

        logger.info('Found similar issues with merge requests', {
            count: issuesWithMergeRequests.length,
            issuesWithMRs: issuesWithMergeRequests.map(i => ({
                id: i.id,
                title: i.title,
                mergeRequestCount: i.mergeRequests.length
            }))
        });

        res.json({
            similarIssues: issuesWithMergeRequests,
            status: {
                similarIssues: 'completed',
                mergeRequests: 'completed',
                suggestions: issuesWithMergeRequests.some(i => i.mergeRequests.length > 0) ? 'completed' : 'pending'
            }
        });

    } catch (error) {
        logger.error('Error finding similar issues:', {
            error: error.message,
            issueId,
            issueTitle
        });
        res.status(500).json({
            error: error.message,
            similarIssues: [],
            status: {
                similarIssues: 'failed',
                mergeRequests: 'failed',
                suggestions: 'failed'
            }
        });
    }
});

// Endpoint to get merge requests for an issue
app.post('/fetch-merge-requests', async (req, res) => {
    const { issueId, projectId, iid } = req.body;
    try {
        if (!projectId || !iid) {
            throw new Error('Missing required project ID or issue IID');
        }
        
        logger.info('Fetching merge requests', {
            projectId,
            issueIid: iid
        });

        const mergeRequests = await getMergeRequestsForIssue(projectId, iid);
        res.render('index', { 
            userId: req.body.userId, 
            issues: req.body.issues, 
            similarIssues: req.body.similarIssues, 
            mergeRequests, 
            mergeRequestDetails: null, 
            error: '' 
        });
    } catch (error) {
        logger.error('Error fetching merge requests:', {
            error: error.message,
            projectId,
            issueIid: iid
        });
        res.render('index', { 
            userId: req.body.userId, 
            issues: req.body.issues, 
            similarIssues: req.body.similarIssues, 
            mergeRequests: [], 
            mergeRequestDetails: null, 
            error: error.message 
        });
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
        limit: response.headers['ratelimit-limit'] || response.headers['x-ratelimit-limit'] || 'N/A',
        remaining: response.headers['ratelimit-remaining'] || response.headers['x-ratelimit-remaining'] || 'N/A',
        resetTime: new Date(
            (response.headers['ratelimit-reset'] || response.headers['x-ratelimit-reset'] || Date.now() / 1000) * 1000
        ).toLocaleTimeString()
    };
}

async function analyzeMergeRequestChanges(mergeRequests) {
    const suggestions = [];
    
    for (const mr of mergeRequests) {
        const changePatterns = await analyzeChangePatterns(mr);
        
        for (const pattern of changePatterns) {
            const suggestion = await generateSuggestion(pattern, mr);
            if (suggestion) {
                suggestions.push(suggestion);
            }
        }
    }
    
    return suggestions;
}

async function generateSuggestion(pattern, mergeRequest) {
    const { type, changeType, patterns } = pattern;
    
    // Build context from the merge request
    const context = {
        title: mergeRequest.title,
        description: mergeRequest.description,
        changes: patterns,
        relatedFiles: pattern.relatedFiles
    };

    // Generate specific suggestions based on the type
    switch (type) {
        case 'SQL':
            return generateSQLSuggestion(changeType, context);
        case 'JSP':
            return generateJSPSuggestion(changeType, context);
        default:
            return null;
    }
}

// Add this after your existing routes
app.post('/analyze-issue', async (req, res) => {
    const { issueId, issueTitle, threshold } = req.body;
    
    try {
        if (!issueId || !issueTitle) {
            throw new Error('Missing required parameters');
        }

        const similarIssues = await getSimilarClosedIssues(
            { id: issueId, title: issueTitle },
            8, // groupId - you may want to make this configurable
            threshold || 0.3 // default threshold lowered from 0.4 to 0.3
        );

        // Add the debug logging here where similarIssues is defined
        logger.debug('Analyzing merge requests for issues', {
            similarIssuesWithDetails: similarIssues.map(i => ({
                id: i.id,
                iid: i.iid,
                project_id: i.project_id,
                title: i.title,
                references: i.references,
                web_url: i.web_url
            }))
        });

        // Get merge requests for similar issues
        const analyzedIssues = await Promise.all(
            similarIssues.map(async (issue) => {
                const projectId = issue.project_id;
                const mergeRequests = await getMergeRequestsForIssue(projectId, issue.iid);
                return {
                    ...issue,
                    mergeRequests
                };
            })
        );

        // Generate suggestions based on analyzed issues
        const suggestions = await generateSuggestions(analyzedIssues);

        res.json({
            status: {
                similarIssues: 'completed',
                mergeRequests: 'completed',
                suggestions: 'completed'
            },
            similarIssues: analyzedIssues,
            suggestions
        });

    } catch (error) {
        logger.error('Error analyzing issue:', {
            error: error.message,
            issueId,
            issueTitle
        });
        
        res.status(500).json({
            error: error.message,
            status: {
                similarIssues: 'failed',
                mergeRequests: 'failed',
                suggestions: 'failed'
            }
        });
    }
});

async function generateSuggestions(analyzedIssues) {
    const suggestions = [];
    
    for (const issue of analyzedIssues) {
        if (!issue.mergeRequests?.length) continue;
        
        for (const mr of issue.mergeRequests) {
            // Look for specific patterns in the MR description or changes
            if (mr.description?.includes('sp_SetView')) {
                suggestions.push({
                    type: 'SQL',
                    title: 'View Configuration Update',
                    description: 'Update view configuration in ezConfiguration.sql',
                    specificChanges: await generateViewUpdateSuggestions({ 
                        changes: mr.description.match(/sp_SetView[^;]+/g) || []
                    })
                });
            }
            
            if (mr.description?.includes('sp_SetDropdown')) {
                suggestions.push({
                    type: 'SQL',
                    title: 'Dropdown Configuration Update',
                    description: 'Update dropdown configuration in ezConfiguration.sql',
                    specificChanges: await generateDropdownUpdateSuggestions({
                        changes: mr.description.match(/sp_SetDropdown[^;]+/g) || []
                    })
                });
            }
        }
    }
    
    return suggestions;
}
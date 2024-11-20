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
async function getSimilarClosedIssues(sourceIssue, groupId = 8, threshold = 0.4) {
    try {
        logger.info('Starting similar issues search', { 
            sourceIssue: JSON.stringify(sourceIssue),
            groupId,
            hasTitle: !!sourceIssue?.title
        });

        if (!sourceIssue?.title) {
            logger.warn('Missing title in source issue', { sourceIssue });
            return [];
        }

        // Split the title into meaningful terms
        const searchTerms = preprocessTitle(sourceIssue.title);
        
        // Get issues using multiple search strategies
        const responses = await Promise.all([
            // Strategy 1: Exact title match
            axios.get(`${GITLAB_URL}/api/v4/groups/${groupId}/search`, {
                headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN },
                params: {
                    scope: 'issues',
                    search: `"${sourceIssue.title}"`, // Exact phrase
                    state: 'closed',
                    per_page: 100
                }
            }),
            
            // Strategy 2: Individual terms
            axios.get(`${GITLAB_URL}/api/v4/groups/${groupId}/search`, {
                headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN },
                params: {
                    scope: 'issues',
                    search: searchTerms.join(' '), // Space-separated terms
                    state: 'closed',
                    per_page: 100
                }
            }),
            
            // Strategy 3: Labels and key terms
            axios.get(`${GITLAB_URL}/api/v4/groups/${groupId}/issues`, {
                headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN },
                params: {
                    state: 'closed',
                    labels: sourceIssue.labels?.join(','),
                    search: searchTerms[0], // Most significant term
                    per_page: 100
                }
            })
        ]);

        // Combine and deduplicate results
        const allIssues = responses.flatMap(r => r.data)
            .filter((issue, index, self) => 
                index === self.findIndex(i => i.id === issue.id)
            );

        logger.info(`Found ${allIssues.length} potential similar issues`);

        // Calculate similarity scores
        const scoredIssues = allIssues.map(issue => {
            const similarity = calculateSimilarity(sourceIssue.title, issue.title);
            
            // Also consider label similarity if available
            let labelSimilarity = 0;
            if (sourceIssue.labels && issue.labels) {
                const sourceLabels = new Set(sourceIssue.labels);
                const targetLabels = new Set(issue.labels);
                const intersection = new Set([...sourceLabels].filter(x => targetLabels.has(x)));
                labelSimilarity = intersection.size / Math.max(sourceLabels.size, targetLabels.size);
            }

            // Combined similarity score (80% title, 20% labels)
            const combinedSimilarity = (similarity * 0.8) + (labelSimilarity * 0.2);

            logger.debug('Calculated similarity score', {
                sourceTitle: sourceIssue.title,
                targetTitle: issue.title,
                titleSimilarity: similarity,
                labelSimilarity,
                combinedSimilarity
            });

            return {
                ...issue,
                similarity: combinedSimilarity,
                similarityDisplay: `${Math.round(combinedSimilarity * 100)}%`
            };
        });

        // Filter by threshold (lower threshold means MORE results, not fewer)
        const filteredIssues = scoredIssues.filter(issue => issue.similarity >= threshold)
            .sort((a, b) => b.similarity - a.similarity);

        logger.info('Filtered issues by threshold', {
            threshold: `${threshold * 100}%`,
            totalIssues: scoredIssues.length,
            filteredIssues: filteredIssues.length
        });

        return filteredIssues;
    } catch (error) {
        logger.error('Error in getSimilarClosedIssues', {
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
        const mergeRequestsResponse = await axios.get(
            `${GITLAB_URL}/api/v4/projects/${projectId}/merge_requests`,
            {
                headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN },
                params: {
                    search: `#${issueIid}`,
                    state: 'merged',
                    order_by: 'updated_at',
                    sort: 'desc'
                }
            }
        );
        
        // Filter to ensure we only get MRs that actually reference this issue
        const mergeRequests = mergeRequestsResponse.data.filter(mr => {
            const description = (mr.description || '').toLowerCase();
            const title = (mr.title || '').toLowerCase();
            return description.includes(`#${issueIid}`) || 
                   title.includes(`#${issueIid}`);
        });

        logger.debug('Fetched merge requests', {
            projectId,
            issueIid,
            count: mergeRequests.length
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
        
        // Fetch and analyze merge requests for each similar issue
        const analyzedIssues = await Promise.all(
            similarIssues.map(async (issue) => {
                try {
                    const mergeRequests = await getMergeRequestsForIssue(issue.id);
                    const mrDetails = await Promise.all(
                        mergeRequests.map(async (mr) => {
                            try {
                                return await getMergeRequestDetails(mr.iid);
                            } catch (mrError) {
                                logger.warn(`Error fetching MR details for ${mr.iid}`, mrError);
                                return null;
                            }
                        })
                    );
                    
                    const validMRs = mrDetails.filter(mr => mr !== null);
                    const suggestions = await analyzeMergeRequestChanges(validMRs);
                    
                    return {
                        ...issue,
                        suggestions,
                        mergeRequests: validMRs
                    };
                } catch (error) {
                    logger.warn(`Error analyzing MRs for issue ${issue.id}`, error);
                    return {
                        ...issue,
                        suggestions: [],
                        mergeRequests: []
                    };
                }
            })
        );

        // Render the template with the results
        res.render('index', {
            userId: req.body.userId,
            issues: req.body.issues,
            similarIssues: analyzedIssues.map(issue => ({
                ...issue,
                similarity: issue.similarity
            })),
            selectedIssueId: issueId,
            error: ''
        });
    } catch (error) {
        logger.error('Error finding similar issues', {
            error: error.message,
            issueId,
            issueTitle
        });
        res.render('index', {
            error: error.message,
            issues: req.body.issues || [],
            userId: req.body.userId
        });
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
    // Using GitLab's x- prefixed headers
    const total = response.headers['x-total'] || 'N/A';
    const perPage = response.headers['x-per-page'] || 'N/A';

    return {
        limit: `${total} total`,
        remaining: `${perPage} per request`,
    };
}

async function analyzeMergeRequestChanges(mergeRequests) {
    try {
        logger.info('Starting merge request analysis', {
            mergeRequestCount: mergeRequests.length
        });

        // Get changes for each merge request
        const changes = await Promise.all(mergeRequests.map(async mr => {
            try {
                const response = await axios.get(
                    `${GITLAB_URL}/api/v4/projects/${mr.project_id}/merge_requests/${mr.iid}/changes`,
                    { headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN } }
                );
                return response.data.changes;
            } catch (error) {
                logger.error('Error fetching MR changes', {
                    mrId: mr.iid,
                    error: error.message
                });
                return [];
            }
        }));

        const allChanges = changes.flat().filter(Boolean);
        logger.info('Retrieved changes', { 
            totalChanges: allChanges.length 
        });

        if (allChanges.length === 0) {
            return [];
        }

        const changesByType = allChanges.reduce((acc, change) => {
            const fileType = change.new_path.split('.').pop();
            if (!acc[fileType]) acc[fileType] = [];
            acc[fileType].push(change);
            return acc;
        }, {});

        const suggestions = [];
        
        if (changesByType.sql) {
            const patterns = analyzeCommonPatterns(changesByType.sql);
            suggestions.push({
                type: 'SQL',
                files: [...new Set(changesByType.sql.map(c => c.new_path))],
                commonPatterns: patterns,
                suggestion: 'Consider these SQL changes based on similar issues'
            });
        }

        logger.info('Analysis complete', {
            suggestionsCount: suggestions.length
        });

        return suggestions;
    } catch (error) {
        logger.error('Error in analyzeMergeRequestChanges', {
            error: error.message,
            stack: error.stack
        });
        throw error;
    }
}

function analyzeCommonPatterns(changes) {
    const patterns = [];
    
    changes.forEach(change => {
        const diff = change.diff;
        
        // Look for common patterns in the diffs
        if (diff.includes('sp_SetQueryColumn')) {
            patterns.push('Column modifications detected');
        }
        if (diff.includes('sp_SetView')) {
            patterns.push('View modifications detected');
        }
        if (diff.includes('sp_SetViewset')) {
            patterns.push('Viewset modifications detected');
        }
    });
    
    return [...new Set(patterns)]; // Remove duplicates
}

// Add this new endpoint to server.js
app.post('/analyze-issue', async (req, res) => {
    const { issueId, issueTitle } = req.body;
    const threshold = parseFloat(req.body.threshold || 0.4);
    
    logger.info('Starting issue analysis', {
        issueId,
        issueTitle,
        threshold
    });

    try {
        // Pass the threshold to getSimilarClosedIssues
        const similarIssues = await getSimilarClosedIssues({ 
            id: issueId, 
            title: issueTitle 
        }, 8, threshold);
        
        logger.info('Found similar issues', {
            count: similarIssues.length
        });

        // Step 2: Get merge requests for each similar issue
        const mergeRequestPromises = similarIssues.map(issue => 
            getMergeRequestsForIssue(issue.project_id, issue.iid)
        );
        
        const mergeRequests = (await Promise.all(mergeRequestPromises))
            .flat()
            .filter(Boolean);

        logger.info('Fetched merge requests', {
            totalCount: mergeRequests.length
        });

        // Step 3: Analyze changes
        const suggestions = await analyzeMergeRequestChanges(mergeRequests);

        res.json({
            similarIssues,
            mergeRequests,
            suggestions,
            status: {
                similarIssues: 'completed',
                mergeRequests: 'completed',
                suggestions: suggestions.length > 0 ? 'completed' : 'pending'
            }
        });

    } catch (error) {
        logger.error('Error analyzing issue', {
            error: error.message,
            stack: error.stack
        });
        res.status(500).json({
            error: 'Failed to analyze issue',
            details: error.message
        });
    }
});

app.get('/initial-rate-limit', async (req, res) => {
    try {
        const response = await axios.head(`${GITLAB_URL}/api/v4/projects`, {
            headers: { 'PRIVATE-TOKEN': GITLAB_TOKEN }
        });
        const rateLimit = await getRateLimitInfo(response);
        res.json({ rateLimit });
    } catch (error) {
        res.status(500).json({
            error: 'Failed to fetch rate limit',
            details: error.message
        });
    }
});

function calculateSimilarity(sourceTitle, targetTitle) {
    if (!sourceTitle || !targetTitle) return 0;
    
    // Normalize strings and split into words
    const sourceWords = sourceTitle.toLowerCase().split(/\s+/);
    const targetWords = targetTitle.toLowerCase().split(/\s+/);
    
    // Calculate Jaccard similarity
    const sourceSet = new Set(sourceWords);
    const targetSet = new Set(targetWords);
    const intersection = new Set([...sourceSet].filter(x => targetSet.has(x)));
    const union = new Set([...sourceSet, ...targetSet]);
    
    const jaccardSimilarity = intersection.size / union.size;
    
    // Calculate word order similarity
    let orderScore = 0;
    sourceWords.forEach((word, index) => {
        const targetIndex = targetWords.indexOf(word);
        if (targetIndex !== -1) {
            orderScore += 1 / (1 + Math.abs(index - targetIndex));
        }
    });
    const orderSimilarity = orderScore / Math.max(sourceWords.length, targetWords.length);
    
    // Combine scores with weights (70% Jaccard, 30% order)
    const similarity = (jaccardSimilarity * 0.7) + (orderSimilarity * 0.3);
    
    logger.debug('Calculated similarity', {
        sourceTitle,
        targetTitle,
        jaccardSimilarity,
        orderSimilarity,
        finalSimilarity: similarity
    });

    return similarity;
}
import express from 'express';
import { issueService } from '../services/issueService.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.post('/fetch-user-issues', async (req, res) => {
    const username = req.body.username || config.gitlab.defaultUsername;
    try {
        const { issues, rateLimit } = await issueService.getUserIssues(username);
        res.json({ username, issues, rateLimit, error: '' });
    } catch (error) {
        logger.error('Error in fetch-user-issues:', error);
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

router.post('/analyze', async (req, res) => {
    const { issueId, issueTitle, threshold = 0.4 } = req.body;
    
    try {
        const result = await issueService.analyzeIssue(issueId, issueTitle, threshold);
        res.json(result);
    } catch (error) {
        logger.error('Error in analyze-issue:', error);
        res.status(500).json({
            error: 'Failed to analyze issue',
            details: error.message
        });
    }
});

export default router;
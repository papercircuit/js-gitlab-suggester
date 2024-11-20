import express from 'express';
import issueRoutes from './issueRoutes.js';
import mergeRequestRoutes from './mergeRequestRoutes.js';
import statusRoutes from './statusRoutes.js';

const router = express.Router();

// Main page route
router.get('/', (req, res) => {
    res.render('pages/index', {
        username: config.gitlab.defaultUsername,
        issues: [],
        similarIssues: [],
        mergeRequests: [],
        mergeRequestDetails: null,
        error: ''
    });
});

router.use('/issues', issueRoutes);
router.use('/merge-requests', mergeRequestRoutes);
router.use('/status', statusRoutes);

export default router;
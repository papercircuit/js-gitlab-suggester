import express from 'express';
import { mergeRequestService } from '../services/mergeRequestService.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.get('/:issueId', async (req, res, next) => {
    try {
        const mergeRequests = await mergeRequestService.getMergeRequestsForIssue(
            req.params.issueId
        );
        res.json(mergeRequests);
    } catch (error) {
        next(error);
    }
});

router.get('/:projectId/:mergeRequestIid/changes', async (req, res, next) => {
    try {
        const changes = await mergeRequestService.getMergeRequestChanges(
            req.params.projectId,
            req.params.mergeRequestIid
        );
        res.json(changes);
    } catch (error) {
        next(error);
    }
});

export default router;
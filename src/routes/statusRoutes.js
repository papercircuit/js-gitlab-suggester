import express from 'express';
import { gitlabService } from '../services/gitlabService.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

router.get('/rate-limit', async (req, res, next) => {
    try {
        const rateLimit = await gitlabService.getRateLimit();
        res.json({ rateLimit });
    } catch (error) {
        next(error);
    }
});

router.get('/api', async (req, res, next) => {
    try {
        const response = await gitlabService.api.get('/user');
        res.json({
            status: 'ok',
            user: response.data
        });
    } catch (error) {
        next(error);
    }
});

export default router;
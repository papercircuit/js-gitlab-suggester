import { logger } from '../utils/logger.js';

export const errorHandler = (err, req, res, next) => {
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
};
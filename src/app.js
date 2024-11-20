import express from 'express';
import { create } from 'express-handlebars';
import { config } from './config/config.js';
import { logger } from './utils/logger.js';
import { errorHandler } from './middleware/errorHandler.js';
import routes from './routes/index.js';

const app = express();

// Configure Handlebars
const hbs = create({
    defaultLayout: false,
    helpers: {
        jsonStringify: context => JSON.stringify(context),
        eq: (a, b) => a === b
    }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.engine('handlebars', hbs.engine);
app.set('view engine', 'handlebars');
app.set('views', './views');

// Routes
app.use('/api', routes);

// Error handling
app.use(errorHandler);

// Server startup
const server = app.listen(config.port, async () => {
    try {
        logger.info(`Server running on http://localhost:${config.port}`);
    } catch (error) {
        logger.error('Server startup failed', { error: error.message });
        process.exit(1);
    }
});

// Graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM received. Shutting down gracefully...');
    server.close(() => {
        logger.info('Server closed');
        process.exit(0);
    });
});

app.use(express.static('src/public'));

export default app;
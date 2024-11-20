import axios from 'axios';
import { config } from '../config/config.js';
import { logger } from '../utils/logger.js';

const gitlabApi = axios.create({
    baseURL: `${config.gitlab.url}/api/v4`,
    headers: { 'PRIVATE-TOKEN': config.gitlab.token }
});

gitlabApi.interceptors.response.use(
    response => response,
    error => {
        logger.error('GitLab API Error:', {
            status: error.response?.status,
            message: error.message,
            path: error.config?.url
        });
        throw error;
    }
);

export async function getRateLimit() {
    try {
        const response = await gitlabApi.head('/users');
        return {
            limit: response.headers['ratelimit-limit'],
            remaining: response.headers['ratelimit-remaining'],
            resetTime: new Date(response.headers['ratelimit-reset'] * 1000).toLocaleTimeString()
        };
    } catch (error) {
        logger.error('Failed to get rate limit:', error);
        throw error;
    }
}

export async function searchIssues(query, state = 'closed') {
    try {
        const response = await gitlabApi.get('/issues', {
            params: {
                search: query,
                state,
                scope: 'all',
                per_page: 100
            }
        });
        return response.data;
    } catch (error) {
        logger.error('Failed to search issues:', error);
        throw error;
    }
}

export const gitlabService = {
    getRateLimit,
    searchIssues,
    api: gitlabApi
};
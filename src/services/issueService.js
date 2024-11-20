import { gitlabService } from './gitlabService.js';
import { logger } from '../utils/logger.js';

export async function getAssignedIssues(username) {
    try {
        const response = await gitlabService.api.get('/issues', {
            params: {
                assignee_username: username,
                state: 'opened',
                scope: 'all',
                per_page: 100
            }
        });
        return response.data;
    } catch (error) {
        logger.error('Failed to fetch assigned issues:', {
            username,
            error: error.message
        });
        throw error;
    }
}

export async function getIssueDetails(issueId) {
    try {
        const response = await gitlabService.api.get(`/issues/${issueId}`);
        return response.data;
    } catch (error) {
        logger.error('Failed to fetch issue details:', {
            issueId,
            error: error.message
        });
        throw error;
    }
}

export const issueService = {
    getAssignedIssues,
    getIssueDetails
};
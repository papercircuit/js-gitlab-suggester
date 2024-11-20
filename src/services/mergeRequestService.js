import { gitlabService } from './gitlabService.js';
import { logger } from '../utils/logger.js';

export async function getMergeRequestsForIssue(issueIid, projectId) {
    try {
        const response = await gitlabService.api.get(`/projects/${projectId}/merge_requests`, {
            params: {
                search: `#${issueIid}`,
                state: 'merged',
                per_page: 100
            }
        });
        return response.data;
    } catch (error) {
        logger.error('Failed to fetch merge requests:', {
            issueIid,
            projectId,
            error: error.message
        });
        throw error;
    }
}

export async function getMergeRequestChanges(projectId, mergeRequestIid) {
    try {
        const response = await gitlabService.api.get(
            `/projects/${projectId}/merge_requests/${mergeRequestIid}/changes`
        );
        return response.data;
    } catch (error) {
        logger.error('Failed to fetch merge request changes:', {
            projectId,
            mergeRequestIid,
            error: error.message
        });
        throw error;
    }
}

export const mergeRequestService = {
    getMergeRequestsForIssue,
    getMergeRequestChanges
};
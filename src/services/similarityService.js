import { logger } from '../utils/logger.js';
import { preprocessTitle } from '../utils/textProcessing.js';

export function calculateSimilarity(sourceTitle, targetTitle) {
    if (!sourceTitle || !targetTitle) {
        logger.warn('Missing title in similarity calculation', {
            sourceTitle,
            targetTitle
        });
        return 0;
    }

    const sourceWords = preprocessTitle(sourceTitle);
    const targetWords = preprocessTitle(targetTitle);
    
    const matchingWords = sourceWords.filter(word => 
        targetWords.includes(word)
    ).length;
    
    let orderScore = 0;
    sourceWords.forEach((word, index) => {
        const targetIndex = targetWords.indexOf(word);
        if (targetIndex !== -1) {
            orderScore += 1 / (1 + Math.abs(index - targetIndex));
        }
    });
    
    const matchScore = matchingWords / Math.max(sourceWords.length, targetWords.length);
    const orderWeight = orderScore / sourceWords.length;
    
    return (matchScore * 0.7) + (orderWeight * 0.3);
}

export const similarityService = {
    calculateSimilarity
};
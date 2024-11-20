import { logger } from './logger.js';

export function preprocessTitle(title) {
    logger.debug('Preprocessing title:', { 
        title,
        type: typeof title,
        hasValue: !!title
    });

    if (!title) {
        logger.warn('Empty or undefined title received in preprocessTitle');
        return [];
    }

    const processed = title.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    
    const stopWords = ['a', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'is', 'are'];
    const words = processed.split(' ').filter(word => 
        word.length > 2 && !stopWords.includes(word)
    );
    
    return words;
}

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

export function preprocessText(text) {
    return text.toLowerCase()
        .replace(/[^\w\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}
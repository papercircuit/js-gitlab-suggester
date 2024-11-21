import natural from 'natural';
import path from 'path';

const CHANGE_PATTERNS = {
    SQL: {
        VIEW_UPDATE: {
            pattern: /EXECUTE\s+sp_SetView\s+'([^']+)',\s+'([^']+)',\s+'([^']+)'/,
            relatedPatterns: [
                /sp_SetWhereClause/,
                /sp_SetQueryColumn/,
                /sp_SetViewsetAlias/
            ],
            filePattern: /ezConfiguration\.sql$/i
        },
        DROPDOWN_UPDATE: {
            pattern: /EXECUTE\s+sp_SetDropdown/,
            relatedPatterns: [
                /sp_SetViewsetAlias/,
                /sp_SetWhereClause/
            ],
            filePattern: /ezConfiguration\.sql$/i
        }
    },
    JSP: {
        TEMPLATE_UPDATE: {
            pattern: /<pano:(form|field|grid)/,
            relatedPatterns: [
                /<tiles:insert/,
                /<html:submit/
            ],
            filePattern: /_body\.jsp$/i
        }
    }
};

export async function analyzeChangePatterns(mergeRequest) {
    const changes = mergeRequest.changes || [];
    const suggestions = [];

    for (const change of changes) {
        const fileType = getFileType(change.new_path);
        const patterns = CHANGE_PATTERNS[fileType];

        if (patterns) {
            for (const [changeType, patternConfig] of Object.entries(patterns)) {
                if (patternConfig.filePattern.test(change.new_path)) {
                    const matchedPatterns = findPatternMatches(change.diff, patternConfig);
                    if (matchedPatterns.length > 0) {
                        suggestions.push({
                            type: fileType,
                            changeType,
                            patterns: matchedPatterns,
                            relatedFiles: await findRelatedFiles(change, patternConfig)
                        });
                    }
                }
            }
        }
    }

    return suggestions;
}

function findPatternMatches(diff, patternConfig) {
    const matches = [];
    const mainMatch = diff.match(patternConfig.pattern);
    
    if (mainMatch) {
        matches.push({
            type: 'main',
            match: mainMatch[0],
            groups: mainMatch.slice(1)
        });

        // Look for related patterns
        patternConfig.relatedPatterns.forEach(pattern => {
            const relatedMatches = diff.match(pattern);
            if (relatedMatches) {
                matches.push({
                    type: 'related',
                    match: relatedMatches[0]
                });
            }
        });
    }

    return matches;
}
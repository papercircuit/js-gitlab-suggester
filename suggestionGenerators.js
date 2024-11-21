export async function generateSQLSuggestion(changeType, context) {
    switch (changeType) {
        case 'VIEW_UPDATE':
            return {
                type: 'SQL',
                title: 'View Configuration Update',
                description: 'Update view configuration in ezConfiguration.sql',
                specificChanges: generateViewUpdateSuggestions(context),
                relatedFiles: context.relatedFiles
            };
        case 'DROPDOWN_UPDATE':
            return {
                type: 'SQL',
                title: 'Dropdown Configuration Update',
                description: 'Update dropdown configuration in ezConfiguration.sql',
                specificChanges: generateDropdownUpdateSuggestions(context),
                relatedFiles: context.relatedFiles
            };
    }
}

function generateViewUpdateSuggestions(context) {
    const suggestions = [];
    const mainChange = context.changes.find(c => c.type === 'main');
    
    if (mainChange) {
        const [query, viewset, name] = mainChange.groups;
        suggestions.push(`EXECUTE sp_SetView '${query}', '${viewset}', '${name}'`);
        
        // Add related WHERE clauses if found
        const whereChanges = context.changes.filter(c => 
            c.type === 'related' && c.match.includes('sp_SetWhereClause')
        );
        whereChanges.forEach(change => {
            suggestions.push(change.match);
        });
    }
    
    return suggestions;
}
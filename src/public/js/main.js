// Rate limit tracking
async function fetchInitialRateLimit() {
    try {
        const response = await fetch('/api/status/rate-limit');
        const data = await response.json();
        if (data.rateLimit) {
            updateRateLimitDisplay(data.rateLimit);
        }
    } catch (error) {
        console.error('Error fetching initial rate limit:', error);
    }
}

function updateRateLimitDisplay(rateLimit) {
    document.getElementById('rateLimit').textContent = rateLimit.limit;
    document.getElementById('rateLimitRemaining').textContent = rateLimit.remaining;
    document.getElementById('rateLimitReset').textContent = rateLimit.resetTime;
}

// Issue management
async function fetchUserIssues(event) {
    event.preventDefault();
    const username = document.getElementById('username').value;
    
    try {
        const response = await fetch('/api/issues/assigned/' + username);
        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error);
        }
        
        updateIssuesDropdown(data.issues);
        if (data.rateLimit) {
            updateRateLimitDisplay(data.rateLimit);
        }
    } catch (error) {
        console.error('Error fetching issues:', error);
        document.getElementById('error-message').textContent = error.message;
        document.getElementById('error-message').style.display = 'block';
    }
}

function updateIssuesDropdown(issues) {
    const select = document.getElementById('issues');
    select.innerHTML = '<option value="">Select an issue</option>' +
        issues.map(issue => `
            <option value="${issue.id}" data-title="${issue.title}">
                ${issue.title}
            </option>
        `).join('');
}

// Analysis and suggestions
async function analyzeIssue(event) {
    event.preventDefault();
    const issueId = document.getElementById('issues').value;
    const threshold = document.getElementById('similarityThreshold').value;
    
    if (!issueId) {
        alert('Please select an issue first');
        return;
    }

    document.getElementById('loading').classList.add('active');
    document.getElementById('analysis-progress').style.display = 'block';
    document.getElementById('error-message').style.display = 'none';

    try {
        const response = await fetch('/api/issues/analyze', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                issueId,
                similarityThreshold: threshold
            })
        });
        
        const data = await response.json();
        
        if (data.error) {
            throw new Error(data.error);
        }

        updateAnalysisStatus(data);
        displayResults(data);
        
    } catch (error) {
        console.error('Error analyzing issue:', error);
        document.getElementById('error-message').textContent = error.message;
        document.getElementById('error-message').style.display = 'block';
        updateStepStatus('similar-issues-status', 'failed');
    } finally {
        document.getElementById('loading').classList.remove('active');
    }
}

function updateAnalysisStatus(data) {
    if (data.status) {
        updateStepStatus('similar-issues-status', data.status.similarIssues);
        updateStepStatus('merge-requests-status', data.status.mergeRequests);
        updateStepStatus('suggestions-status', data.status.suggestions);
    }
}

function updateStepStatus(elementId, status) {
    const element = document.getElementById(elementId);
    if (element) {
        element.textContent = status;
        element.className = status;
    }
}

function displayResults(data) {
    displaySimilarIssues(data.similarIssues);
    displayMergeRequests(data.mergeRequests);
    displaySuggestions(data.suggestions);
}

function displaySimilarIssues(issues) {
    const container = document.getElementById('similar-issues-list');
    if (!issues || issues.length === 0) {
        container.innerHTML = '<p>No similar issues found</p>';
        return;
    }

    container.innerHTML = issues.map(issue => `
        <div class="issue-card">
            <h4>${issue.title}</h4>
            <p class="similarity-score">Similarity: ${(issue.similarity * 100).toFixed(1)}%</p>
            <div class="issue-details">
                <p>Status: ${issue.state}</p>
                <p>Created: ${new Date(issue.created_at).toLocaleDateString()}</p>
            </div>
        </div>
    `).join('');
}

function displayMergeRequests(mergeRequests) {
    const container = document.getElementById('merge-requests-list');
    if (!mergeRequests || mergeRequests.length === 0) {
        container.innerHTML = '<p>No related merge requests found</p>';
        return;
    }

    container.innerHTML = mergeRequests.map(mr => `
        <div class="merge-request-card">
            <h4>${mr.title}</h4>
            <p>Author: ${mr.author.name}</p>
            <p>Merged: ${new Date(mr.merged_at).toLocaleDateString()}</p>
        </div>
    `).join('');
}

// Reference to displaySuggestions function from index.html:
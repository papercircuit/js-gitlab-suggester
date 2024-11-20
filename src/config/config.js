import 'dotenv/config';

export const config = {
    port: process.env.PORT || 3000,
    gitlab: {
        token: process.env.GITLAB_TOKEN,
        url: process.env.GITLAB_URL || 'https://gitlab.com',
        defaultUsername: process.env.USERNAME || 'kjohnson'
    }
};

if (!config.gitlab.token) {
    console.error('GitLab token is not set in the environment variables.');
    process.exit(1);
}
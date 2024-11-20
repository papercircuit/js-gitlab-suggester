js-gitlab-suggester/
├── node_modules/
├── views/
│   ├── layouts/
│   │   └── main.handlebars
│   └── index.handlebars
├── .env
├── kill-port.sh
├── package.json
└── server.js

# GitLab Issue Helper

## Overview

The GitLab Issue Helper is a web application that connects to the GitLab API to help developers manage and resolve issues more efficiently. It allows users to:

- Fetch issues assigned to them or another user.
- Find similar closed issues based on the selected issue's title.
- View merge requests that successfully closed those similar issues.
- View details of merge requests, including file changes.

## Features

- **Fetch Assigned Issues**: Retrieve issues assigned to a specific user.
- **Find Similar Closed Issues**: Search for closed issues with similar titles.
- **View Merge Requests**: List merge requests that closed the similar issues.
- **View Merge Request Details**: Display detailed information about a selected merge request, including file changes.

## Prerequisites

- **Node.js**: Ensure you have Node.js installed on your machine. You can download it from [nodejs.org](https://nodejs.org/).
- **GitLab Account**: You need a GitLab account with access to the project where you want to manage issues.
- **GitLab Personal Access Token**: Create a personal access token with the necessary permissions (`api`, `read_repository`, `read_user`). You can create a token in your GitLab account settings under **Access Tokens**.

## Installation

1. **Clone the Repository**

    ```bash
    git clone https://github.com/your-username/js-gitlab-suggester.git
    cd js-gitlab-suggester
    ```

2. **Install Dependencies**

    ```bash
    npm install
    ```

3. **Create a `.env` File**

    Create a `.env` file in the root directory of the project and add your GitLab personal access token.

    ```plaintext
    # .env
    GITLAB_TOKEN=your_gitlab_personal_access_token_here
    ```

## Running the Application

1. **Start the Server**

    ```bash
    npm start
    ```

2. **Access the Application**

    Open your web browser and navigate to `http://localhost:3000`.

## Usage

1. **Fetch Issues**

    - Enter the GitLab user ID in the "User ID" field.
    - Click the "Fetch Issues" button to retrieve issues assigned to the specified user.

2. **Select an Issue**

    - From the "Select an Issue" dropdown, choose an issue you want to work on.

3. **Find Similar Closed Issues**

    - Once an issue is selected, the application will automatically fetch similar closed issues based on the issue title.

4. **View Merge Requests**

    - From the "Similar Closed Issues" dropdown, select a closed issue to view the merge requests that closed it.

5. **View Merge Request Details**

    - From the "Merge Requests" dropdown, select a merge request to view detailed information, including file changes.

## Error Handling

- The application provides error messages if any API calls fail, helping users understand what went wrong and take corrective actions.

## Enhancements

- **View Merge Request Details**: The application displays detailed information about a selected merge request, including file changes.
- **User Feedback**: Error messages are displayed to provide feedback on any issues encountered during API calls.


## License

This project is licensed under the [MIT License](LICENSE).
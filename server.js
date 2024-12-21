const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(bodyParser.json());

const GITHUB_GRAPHQL_URL = 'https://api.github.com/graphql';

const PR_QUERY = `
  query ($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequests(first: 100, after: $cursor) {
        edges {
          node {
            title
            body
            comments(first: 5) {
              edges {
                node {
                  body
                  author {
                    login
                  }
                }
              }
            }
            reviews(first: 5) {
              edges {
                node {
                  state
                  body
                  author {
                    login
                  }
                }
              }
            }
            files(first: 10) {
              edges {
                node {
                  path
                  additions
                  deletions
      			  changeType
                }
              }
            }
          }
        }
        pageInfo {
          endCursor
          hasNextPage
        }
      }
    }
  }
`;

const parseRepoUrl = (url) => {
  const regex = /(?:https?:\/\/github\.com\/)?([^/]+)\/([^/]+)/;
  const match = url.match(regex);
  if (!match) throw new Error('Invalid repository URL');
  return { owner: match[1], name: match[2] };
};

const fetchPRs = async (owner, name, token) => {
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    let cursor = null;
    const prsData = [];
  
    try {
      do {
        console.log('Fetching PRs for:', { owner, name, cursor });
  
        const response = await axios.post(
          GITHUB_GRAPHQL_URL,
          { query: PR_QUERY, variables: { owner, name, cursor } },
          { headers }
        );
  
        if (response.data.errors) {
          console.error('GraphQL Errors:', response.data.errors);
          throw new Error(`GraphQL Error: ${response.data.errors[0].message}`);
        }
  
        const data = response.data.data.repository;
        if (!data) throw new Error('Repository not found or access denied.');
  
        const pullRequests = data.pullRequests.edges
          .map((edge) => edge.node)
          .filter((pr) => pr.comments.edges.length > 0 || pr.reviews.edges.length > 0);
  
        prsData.push(...pullRequests);
  
        cursor = data.pullRequests.pageInfo.hasNextPage
          ? data.pullRequests.pageInfo.endCursor
          : null;
      } while (cursor);
  
      return prsData;
    } catch (error) {
      console.error('Error fetching PRs:', error.message);
      throw new Error(`Error fetching PRs: ${error.message}`);
    }
  };
  

const structurePRData = (pr) => {
  const comments = pr.comments.edges.map((comment) => ({
    body: comment.node.body,
    author: comment.node.author.login,
  }));

  const reviews = pr.reviews.edges.map((review) => ({
    state: review.node.state,
    body: review.node.body,
    author: review.node.author.login,
  }));

  const files = pr.files.edges.map((file) => ({
      path: file.node.path,
      additions: file.node.additions,
      deletions: file.node.deletions,
      changeType: file.node.changeType,
  }));

  return {
    title: pr.title,
    description: pr.body,
    comments,
    reviews,
    files,
  };
};

app.post('/fetch-prs', async (req, res) => {
  const { repoUrl, token } = req.body;

  if (!repoUrl) {
    return res.status(400).json({ error: 'Repository URL is required' });
  }

  try {
    const { owner, name } = parseRepoUrl(repoUrl);
    const prs = await fetchPRs(owner, name, token);
    const structuredPRs = prs.map(structurePRData);

    const fileName = `${owner}-${name}-prs.json`;
    const dirPath = path.join(__dirname, 'fetched-prs');
    const filePath = path.join(dirPath, fileName);

    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath);
    fs.writeFileSync(filePath, JSON.stringify(structuredPRs, null, 2));

    return res.json({ message: 'PRs fetched successfully', filePath });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

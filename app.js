const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(bodyParser.json());

// Helper function to parse the GitHub repository URL into owner and repo name
function parseRepoUrl(repoUrl) {
  const regex = /https:\/\/github\.com\/([^\/]+)\/([^\/]+)/;
  const match = repoUrl.match(regex);

  if (!match) {
    throw new Error('Invalid repository URL');
  }

  return {
    owner: match[1],
    name: match[2],
  };
}

// Function to fetch data from the GitHub GraphQL API
async function fetchPRsWithGraphQL(owner, repo, token) {
  const graphqlUrl = 'https://api.github.com/graphql';
  const query = `
    query {
      repository(owner: "${owner}", name: "${repo}") {
        pullRequests(first: 100) {
          edges {
            node {
              number
              title
              createdAt
              author {
                login
              }
              comments {
                totalCount
              }
              reviews {
                totalCount
              }
            }
          }
        }
      }
    }
  `;

  try {
    const response = await axios.post(
      graphqlUrl,
      { query },
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );
    return response.data.data.repository.pullRequests.edges;
  } catch (error) {
    console.error('Error fetching PRs with GraphQL:', error.response?.data || error.message);
    return [];
  }
}

// Function to fetch and validate PR data from the REST API
async function getPRData(owner, repo, prNumber, token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
  };

  try {
    const [prDetails, prComments, prReviews] = await Promise.all([
      axios.get(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, { headers }),
      axios.get(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`, { headers }),
      axios.get(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, { headers }),
    ]);

    const { title, body: description } = prDetails.data;
    const comments = prComments.data.map(comment => ({
      body: comment.body,
      author: comment.user.login,
    }));
    const reviews = prReviews.data.map(review => ({
      body: review.body,
      state: review.state,
      author: review.user.login,
    }));

    if (!title || !description || (comments.length === 0 && reviews.length === 0)) {
      return null; // Skip if not qualified
    }

    const prFilesResponse = await axios.get(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files`, { headers });
    const files = prFilesResponse.data.map(file => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      patch: file.patch,
    }));

    return {
      title,
      description,
      files,
      comments,
      reviews,
    };
  } catch (error) {
    console.error(`Error fetching PR #${prNumber}:`, error.response?.data || error.message);
    return null;
  }
}

// Function to collect filtered PRs and fetch their details
async function collectFilteredPRs(owner, repo, token) {
  try {
    // Step 1: Use GraphQL to filter PRs
    const prEdges = await fetchPRsWithGraphQL(owner, repo, token);

    const qualityPRs = [];
    // Step 2: Fetch detailed data for each PR using REST API
    for (const prEdge of prEdges) {
      const prData = await getPRData(owner, repo, prEdge.node.number, token);
      if (prData) {
        qualityPRs.push(prData);
      }
    }

    return qualityPRs;
  } catch (error) {
    console.error('Error collecting PRs:', error.response?.data || error.message);
    return [];
  }
}

// Express endpoint to fetch PR data
app.post('/fetch-prs', async (req, res) => {
  const { repoUrl, token } = req.body;

  if (!repoUrl || !token) {
    return res.status(400).json({ error: 'Repository URL and Token are required' });
  }

  try {
    const { owner, name } = parseRepoUrl(repoUrl);
    const prs = await collectFilteredPRs(owner, name, token);

    // Save data to a JSON file (optional)
    const fileName = `${owner}-${name}-prs.json`;
    const dirPath = path.join(__dirname, 'fetched-prs');
    const filePath = path.join(dirPath, fileName);

    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath);
    fs.writeFileSync(filePath, JSON.stringify(prs, null, 2));

    return res.json({ message: 'PRs fetched successfully', filePath, prs });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
});

const PORT = 4000;
app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

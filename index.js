const express = require('express');
const axios = require('axios');
const bodyParser = require('body-parser');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(bodyParser.json());

// Function to parse repository URL to get owner and repo name
const parseRepoUrl = (url) => {
  const regex = /(?:https?:\/\/github\.com\/)?([^/]+)\/([^/]+)/;
  const match = url.match(regex);
  if (!match) throw new Error('Invalid repository URL');
  return { owner: match[1], name: match[2] };
};

// Function to fetch and validate PR data
async function getPRData(owner, repo, prNumber, token) {
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github.v3+json',
  };

  try {
    // Fetch PR details, comments, and reviews
    const [prDetails, prComments, prReviews] = await Promise.all([
      axios.get(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, { headers }),
      axios.get(`https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`, { headers }),
      axios.get(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, { headers }),
    ]);

    const { title, body: description } = prDetails.data;

    // Extract and filter comments and reviews
    const comments = prComments.data.map(comment => ({
      body: comment.body,
      author: comment.user.login,
    }));
    const reviews = prReviews.data.map(review => ({
      body: review.body,
      state: review.state,
      author: review.user.login,
    }));

    // Check if PR meets the quality criteria
    if (!title || !description || (comments.length === 0 && reviews.length === 0)) {
      return null; // Skip if not qualified
    }

    // Fetch PR files only if comments/reviews are qualified
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

// Function to collect all PRs and return filtered PRs
async function collectFilteredPRs(owner, repo, token) {
  try {
    const prsResponse = await axios.get(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.v3+json',
      },
      params: { state: 'all', per_page: 100 },
    });

    const prs = prsResponse.data.map(pr => pr.number);

    const qualityPRs = [];
    for (const prNumber of prs) {
      const prData = await getPRData(owner, repo, prNumber, token);
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

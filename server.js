const express = require('express');
const path = require('path');
const { createCanvas, registerFont } = require('canvas');
const { Octokit } = require('octokit');
const fs = require('fs').promises;

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'article-generator-cursor')));

// Ensure root path serves index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'article-generator-cursor', 'index.html'));
});

// API endpoint for article generation
app.post('/api/generate', async (req, res) => {
  try {
    const { model, prompt, affiliateLinks, tone, tags, numArticles, openaiKey, githubToken, repo, branch } = req.body;
    
    const octokit = new Octokit({ auth: githubToken });
    const [owner, repoName] = repo.split('/');
    
    // Get current tree SHA
    const { data: ref } = await octokit.rest.git.getRef({
      owner,
      repo: repoName,
      ref: `heads/${branch}`
    });
    
    const baseTreeSha = ref.object.sha;
    
    for (let i = 1; i <= numArticles; i++) {
      // Generate article
      const article = await generateArticle(model, prompt, affiliateLinks, tone, tags, openaiKey);
      
      // Generate cover image
      const coverImage = await generateCoverImage(article.title, tags);
      
      // Create unique filename
      const today = new Date().toISOString().slice(0, 10);
      const uniqueId = Math.random().toString(36).substr(2, 6);
      const articleFilename = `article-${today}-${uniqueId}.md`;
      const imageFilename = `article-${today}-${uniqueId}.png`;
      
      // Update article frontmatter with cover image
      const updatedArticle = updateArticleFrontmatter(article.content, imageFilename);
      
      // Upload to GitHub
      await uploadToGitHub(octokit, owner, repoName, branch, baseTreeSha, {
        article: {
          path: `src/content/blog/${articleFilename}`,
          content: updatedArticle
        },
        image: {
          path: `public/covers/${imageFilename}`,
          content: coverImage
        }
      });
    }
    
    res.json({ success: true, message: `Generated ${numArticles} article(s) successfully` });
  } catch (error) {
    console.error('Generation error:', error);
    res.status(500).json({ error: error.message });
  }
});

async function generateArticle(model, prompt, affiliateLinks, tone, tags, openaiKey) {
  const today = new Date().toISOString().slice(0, 10);
  const systemPrompt = `You are an expert article writer. Write a high-quality article in Markdown with YAML frontmatter. Structure:
---
title: <title>
description: <description>
tags: [${tags.join(', ')}]
cover: <cover image url or leave blank>
date: ${today}
---

# <title>

<description>

<markdown content>

Do not include repeated 'Title:' or 'Summary:' in the content. Do not use bold markers (**).`;

  let affiliateSection = '';
  if (affiliateLinks.length > 0) {
    affiliateSection = '\n\n## Affiliate Links\n' + affiliateLinks.map(l => `- ${l}`).join('\n');
  }
  const userPrompt = `${prompt}\n\nTone: ${tone}.${affiliateSection}`;

  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${openaiKey}`
    },
    body: JSON.stringify({
      model: model === 'gpt-4' ? 'gpt-4' : 'gpt-3.5-turbo',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      max_tokens: 2048,
      temperature: 0.7
    })
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.statusText}`);
  }

  const result = await response.json();
  let content = result.choices?.[0]?.message?.content || '';
  
  // Extract title from frontmatter
  const titleMatch = content.match(/title:\s*(.+)/i);
  const title = titleMatch ? titleMatch[1].trim() : 'Article';
  
  // Clean up content
  content = content.replace(/^(#+\s*)?(Title|Summary):.*$/gim, '');
  content = content.replace(/\*\*(.*?)\*\*/g, '$1');
  content = content.replace(/\n{3,}/g, '\n\n');
  
  return { title, content: content.trim() };
}

async function generateCoverImage(title, tags) {
  // Get emojis from GPT
  const emojiPrompt = `Suggest 2-4 relevant emojis for an article titled "${title}" with tags: ${tags.join(', ')}. Return only the emojis, no text.`;
  
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-3.5-turbo',
      messages: [{ role: 'user', content: emojiPrompt }],
      max_tokens: 50,
      temperature: 0.7
    })
  });

  const result = await response.json();
  const emojis = result.choices?.[0]?.message?.content?.trim() || '📝📄';

  // Create canvas
  const canvas = createCanvas(1200, 630);
  const ctx = canvas.getContext('2d');

  // Black background
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 1200, 630);

  // Title
  ctx.fillStyle = '#FFFFFF';
  ctx.font = 'bold 48px Arial';
  ctx.textAlign = 'center';
  
  // Wrap title text
  const words = title.split(' ');
  let lines = [];
  let currentLine = words[0];
  
  for (let i = 1; i < words.length; i++) {
    const testLine = currentLine + ' ' + words[i];
    const metrics = ctx.measureText(testLine);
    if (metrics.width > 1000) {
      lines.push(currentLine);
      currentLine = words[i];
    } else {
      currentLine = testLine;
    }
  }
  lines.push(currentLine);

  // Draw title lines
  lines.forEach((line, index) => {
    ctx.fillText(line, 600, 150 + (index * 60));
  });

  // Emojis
  ctx.font = '120px Arial';
  ctx.fillText(emojis, 600, 400);

  return canvas.toBuffer('image/png');
}

function updateArticleFrontmatter(content, imageFilename) {
  return content.replace(/cover:\s*.*/g, `cover: /covers/${imageFilename}`);
}

async function uploadToGitHub(octokit, owner, repo, branch, baseTreeSha, files) {
  const tree = [];
  
  for (const [type, file] of Object.entries(files)) {
    const content = type === 'image' ? file.content.toString('base64') : Buffer.from(file.content).toString('base64');
    
    tree.push({
      path: file.path,
      mode: '100644',
      type: 'blob',
      content: content
    });
  }

  // Create tree
  const { data: treeData } = await octokit.rest.git.createTree({
    owner,
    repo,
    tree,
    base_tree: baseTreeSha
  });

  // Create commit
  const { data: commitData } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: `Add generated article and cover image`,
    tree: treeData.sha,
    parents: [baseTreeSha]
  });

  // Update branch
  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: commitData.sha
  });
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 
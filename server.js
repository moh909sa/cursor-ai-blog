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
  const systemPrompt = `You are an expert article writer. Write a high-quality article in Markdown with proper YAML frontmatter for Astro. 

Structure the frontmatter exactly like this:
---
title: "Your Article Title"
description: "A brief description of the article"
date: ${today}
tags: [${tags.map(t => `"${t.trim()}"`).join(', ')}]
cover: "/covers/image-name.png"
---

# Your Article Title

Your article content here...

Important:
- Use proper YAML syntax with quotes around strings
- Do not include "Title:" or "Summary:" in the body content
- Do not use bold markers (**)
- Make sure the title in the frontmatter matches the H1 title in the body
- Keep the description concise and engaging
- Write a compelling first paragraph that can serve as the description`;

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
  
  // Extract title from frontmatter for cover image generation
  const titleMatch = content.match(/title:\s*["']([^"']+)["']/i);
  const title = titleMatch ? titleMatch[1].trim() : 'Article';
  
  // Clean up content - remove any extra Title/Summary lines
  content = content.replace(/^(#+\s*)?(Title|Summary):.*$/gim, '');
  content = content.replace(/\*\*(.*?)\*\*/g, '$1');
  content = content.replace(/\n{3,}/g, '\n\n');
  
  // Ensure proper YAML frontmatter format with emoji suggestions
  content = fixFrontmatterFormat(content, today, tags, prompt);
  
  return { title, content: content.trim() };
}

function fixFrontmatterFormat(content, date, tags, prompt) {
  // Split content into frontmatter and body
  const parts = content.split('---');
  let title = '';
  let description = '';
  let cover = '';
  let body = '';

  if (parts.length >= 3) {
    // Parse frontmatter
    const frontmatter = parts[1].trim();
    body = parts.slice(2).join('---').trim();

    // Extract fields
    for (const line of frontmatter.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('title:')) {
        title = extractTitleFromLine(line);
      } else if (trimmed.startsWith('description:')) {
        description = extractValueFromLine(line);
      } else if (trimmed.startsWith('cover:')) {
        cover = extractValueFromLine(line);
      }
    }
  } else {
    // No frontmatter, try to extract from body
    body = parts.join('---').trim();
  }

  // Fallbacks if missing
  if (!title) title = extractTitleFromBody(body);
  if (!description) description = extractDescriptionFromBody(body);
  if (!cover) cover = '';

  // Add emoji to title based on topic
  title = addEmojiToTitle(title, tags, prompt);

  // Clean up body: remove any Title: or Summary: lines
  body = body.replace(/^(#+\s*)?(Title|Summary):.*$/gim, '');
  body = body.replace(/\*\*(.*?)\*\*/g, '$1');
  body = body.replace(/\n{3,}/g, '\n\n');
  body = body.trim();

  // Ensure body starts with H1 title
  if (!body.startsWith('# ')) {
    body = `# ${title}\n\n${body}`;
  }

  // Compose valid YAML frontmatter
  const yaml = [
    '---',
    `title: "${escapeYamlString(title)}"`,
    `description: "${escapeYamlString(description)}"`,
    `date: ${date}`,
    `tags: [${tags.map(t => `"${escapeYamlString(t.trim())}"`).join(', ')}]`,
    `cover: "${cover}"`,
    '---',
    ''
  ].join('\n');

  return `${yaml}${body}`;
}

function addEmojiToTitle(title, tags, prompt) {
  const emojiMap = {
    'ai': '🤖',
    'artificial intelligence': '🤖',
    'machine learning': '🧠',
    'tech': '💻',
    'technology': '💻',
    'programming': '⚡',
    'coding': '⚡',
    'web': '🌐',
    'design': '🎨',
    'writing': '✍️',
    'blog': '📝',
    'marketing': '📈',
    'business': '💼',
    'finance': '💰',
    'health': '🏥',
    'fitness': '💪',
    'food': '🍽️',
    'travel': '✈️',
    'music': '🎵',
    'gaming': '🎮',
    'sports': '⚽',
    'education': '📚',
    'science': '🔬',
    'space': '🚀',
    'environment': '🌱',
    'sustainability': '🌱'
  };

  // Check tags first
  for (const tag of tags) {
    const lowerTag = tag.toLowerCase();
    if (emojiMap[lowerTag]) {
      return `${emojiMap[lowerTag]} ${title}`;
    }
  }

  // Check prompt content
  const lowerPrompt = prompt.toLowerCase();
  for (const [keyword, emoji] of Object.entries(emojiMap)) {
    if (lowerPrompt.includes(keyword)) {
      return `${emoji} ${title}`;
    }
  }

  // Default emoji based on common patterns
  if (lowerPrompt.includes('ai') || lowerPrompt.includes('artificial intelligence')) {
    return `🤖 ${title}`;
  } else if (lowerPrompt.includes('tech') || lowerPrompt.includes('programming')) {
    return `💻 ${title}`;
  } else if (lowerPrompt.includes('writing') || lowerPrompt.includes('blog')) {
    return `✍️ ${title}`;
  }

  // Fallback emoji
  return `📝 ${title}`;
}

function escapeYamlString(str) {
  if (!str) return '';
  return str.replace(/"/g, '\\"').replace(/\n/g, ' ').trim();
}

function extractTitleFromLine(line) {
  const match = line.match(/title:\s*["']?([^"'\n]+)["']?/i);
  return match ? match[1].trim() : '';
}

function extractValueFromLine(line) {
  const match = line.match(/:\s*["']?([^"'\n]+)["']?/i);
  return match ? match[1].trim() : '';
}

function extractTitleFromBody(body) {
  const h1Match = body.match(/^#\s+(.+)$/m);
  if (h1Match) return h1Match[1].trim();
  // Fallback: first non-empty line
  const firstLine = body.split('\n').find(l => l.trim());
  return firstLine ? firstLine.trim().replace(/^#+\s*/, '') : 'Untitled Article';
}

function extractDescriptionFromBody(body) {
  // Try to find the first paragraph after the H1
  const lines = body.split('\n');
  let foundH1 = false;
  let description = '';
  
  for (const line of lines) {
    if (!foundH1 && /^#\s+/.test(line)) {
      foundH1 = true;
      continue;
    }
    if (foundH1 && line.trim() && !line.startsWith('#')) {
      // Return the first non-empty, non-heading line after H1
      description = line.trim();
      break;
    }
  }
  
  // If no description found, create one from the title
  if (!description) {
    const title = extractTitleFromBody(body);
    description = `Learn more about ${title.toLowerCase()}.`;
  }
  
  return description;
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
  return content.replace(/cover:\s*.*/g, `cover: "/covers/${imageFilename}"`);
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
}); 
const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from the article-generator-cursor directory
app.use(express.static(path.join(__dirname, 'article-generator-cursor')));

// Ensure root path serves index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'article-generator-cursor', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 
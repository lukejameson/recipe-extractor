const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const session = require('express-session');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const PASSWORD = process.env.APP_PASSWORD || 'recipe123';
const SAVE_PATH = process.env.SAVE_PATH || './recipes';
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(64).toString('hex');
const API_TOKEN =
  process.env.API_TOKEN || crypto.randomBytes(32).toString('hex');

// Ensure save directory exists
async function ensureSaveDirectory() {
  try {
    await fs.mkdir(SAVE_PATH, { recursive: true });
  } catch (error) {
    console.error('Error creating save directory:', error);
  }
}

ensureSaveDirectory();

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: false, // Set to true if using HTTPS
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000, // 24 hours
    },
  })
);

// Serve static files but exclude index.html
app.use(
  express.static('public', {
    index: false,
    extensions: ['html'],
    redirect: false,
    setHeaders: (res, path) => {
      // Prevent direct access to index.html
      if (path.endsWith('index.html')) {
        res.status(403).end();
      }
    },
  })
);

// Authentication middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  } else {
    res.redirect('/login');
  }
}

// Routes
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const { password } = req.body;

  if (password === PASSWORD) {
    req.session.authenticated = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Invalid password' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(err => {
    res.redirect('/login');
  });
});

app.post('/extract', requireAuth, async (req, res) => {
  const { url, useAdvanced } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: 'URL is required' });
  }

  // Validate URL
  try {
    new URL(url);
  } catch (error) {
    return res
      .status(400)
      .json({ success: false, error: 'Invalid URL provided' });
  }

  const script = useAdvanced
    ? 'extract-recipe-advanced.js'
    : 'extract-recipe.js';

  // Create a temporary directory for the extraction
  const tempDir = path.join(__dirname, 'temp', Date.now().toString());

  try {
    await fs.mkdir(tempDir, { recursive: true });

    // Execute the extraction script
    exec(
      `cd "${tempDir}" && node "${path.join(__dirname, script)}" "${url}"`,
      async (error, stdout, stderr) => {
        if (error) {
          console.error('Extraction error:', error);
          console.error('stderr:', stderr);

          // Clean up temp directory
          try {
            await fs.rmdir(tempDir, { recursive: true });
          } catch (e) {}

          return res.status(500).json({
            success: false,
            error: 'Failed to extract recipe',
            details: stderr || error.message,
          });
        }

        try {
          // Find the created markdown file
          const files = await fs.readdir(tempDir);
          const mdFile = files.find(file => file.endsWith('.md'));

          if (!mdFile) {
            throw new Error('No recipe file was created');
          }

          // Read the content
          const content = await fs.readFile(path.join(tempDir, mdFile), 'utf8');

          // Copy to save directory
          const finalPath = path.join(SAVE_PATH, mdFile);
          await fs.copyFile(path.join(tempDir, mdFile), finalPath);

          // Extract recipe data from content
          const titleMatch = content.match(/title:\s*'([^']+)'/);
          const title = titleMatch ? titleMatch[1] : 'Untitled Recipe';

          // Clean up temp directory
          await fs.rmdir(tempDir, { recursive: true });

          res.json({
            success: true,
            filename: mdFile,
            title: title,
            content: content,
            savedTo: finalPath,
          });
        } catch (err) {
          console.error('Post-processing error:', err);

          // Clean up temp directory
          try {
            await fs.rmdir(tempDir, { recursive: true });
          } catch (e) {}

          res.status(500).json({
            success: false,
            error: 'Failed to process extracted recipe',
            details: err.message,
          });
        }
      }
    );
  } catch (err) {
    console.error('Setup error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to set up extraction',
      details: err.message,
    });
  }
});

app.get('/recipes', requireAuth, async (req, res) => {
  try {
    const files = await fs.readdir(SAVE_PATH);
    const recipes = files.filter(file => file.endsWith('.md'));

    const recipeList = await Promise.all(
      recipes.map(async filename => {
        try {
          const content = await fs.readFile(
            path.join(SAVE_PATH, filename),
            'utf8'
          );
          const titleMatch = content.match(/title:\s*'([^']+)'/);
          const dateMatch = content.match(/date:\s*(\d{4}-\d{2}-\d{2})/);

          return {
            filename,
            title: titleMatch ? titleMatch[1] : filename.replace('.md', ''),
            date: dateMatch ? dateMatch[1] : null,
          };
        } catch (err) {
          return {
            filename,
            title: filename.replace('.md', ''),
            date: null,
            error: true,
          };
        }
      })
    );

    res.json({ success: true, recipes: recipeList });
  } catch (err) {
    res.status(500).json({ success: false, error: 'Failed to list recipes' });
  }
});

app.get('/recipe/:filename', requireAuth, async (req, res) => {
  const { filename } = req.params;

  // Ensure filename ends with .md and doesn't contain path traversal
  if (
    !filename.endsWith('.md') ||
    filename.includes('..') ||
    filename.includes('/')
  ) {
    return res.status(400).json({ success: false, error: 'Invalid filename' });
  }

  try {
    const content = await fs.readFile(path.join(SAVE_PATH, filename), 'utf8');
    res.json({ success: true, content });
  } catch (err) {
    res.status(404).json({ success: false, error: 'Recipe not found' });
  }
});

// API endpoint for iOS Shortcuts and external integrations
app.post('/api/extract', async (req, res) => {
  // Check for API token in Authorization header
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token || token !== API_TOKEN) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }

  const { url, useAdvanced = true, returnContent = false } = req.body;

  if (!url) {
    return res.status(400).json({ success: false, error: 'URL is required' });
  }

  // Validate URL
  try {
    new URL(url);
  } catch (error) {
    return res
      .status(400)
      .json({ success: false, error: 'Invalid URL provided' });
  }

  const script = useAdvanced
    ? 'extract-recipe-advanced.js'
    : 'extract-recipe.js';

  // Create a temporary directory for the extraction
  const tempDir = path.join(__dirname, 'temp', Date.now().toString());

  try {
    await fs.mkdir(tempDir, { recursive: true });

    // Execute the extraction script
    exec(
      `cd "${tempDir}" && node "${path.join(__dirname, script)}" "${url}"`,
      async (error, stdout, stderr) => {
        if (error) {
          console.error('API Extraction error:', error);
          console.error('stderr:', stderr);

          // Clean up temp directory
          try {
            await fs.rmdir(tempDir, { recursive: true });
          } catch (e) {}

          return res.status(500).json({
            success: false,
            error: 'Failed to extract recipe',
            details: stderr || error.message,
          });
        }

        try {
          // Find the created markdown file
          const files = await fs.readdir(tempDir);
          const mdFile = files.find(file => file.endsWith('.md'));

          if (!mdFile) {
            throw new Error('No recipe file was created');
          }

          // Read the content
          const content = await fs.readFile(path.join(tempDir, mdFile), 'utf8');

          // Copy to save directory
          const finalPath = path.join(SAVE_PATH, mdFile);
          await fs.copyFile(path.join(tempDir, mdFile), finalPath);

          // Extract recipe data from content
          const titleMatch = content.match(/title:\s*'([^']+)'/);
          const title = titleMatch ? titleMatch[1] : 'Untitled Recipe';

          // Clean up temp directory
          await fs.rmdir(tempDir, { recursive: true });

          // Prepare response
          const response = {
            success: true,
            filename: mdFile,
            title: title,
            savedTo: finalPath,
          };

          // Include content if requested (useful for iOS Shortcuts)
          if (returnContent) {
            response.content = content;
          }

          res.json(response);
        } catch (err) {
          console.error('API Post-processing error:', err);

          // Clean up temp directory
          try {
            await fs.rmdir(tempDir, { recursive: true });
          } catch (e) {}

          res.status(500).json({
            success: false,
            error: 'Failed to process extracted recipe',
            details: err.message,
          });
        }
      }
    );
  } catch (err) {
    console.error('API Setup error:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to set up extraction',
      details: err.message,
    });
  }
});

// API endpoint to get the current API token (only for authenticated users)
app.get('/api/token', requireAuth, (req, res) => {
  res.json({ token: API_TOKEN });
});

// Catch all other routes and redirect to login if not authenticated
app.get('*', (req, res) => {
  if (req.session && req.session.authenticated) {
    res.redirect('/');
  } else {
    res.redirect('/login');
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`Recipe Extractor server running on port ${PORT}`);
  console.log(`Save path: ${SAVE_PATH}`);
  console.log(
    `Password protection: ${
      PASSWORD ? 'Enabled' : 'Disabled (set APP_PASSWORD)'
    }`
  );
  console.log(`API Token: ${API_TOKEN}`);
  console.log(`\nAPI Endpoint: POST /api/extract`);
  console.log(`Authorization: Bearer ${API_TOKEN}`);
});

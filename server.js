const express = require('express');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const session = require('express-session');
const bodyParser = require('body-parser');
const crypto = require('crypto');
let marked;
async function getMarked() {
  if (!marked) {
    marked = (await import('marked')).marked || (await import('marked'));
  }
  return marked;
}
const RecipeDatabase = require('./database');

const app = express();
const PORT = process.env.PORT || 5120;
const PASSWORD = process.env.APP_PASSWORD || 'recipe123';
const SAVE_PATH = process.env.SAVE_PATH || './recipes';
const DB_PATH = process.env.DB_PATH || './recipes.db';
const SESSION_SECRET =
  process.env.SESSION_SECRET || crypto.randomBytes(64).toString('hex');
const API_TOKEN =
  process.env.API_TOKEN || crypto.randomBytes(32).toString('hex');

// Initialize database
const db = new RecipeDatabase(DB_PATH);

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

// API routes must be registered BEFORE static to avoid static handler intercepting them
// (Moved API route for deleting markdown below; keeping static config unchanged)

/**
 * PWA assets:
 * - Serve static files (unchanged behavior)
 * - Add simple in-memory manifest and service worker for app-shell caching
 */
// Serve static files but exclude index.html
app.use(
  express.static('public', {
    index: false,
    extensions: ['html'],
    redirect: false,
    setHeaders: (res, filePath) => {
      // Prevent direct access to index.html
      if (filePath.endsWith('index.html')) {
        res.status(403).end();
      }
    },
  })
);

// Minimal manifest served from memory (simplest working PWA)
app.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').send(
    JSON.stringify(
      {
        name: 'JustTheRecipe',
        short_name: 'Recipes',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        theme_color: '#0b0b0f',
        background_color: '#0b0b0f',
        icons: [
          {
            src: '/icon-192.png',
            sizes: '192x192',
            type: 'image/png',
          },
          {
            src: '/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
          },
          {
            src: '/icon-maskable-192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'maskable',
          },
          {
            src: '/icon-maskable-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          }
        ],
      },
      null,
      2
    )
  );
});

// Minimal service worker (app shell + static assets). Cached in-memory string.
const swSource = `
// Simple app-shell cache
const CACHE_NAME = 'jtr-cache-v1';
const APP_SHELL = [
  '/',
  '/viewer.html',
  '/login.html',
  '/styles.css'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// Network-first for HTML pages, cache-first for other assets
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const isHTML = request.headers.get('accept')?.includes('text/html');

  if (isHTML) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((r) => r || caches.match('/viewer.html')))
    );
  } else {
    event.respondWith(
      caches.match(request).then((cached) => {
        return (
          cached ||
          fetch(request)
            .then((response) => {
              const copy = response.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
              return response;
            })
            .catch(() => cached)
        );
      })
    );
  }
});
`.trim();

app.get('/sw.js', (req, res) => {
  res.type('application/javascript').send(swSource);
});

// Authentication middleware
function requireAuth(req, res, next) {
  if (req.session && req.session.authenticated) {
    return next();
  } else {
    // For API routes, return JSON error instead of redirecting
    if (req.path.startsWith('/api/')) {
      res.status(401).json({ success: false, error: 'Unauthorized' });
    } else {
      res.redirect('/login');
    }
  }
}

// Routes
app.get('/', requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'viewer.html'));
});

app.get('/extractor', requireAuth, (req, res) => {
  // SPA redirect to Extract section
  res.redirect('/?#/extract');
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

          // Parse recipe data for database
          const cuisineMatch = content.match(/cuisine:\s*(.*)/);
          const courseMatch = content.match(/course:\s*(.*)/);
          const servingsMatch = content.match(/servings:\s*(.*)/);
          const prepTimeMatch = content.match(/prep_time:\s*(.*)/);
          const cookTimeMatch = content.match(/cook_time:\s*(.*)/);

          // Extract ingredients from content section
          const ingredientsSectionMatch = content.match(
            /## Ingredients\s*\n((?:.*\n)*?)(?=##|$)/
          );
          const fullIngredients = [];
          if (ingredientsSectionMatch) {
            fullIngredients.push(
              ...ingredientsSectionMatch[1]
                .split('\n')
                .filter(line => line.trim() && line.trim().startsWith('-'))
                .map(line => line.replace(/^\s*-\s*/, '').trim())
            );
          }

          // Extract instructions
          const instructionsMatch = content.match(
            /## Directions\s*\n((?:.*\n)*?)(?=##|$)/
          );
          const instructions = [];
          if (instructionsMatch) {
            instructions.push(
              ...instructionsMatch[1]
                .split('\n')
                .filter(line => line.trim() && line.match(/^\d+\./))
                .map(line => line.trim())
            );
          }

          // Extract source URL from notes
          const sourceMatch = content.match(/Source:\s*(https?:\/\/[^\s]+)/);

          const recipeData = {
            title: title,
            cuisine: cuisineMatch ? cuisineMatch[1].trim() : null,
            course: courseMatch ? courseMatch[1].trim() : null,
            servings: servingsMatch ? servingsMatch[1].trim() : null,
            prepTime: prepTimeMatch ? prepTimeMatch[1].trim() : null,
            cookTime: cookTimeMatch ? cookTimeMatch[1].trim() : null,
            sourceUrl: url,
            ingredients: fullIngredients,
            instructions: instructions,
          };

          // Save to database
          try {
            await db.saveRecipe(recipeData, content);
          } catch (dbError) {
            console.error('Failed to save to database:', dbError);
            // Continue even if database save fails
          }

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

/**
 * Delete a saved markdown file (keep DB separate)
 * Accept both /api/markdown/:filename and /api/markdown/* to be safe with special chars.
 * Place BEFORE static handler would be ideal, but this server registers static early; to be robust,
 * register both route signatures and ensure they are matched.
 */
const deleteMarkdownHandler = async (req, res) => {
  const raw = req.params.filename || req.params[0] || '';
  const filename = decodeURIComponent(raw);

  // Basic validation to prevent path traversal and require .md
  if (
    !filename.endsWith('.md') ||
    filename.includes('..') ||
    filename.includes('/') ||
    filename.includes('\\')
  ) {
    return res.status(400).json({ success: false, error: 'Invalid filename' });
  }

  const filePath = path.join(SAVE_PATH, filename);
  try {
    await fs.access(filePath);
  } catch {
    return res
      .status(404)
      .json({ success: false, error: 'Markdown file not found' });
  }

  try {
    await fs.unlink(filePath);
    return res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete markdown file:', err);
    return res
      .status(500)
      .json({ success: false, error: 'Failed to delete markdown file' });
  }
};

app.delete('/api/markdown/:filename', requireAuth, deleteMarkdownHandler);
app.delete('/api/markdown/*', requireAuth, deleteMarkdownHandler);

// Database API endpoints
app.get('/api/recipes', requireAuth, (req, res) => {
  try {
    const recipes = db.getAllRecipes();
    res.json({ success: true, recipes });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Create a recipe manually from form data
 * Expects JSON body:
 * {
 *   title: string,
 *   cuisine?: string,
 *   course?: string,
 *   servings?: string,
 *   prep_time?: string,
 *   cook_time?: string,
 *   category_id?: number|null,
 *   tags?: string, // comma-separated
 *   source_url?: string,
 *   ingredients: [{ original_text: string, display_text?: string }],
 *   instructions: [{ instruction: string }],
 *   date?: string (ISO yyyy-mm-dd)
 * }
 */
app.post('/api/recipes', requireAuth, async (req, res) => {
  try {
    const {
      title,
      cuisine,
      course,
      servings,
      prep_time,
      cook_time,
      category_id,
      tags,
      source_url,
      ingredients = [],
      instructions = [],
      date,
    } = req.body || {};

    if (!title || typeof title !== 'string' || title.trim().length === 0) {
      return res
        .status(400)
        .json({ success: false, error: 'Title is required' });
    }

    // Build a markdown content similar to extractor output so export is consistent
    const today =
      date && typeof date === 'string'
        ? date
        : new Date().toISOString().split('T')[0];
    const frontmatterLines = [
      '---',
      `title: '${title.replace(/'/g, '’')}'`,
      `date: ${today}`,
      `cuisine: ${cuisine || ''}`,
      `course: ${course || ''}`,
      `servings: ${servings || ''}`,
      `prep_time: ${prep_time || ''}`,
      `cook_time: ${cook_time || ''}`,
      'tags:',
      '  - recipe',
    ];

    // Add ingredient names to frontmatter ingredients list (names only)
    const displayIngredients = (ingredients || [])
      .map(i => (i.display_text || i.original_text || '').trim())
      .filter(Boolean);
    const ingredientNames = displayIngredients
      .map(line => {
        // crude name extraction for frontmatter tag; database will handle proper parsing for scaling
        return line
          .replace(/^[\d\s\/\-\.]+/, '')
          .replace(/\([^)]*\)/g, '')
          .replace(/,.*$/, '')
          .replace(
            /^(cup|cups|tablespoon|tablespoons|tbsp|tbs|teaspoon|teaspoons|tsp|pound|pounds|lb|lbs|ounce|ounces|oz|gram|grams|g|kilogram|kilograms|kg|liter|liters|l|milliliter|milliliters|ml|pint|pints|pt|quart|quarts|qt|gallon|gallons|gal|stick|sticks|piece|pieces|slice|slices|clove|cloves|bunch|bunches|package|packages|pkg|can|cans|jar|jars|bottle|bottles|bag|bags|box|boxes|container|containers|dash|dashes|pinch|pinches|handful|handfuls|sprig|sprigs)\s+/i,
            ''
          )
          .trim();
      })
      .filter(Boolean);

    const frontmatter = [
      ...frontmatterLines,
      'ingredients:',
      ...ingredientNames.map(n => `  - ${n}`),
      '---',
      '',
    ].join('\n');

    const body = [
      '## Ingredients',
      '',
      ...displayIngredients.map(line => `- ${line}`),
      '',
      '## Directions',
      '',
      ...(instructions || []).map(
        (inst, idx) =>
          `${idx + 1}. ${(inst.instruction || '')
            .replace(/^\d+\.\s*/, '')
            .trim()}`
      ),
      '',
      '## Notes',
      '',
      `Source: ${source_url || ''}`,
      '',
    ].join('\n');

    const markdownContent = frontmatter + body;

    // Map to saveRecipe expected structure
    const recipeDataForDb = {
      title: title,
      cuisine: cuisine || null,
      course: course || null,
      servings: servings || null,
      prepTime: prep_time || null,
      cookTime: cook_time || null,
      sourceUrl: source_url || null,
      ingredients: displayIngredients, // saveRecipe expects string[] of lines
      instructions: (instructions || [])
        .map(inst => (inst.instruction || '').trim())
        .filter(Boolean),
    };

    const recipeId = await db.saveRecipe(recipeDataForDb, markdownContent);

    // Apply category if provided
    if (category_id === null || typeof category_id === 'number') {
      db.updateRecipeCategory(recipeId, category_id || null);
    }

    // Apply tags if provided (comma-separated)
    if (tags && typeof tags === 'string') {
      tags
        .split(',')
        .map(t => t.trim())
        .filter(Boolean)
        .forEach(tag => {
          try {
            db.addTagToRecipe(recipeId, tag);
          } catch (e) {
            // ignore individual tag errors
          }
        });
    }

    // Return created recipe id
    res.json({ success: true, id: recipeId });
  } catch (error) {
    console.error('Error creating recipe:', error);
    res.status(500).json({ success: false, error: 'Failed to create recipe' });
  }
});

app.get('/api/recipe/:id', requireAuth, (req, res) => {
  try {
    const recipe = db.getRecipe(parseInt(req.params.id));
    if (!recipe) {
      return res
        .status(404)
        .json({ success: false, error: 'Recipe not found' });
    }
    res.json({ success: true, recipe });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Update an existing recipe
 * Expects JSON body similar to create:
 * {
 *   title?: string,
 *   cuisine?: string,
 *   course?: string,
 *   servings?: string,
 *   prep_time?: string,
 *   cook_time?: string,
 *   category_id?: number|null,
 *   tags?: string, // comma-separated
 *   source_url?: string,
 *   ingredients?: [{ original_text: string, display_text?: string }],
 *   instructions?: [{ instruction: string }]
 * }
 */
app.put('/api/recipe/:id', requireAuth, async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const {
      title,
      cuisine,
      course,
      servings,
      prep_time,
      cook_time,
      category_id,
      tags,
      source_url,
      ingredients,
      instructions,
    } = req.body || {};

    // Build update payload matching database.js expectations
    const updateData = {};

    if (typeof title === 'string') updateData.title = title;
    if (typeof cuisine === 'string' || cuisine === null)
      updateData.cuisine = cuisine || null;
    if (typeof course === 'string' || course === null)
      updateData.course = course || null;
    if (typeof servings === 'string' || servings === null)
      updateData.servings = servings || null;
    if (typeof prep_time === 'string' || prep_time === null)
      updateData.prepTime = prep_time || null;
    if (typeof cook_time === 'string' || cook_time === null)
      updateData.cookTime = cook_time || null;
    if (typeof source_url === 'string' || source_url === null)
      updateData.sourceUrl = source_url || null;

    // Normalize ingredients/instructions arrays for DB
    if (Array.isArray(ingredients)) {
      updateData.ingredients = ingredients
        .map(i => (i && (i.display_text || i.original_text || '')).trim())
        .filter(Boolean);
    }
    if (Array.isArray(instructions)) {
      updateData.instructions = instructions
        .map(i => (i && (i.instruction || '')).trim())
        .filter(Boolean);
    }

    // Perform update via DB
    // database.js should expose a method like updateRecipe(id, updateData)
    if (typeof db.updateRecipe === 'function') {
      db.updateRecipe(id, updateData);
    } else {
      // Fallback: apply granular setters if available
      if (updateData.title) db.updateRecipeTitle?.(id, updateData.title);
      if ('cuisine' in updateData) db.updateRecipeCuisine?.(id, updateData.cuisine);
      if ('course' in updateData) db.updateRecipeCourse?.(id, updateData.course);
      if ('servings' in updateData) db.updateRecipeServings?.(id, updateData.servings);
      if ('prepTime' in updateData) db.updateRecipePrepTime?.(id, updateData.prepTime);
      if ('cookTime' in updateData) db.updateRecipeCookTime?.(id, updateData.cookTime);
      if ('sourceUrl' in updateData) db.updateRecipeSourceUrl?.(id, updateData.sourceUrl);
      if ('ingredients' in updateData) db.replaceRecipeIngredients?.(id, updateData.ingredients);
      if ('instructions' in updateData) db.replaceRecipeInstructions?.(id, updateData.instructions);
    }

    // Category update if provided
    if (category_id === null || typeof category_id === 'number') {
      db.updateRecipeCategory(id, category_id || null);
    }

    // Replace tags if provided as a comma-separated string
    if (typeof tags === 'string') {
      const tagList = tags
        .split(',')
        .map(t => t.trim())
        .filter(Boolean);
      if (typeof db.replaceRecipeTags === 'function') {
        db.replaceRecipeTags(id, tagList);
      } else {
        // Fallback: naive replace by removing all and re-adding
        try {
          const recipe = db.getRecipe(id);
          if (recipe?.tags) {
            recipe.tags.forEach(tagObj => {
              try {
                db.removeTagFromRecipe(id, tagObj.id);
              } catch {}
            });
          }
        } catch {}
        tagList.forEach(tag => {
          try {
            db.addTagToRecipe(id, tag);
          } catch {}
        });
      }
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Error updating recipe:', error);
    return res
      .status(500)
      .json({ success: false, error: 'Failed to update recipe' });
  }
});

app.get('/api/recipe/:id/scale/:factor', requireAuth, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const factor = parseFloat(req.params.factor);

    if (isNaN(factor) || factor <= 0) {
      return res
        .status(400)
        .json({ success: false, error: 'Invalid scale factor' });
    }

    const scaledIngredients = db.scaleIngredients(id, factor);
    res.json({ success: true, ingredients: scaledIngredients });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get(
  '/api/recipe/:id/scale-to-servings/:servings',
  requireAuth,
  (req, res) => {
    try {
      const id = parseInt(req.params.id);
      const servings = parseFloat(req.params.servings);

      if (isNaN(servings) || servings <= 0) {
        return res
          .status(400)
          .json({ success: false, error: 'Invalid servings number' });
      }

      const result = db.scaleIngredientsToServings(id, servings);
      if (!result) {
        return res.status(400).json({
          success: false,
          error: 'Unable to scale recipe - servings not found',
        });
      }

      res.json({ success: true, ...result });
    } catch (error) {
      res.status(500).json({ success: false, error: error.message });
    }
  }
);

app.post('/api/recipe/:id/category', requireAuth, (req, res) => {
  try {
    const { categoryId } = req.body;
    db.updateRecipeCategory(parseInt(req.params.id), categoryId);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/recipe/:id/tags', requireAuth, (req, res) => {
  try {
    const { tag } = req.body;
    db.addTagToRecipe(parseInt(req.params.id), tag);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/recipe/:id/tags/:tagId', requireAuth, (req, res) => {
  try {
    db.removeTagFromRecipe(parseInt(req.params.id), parseInt(req.params.tagId));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/categories', requireAuth, (req, res) => {
  try {
    const categories = db.getAllCategories();
    res.json({ success: true, categories });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.post('/api/categories', requireAuth, (req, res) => {
  try {
    const { name, color } = req.body;
    db.createCategory(name, color);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/search', requireAuth, (req, res) => {
  try {
    const { q } = req.query;
    if (!q) {
      return res.status(400).json({ success: false, error: 'Query required' });
    }
    const recipes = db.searchRecipes(q);
    res.json({ success: true, recipes });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.get('/api/recipe/:id/export', requireAuth, async (req, res) => {
  try {
    // lazily load marked if needed later; db.exportToMarkdown already returns markdown string
    await getMarked().catch(() => {});
    const markdown = db.exportToMarkdown(parseInt(req.params.id));
    if (!markdown) {
      return res
        .status(404)
        .json({ success: false, error: 'Recipe not found' });
    }
    res.json({ success: true, markdown });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

app.delete('/api/recipe/:id', requireAuth, (req, res) => {
  try {
    db.deleteRecipe(parseInt(req.params.id));
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * Import a single markdown file into DB
 */
app.post('/api/import-markdown/:filename', requireAuth, async (req, res) => {
  const { filename } = req.params;

  if (
    !filename.endsWith('.md') ||
    filename.includes('..') ||
    filename.includes('/') ||
    filename.includes('\\')
  ) {
    return res.status(400).json({ success: false, error: 'Invalid filename' });
  }

  try {
    const filePath = path.join(SAVE_PATH, filename);
    const content = await fs.readFile(filePath, 'utf8');

    // Parse markdown content
    const titleMatch = content.match(/title:\s*'([^']+)'/);
    const cuisineMatch = content.match(/cuisine:\s*(.*)/);
    const courseMatch = content.match(/course:\s*(.*)/);
    const servingsMatch = content.match(/servings:\s*(.*)/);
    const prepTimeMatch = content.match(/prep_time:\s*(.*)/);
    const cookTimeMatch = content.match(/cook_time:\s*(.*)/);

    // Extract ingredients from frontmatter
    const ingredientsMatch = content.match(
      /ingredients:\s*\n((?:\s+-\s+.*\n?)*)/
    );
    const ingredientsList = [];
    if (ingredientsMatch) {
      ingredientsList.push(
        ...ingredientsMatch[1]
          .split('\n')
          .filter(line => line.trim().startsWith('-'))
          .map(line => line.replace(/^\s*-\s*/, '').trim())
      );
    }

    // Extract ingredients from content section
    const ingredientsSectionMatch = content.match(
      /## Ingredients\s*\n((?:.*\n)*?)(?=##|$)/
    );
    const fullIngredients = [];
    if (ingredientsSectionMatch) {
      fullIngredients.push(
        ...ingredientsSectionMatch[1]
          .split('\n')
          .filter(line => line.trim() && line.trim().startsWith('-'))
          .map(line => line.replace(/^\s*-\s*/, '').trim())
      );
    }

    // Extract instructions
    const instructionsMatch = content.match(
      /## Directions\s*\n((?:.*\n)*?)(?=##|$)/
    );
    const instructions = [];
    if (instructionsMatch) {
      instructions.push(
        ...instructionsMatch[1]
          .split('\n')
          .filter(line => line.trim() && line.match(/^\d+\./))
          .map(line => line.trim())
      );
    }

    // Extract source URL from notes
    const sourceMatch = content.match(/Source:\s*(https?:\/\/[^\s]+)/);

    const recipeData = {
      title: titleMatch ? titleMatch[1] : filename.replace('.md', ''),
      cuisine: cuisineMatch ? cuisineMatch[1].trim() : null,
      course: courseMatch ? courseMatch[1].trim() : null,
      servings: servingsMatch ? servingsMatch[1].trim() : null,
      prepTime: prepTimeMatch ? prepTimeMatch[1].trim() : null,
      cookTime: cookTimeMatch ? cookTimeMatch[1].trim() : null,
      sourceUrl: sourceMatch ? sourceMatch[1] : null,
      ingredients:
        fullIngredients.length > 0 ? fullIngredients : ingredientsList,
      instructions: instructions,
    };

    await db.saveRecipe(recipeData, content);
    return res.json({ success: true, imported: 1, total: 1 });
  } catch (error) {
    console.error(`Failed to import ${filename}:`, error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Bulk import existing markdown files to database (unchanged)
app.post('/api/import-markdown', requireAuth, async (req, res) => {
  try {
    const files = await fs.readdir(SAVE_PATH);
    const mdFiles = files.filter(file => file.endsWith('.md'));
    let imported = 0;

    for (const file of mdFiles) {
      try {
        const content = await fs.readFile(path.join(SAVE_PATH, file), 'utf8');

        // Parse markdown content
        const titleMatch = content.match(/title:\s*'([^']+)'/);
        const cuisineMatch = content.match(/cuisine:\s*(.*)/);
        const courseMatch = content.match(/course:\s*(.*)/);
        const servingsMatch = content.match(/servings:\s*(.*)/);
        const prepTimeMatch = content.match(/prep_time:\s*(.*)/);
        const cookTimeMatch = content.match(/cook_time:\s*(.*)/);

        // Extract ingredients from frontmatter
        const ingredientsMatch = content.match(
          /ingredients:\s*\n((?:\s+-\s+.*\n?)*)/
        );
        const ingredientsList = [];
        if (ingredientsMatch) {
          ingredientsList.push(
            ...ingredientsMatch[1]
              .split('\n')
              .filter(line => line.trim().startsWith('-'))
              .map(line => line.replace(/^\s*-\s*/, '').trim())
          );
        }

        // Extract ingredients from content section
        const ingredientsSectionMatch = content.match(
          /## Ingredients\s*\n((?:.*\n)*?)(?=##|$)/
        );
        const fullIngredients = [];
        if (ingredientsSectionMatch) {
          fullIngredients.push(
            ...ingredientsSectionMatch[1]
              .split('\n')
              .filter(line => line.trim() && line.trim().startsWith('-'))
              .map(line => line.replace(/^\s*-\s*/, '').trim())
          );
        }

        // Extract instructions
        const instructionsMatch = content.match(
          /## Directions\s*\n((?:.*\n)*?)(?=##|$)/
        );
        const instructions = [];
        if (instructionsMatch) {
          instructions.push(
            ...instructionsMatch[1]
              .split('\n')
              .filter(line => line.trim() && line.match(/^\d+\./))
              .map(line => line.trim())
          );
        }

        // Extract source URL from notes
        const sourceMatch = content.match(/Source:\s*(https?:\/\/[^\s]+)/);

        const recipeData = {
          title: titleMatch ? titleMatch[1] : file.replace('.md', ''),
          cuisine: cuisineMatch ? cuisineMatch[1].trim() : null,
          course: courseMatch ? courseMatch[1].trim() : null,
          servings: servingsMatch ? servingsMatch[1].trim() : null,
          prepTime: prepTimeMatch ? prepTimeMatch[1].trim() : null,
          cookTime: cookTimeMatch ? cookTimeMatch[1].trim() : null,
          sourceUrl: sourceMatch ? sourceMatch[1] : null,
          ingredients:
            fullIngredients.length > 0 ? fullIngredients : ingredientsList,
          instructions: instructions,
        };

        await db.saveRecipe(recipeData, content);
        imported++;
      } catch (error) {
        console.error(`Failed to import ${file}:`, error);
      }
    }

    res.json({ success: true, imported, total: mdFiles.length });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
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

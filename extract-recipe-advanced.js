#!/usr/bin/env node

const https = require('https');
const http = require('http');
const { URL } = require('url');
const fs = require('fs').promises;
const { JSDOM } = require('jsdom');

/**
 * Fetch HTML content from a URL with proper headers
 */
function fetchHTML(url) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const protocol = urlObj.protocol === 'https:' ? https : http;

    const options = {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    };

    protocol
      .get(url, options, res => {
        let data = '';

        // Handle redirects
        if (
          res.statusCode >= 300 &&
          res.statusCode < 400 &&
          res.headers.location
        ) {
          return fetchHTML(res.headers.location).then(resolve).catch(reject);
        }

        res.on('data', chunk => {
          data += chunk;
        });

        res.on('end', () => {
          resolve(data);
        });
      })
      .on('error', err => {
        reject(err);
      });
  });
}

/**
 * Extract JSON-LD structured data from HTML
 */
function extractJSONLD(html) {
  const jsonLDRegex =
    /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  const matches = [...html.matchAll(jsonLDRegex)];

  for (const match of matches) {
    try {
      const json = JSON.parse(match[1]);

      // Check if it's a Recipe schema
      if (
        json['@type'] === 'Recipe' ||
        (Array.isArray(json['@type']) && json['@type'].includes('Recipe')) ||
        (json['@graph'] &&
          json['@graph'].some(item => item['@type'] === 'Recipe'))
      ) {
        // If it's in @graph, extract the Recipe object
        if (json['@graph']) {
          const recipe = json['@graph'].find(
            item => item['@type'] === 'Recipe'
          );
          if (recipe) return recipe;
        }

        return json;
      }
    } catch (e) {
      // Continue to next match if JSON parsing fails
    }
  }

  return null;
}

/**
 * Parse duration to human-readable format
 */
function parseDuration(duration) {
  if (!duration) return '';

  // Handle ISO 8601 duration
  const iso8601Regex = /PT(?:(\d+)H)?(?:(\d+)M)?/;
  const match = duration.match(iso8601Regex);

  if (match) {
    const hours = match[1] ? parseInt(match[1]) : 0;
    const minutes = match[2] ? parseInt(match[2]) : 0;

    if (hours && minutes) {
      return `${hours} hour${hours > 1 ? 's' : ''} ${minutes} minute${
        minutes > 1 ? 's' : ''
      }`;
    } else if (hours) {
      return `${hours} hour${hours > 1 ? 's' : ''}`;
    } else if (minutes) {
      return `${minutes} minute${minutes > 1 ? 's' : ''}`;
    }
  }

  // If it's already human-readable, return as is
  return duration;
}

/**
 * Extract recipe yield/servings
 */
function extractYield(recipeYield) {
  if (!recipeYield) return '';

  if (Array.isArray(recipeYield)) {
    recipeYield = recipeYield[0];
  }

  // If it's just a number, assume servings
  if (!isNaN(recipeYield)) {
    return `${recipeYield} servings`;
  }

  return recipeYield.toString();
}

/**
 * Extract ingredients from various formats
 */
function extractIngredients(ingredients) {
  if (!ingredients) return [];

  if (Array.isArray(ingredients)) {
    return ingredients
      .map(ing => {
        if (typeof ing === 'string') {
          return ing.trim();
        } else if (ing.text) {
          return ing.text.trim();
        } else if (ing.name) {
          return ing.name.trim();
        }
        return '';
      })
      .filter(Boolean);
  }

  return [];
}

/**
 * Extract just the ingredient names without measurements
 */
function extractIngredientNames(ingredients) {
  return ingredients
    .map(ing => {
      // Remove measurements and quantities
      let cleaned = ing
        // Remove numbers, fractions, and measurements at the start
        .replace(/^[\d\s\/\-\.]+/, '')
        // Remove measurement units with their quantities
        .replace(
          /^(cup|cups|tablespoon|tablespoons|tbsp|tbs|teaspoon|teaspoons|tsp|pound|pounds|lb|lbs|ounce|ounces|oz|gram|grams|g|kilogram|kilograms|kg|liter|liters|l|milliliter|milliliters|ml|pint|pints|pt|quart|quarts|qt|gallon|gallons|gal|stick|sticks)\s+/i,
          ''
        )
        // Remove standalone quantities
        .replace(
          /^(piece|pieces|slice|slices|clove|cloves|bunch|bunches|package|packages|pkg|can|cans|jar|jars|bottle|bottles|bag|bags|box|boxes|container|containers|dash|dashes|pinch|pinches|handful|handfuls|sprig|sprigs)\s+/i,
          ''
        )
        // Remove parenthetical content with measurements
        .replace(/\([^)]*\)/g, '')
        // Remove "of" at the beginning
        .replace(/^of\s+/i, '')
        // Remove trailing commas and anything after
        .replace(/,.*$/, '')
        .trim();

      // Capitalize each word properly
      cleaned = cleaned
        .split(/\s+/)
        .map(word => {
          // Handle hyphenated words
          if (word.includes('-')) {
            return word
              .split('-')
              .map(
                part =>
                  part.charAt(0).toUpperCase() + part.slice(1).toLowerCase()
              )
              .join('-');
          }
          // Regular capitalization
          return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
        })
        .join(' ');

      return cleaned;
    })
    .filter(name => name.length > 0);
}

/**
 * Extract instructions from various formats
 */
function extractInstructions(instructions) {
  if (!instructions) return [];

  if (Array.isArray(instructions)) {
    return instructions
      .map((inst, index) => {
        let text = '';

        if (typeof inst === 'string') {
          text = inst;
        } else if (inst.text) {
          text = inst.text;
        } else if (inst.name) {
          text = inst.name;
        }

        // Clean up the text
        text = text.trim().replace(/^\d+\.\s*/, ''); // Remove numbering if present

        return `${index + 1}. ${text}`;
      })
      .filter(Boolean);
  }

  return [];
}

/**
 * Extract cuisine from recipe
 */
function extractCuisine(recipe) {
  if (recipe.recipeCuisine) {
    if (Array.isArray(recipe.recipeCuisine)) {
      return recipe.recipeCuisine[0];
    }
    return recipe.recipeCuisine;
  }
  return '';
}

/**
 * Extract course from recipe
 */
function extractCourse(recipe) {
  if (recipe.recipeCategory) {
    if (Array.isArray(recipe.recipeCategory)) {
      return recipe.recipeCategory[0];
    }
    return recipe.recipeCategory;
  }
  return '';
}

/**
 * Fallback HTML parsing for sites without JSON-LD
 */
function parseRecipeFromHTML(html, url) {
  const dom = new JSDOM(html);
  const doc = dom.window.document;

  const recipe = {
    title: '',
    cuisine: '',
    course: '',
    servings: '',
    prepTime: '',
    cookTime: '',
    ingredients: [],
    instructions: [],
  };

  // Try to extract title
  const titleSelectors = [
    'h1.recipe-name',
    'h1[class*="recipe-title"]',
    'h1[class*="recipe-name"]',
    'h1[itemprop="name"]',
    '.recipe-header h1',
    'h1',
  ];

  for (const selector of titleSelectors) {
    const element = doc.querySelector(selector);
    if (element && element.textContent.trim()) {
      recipe.title = element.textContent.trim();
      break;
    }
  }

  // Try to extract ingredients
  const ingredientSelectors = [
    '[itemprop="recipeIngredient"]',
    '[itemprop="ingredients"]',
    '.recipe-ingredient',
    '.ingredient',
    'ul.ingredients li',
    '.recipe-ingredients li',
    '.ingredients-section li',
  ];

  for (const selector of ingredientSelectors) {
    const elements = doc.querySelectorAll(selector);
    if (elements.length > 0) {
      recipe.ingredients = Array.from(elements)
        .map(el => el.textContent.trim())
        .filter(text => text && text.length > 0);
      break;
    }
  }

  // Try to extract instructions
  const instructionSelectors = [
    '[itemprop="recipeInstructions"]',
    '.recipe-instruction',
    '.instruction',
    '.directions li',
    '.recipe-directions li',
    '.instructions-section li',
    '.method li',
  ];

  for (const selector of instructionSelectors) {
    const elements = doc.querySelectorAll(selector);
    if (elements.length > 0) {
      recipe.instructions = Array.from(elements)
        .map((el, index) => {
          const text = el.textContent.trim().replace(/^\d+\.\s*/, '');
          return `${index + 1}. ${text}`;
        })
        .filter(text => text && text.length > 2);
      break;
    }
  }

  // Try to extract servings
  const servingsSelectors = [
    '[itemprop="recipeYield"]',
    '.recipe-yield',
    '.servings',
    '.yields',
  ];

  for (const selector of servingsSelectors) {
    const element = doc.querySelector(selector);
    if (element && element.textContent.trim()) {
      recipe.servings = extractYield(element.textContent.trim());
      break;
    }
  }

  // Try to extract times
  const prepTimeElement = doc.querySelector(
    '[itemprop="prepTime"], .prep-time, .preptime'
  );
  if (prepTimeElement) {
    recipe.prepTime = parseDuration(prepTimeElement.textContent.trim());
  }

  const cookTimeElement = doc.querySelector(
    '[itemprop="cookTime"], .cook-time, .cooktime'
  );
  if (cookTimeElement) {
    recipe.cookTime = parseDuration(cookTimeElement.textContent.trim());
  }

  return recipe;
}

/**
 * Format recipe to Obsidian markdown template
 */
function formatToObsidian(recipeData, sourceUrl) {
  const today = new Date().toISOString().split('T')[0];

  const ingredientNames = extractIngredientNames(recipeData.ingredients);

  const frontmatter = [
    '---',
    `title: '${recipeData.title || 'Untitled Recipe'}'`,
    `date: ${today}`,
    `cuisine: ${recipeData.cuisine || ''}`,
    `course: ${recipeData.course || ''}`,
    `servings: ${recipeData.servings || ''}`,
    `prep_time: ${recipeData.prepTime || ''}`,
    `cook_time: ${recipeData.cookTime || ''}`,
    'tags:',
    '  - recipe',
    'ingredients:',
    ...ingredientNames.map(ing => `  - ${ing}`),
    '---',
    '',
  ].join('\n');

  const content = [
    '## Ingredients',
    '',
    ...recipeData.ingredients.map(ing => `- ${ing}`),
    '',
    '## Directions',
    '',
    ...recipeData.instructions,
    '',
    '## Notes',
    '',
    `Source: ${sourceUrl}`,
    '',
  ].join('\n');

  return frontmatter + content;
}

/**
 * Main function to extract recipe from URL
 */
async function extractRecipe(url) {
  try {
    console.log(`Fetching recipe from: ${url}`);

    const html = await fetchHTML(url);

    // First try JSON-LD extraction
    let recipeData = null;
    const jsonLD = extractJSONLD(html);

    if (jsonLD) {
      console.log('Found JSON-LD structured data');
      recipeData = {
        title: jsonLD.name || '',
        cuisine: extractCuisine(jsonLD),
        course: extractCourse(jsonLD),
        servings: extractYield(jsonLD.recipeYield),
        prepTime: parseDuration(jsonLD.prepTime),
        cookTime: parseDuration(jsonLD.cookTime),
        ingredients: extractIngredients(jsonLD.recipeIngredient),
        instructions: extractInstructions(jsonLD.recipeInstructions),
      };
    } else {
      console.log('No JSON-LD found, falling back to HTML parsing');
      recipeData = parseRecipeFromHTML(html, url);
    }

    if (!recipeData.title || recipeData.ingredients.length === 0) {
      throw new Error('Unable to extract recipe data from this page');
    }

    const markdown = formatToObsidian(recipeData, url);

    // Generate filename from title
    const filename =
      recipeData.title
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') + '.md';

    // Write to file
    await fs.writeFile(filename, markdown);

    console.log(`\nRecipe extracted successfully!`);
    console.log(`Saved to: ${filename}`);
    console.log(`\nRecipe: ${recipeData.title}`);
    console.log(`Servings: ${recipeData.servings || 'Not specified'}`);
    console.log(`Prep Time: ${recipeData.prepTime || 'Not specified'}`);
    console.log(`Cook Time: ${recipeData.cookTime || 'Not specified'}`);
    console.log(`Ingredients: ${recipeData.ingredients.length} items`);
    console.log(`Instructions: ${recipeData.instructions.length} steps`);
  } catch (error) {
    console.error(`Error extracting recipe: ${error.message}`);
    process.exit(1);
  }
}

// Check command line arguments
if (process.argv.length < 3) {
  console.log('Usage: node extract-recipe-advanced.js <recipe-url>');
  console.log(
    'Example: node extract-recipe-advanced.js https://www.example.com/recipe'
  );
  console.log('\nThis advanced version includes:');
  console.log(
    '- Better HTML parsing fallback for sites without structured data'
  );
  console.log('- Support for more recipe websites');
  console.log('- Improved error handling and redirect support');
  console.log(
    '\nNote: This script requires jsdom. Install with: npm install jsdom'
  );
  process.exit(1);
}

const url = process.argv[2];

// Validate URL
try {
  new URL(url);
} catch (error) {
  console.error('Invalid URL provided');
  process.exit(1);
}

// Run the extraction
extractRecipe(url);

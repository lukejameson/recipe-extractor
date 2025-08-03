const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs').promises;

class RecipeDatabase {
  constructor(dbPath = './recipes.db') {
    this.db = new Database(dbPath);
    this.initializeDatabase();
  }

  initializeDatabase() {
    // Create recipes table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recipes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        cuisine TEXT,
        course TEXT,
        servings TEXT,
        prep_time TEXT,
        cook_time TEXT,
        source_url TEXT,
        date_added TEXT DEFAULT (datetime('now')),
        date_modified TEXT DEFAULT (datetime('now')),
        markdown_content TEXT,
        UNIQUE(source_url)
      )
    `);

    // Create ingredients table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ingredients (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipe_id INTEGER NOT NULL,
        original_text TEXT NOT NULL,
        ingredient_name TEXT NOT NULL,
        quantity REAL,
        unit TEXT,
        original_quantity REAL,
        original_unit TEXT,
        converted BOOLEAN DEFAULT 0,
        display_text TEXT,
        notes TEXT,
        sort_order INTEGER DEFAULT 0,
        FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
      )
    `);

    // Add new columns to existing ingredients table
    try {
      this.db.exec(`ALTER TABLE ingredients ADD COLUMN original_quantity REAL`);
      this.db.exec(`ALTER TABLE ingredients ADD COLUMN original_unit TEXT`);
      this.db.exec(
        `ALTER TABLE ingredients ADD COLUMN converted BOOLEAN DEFAULT 0`
      );
      this.db.exec(`ALTER TABLE ingredients ADD COLUMN display_text TEXT`);
    } catch (e) {
      // Columns might already exist
    }

    // Create instructions table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS instructions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        recipe_id INTEGER NOT NULL,
        step_number INTEGER NOT NULL,
        instruction TEXT NOT NULL,
        FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE
      )
    `);

    // Create tags table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL
      )
    `);

    // Create recipe_tags junction table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recipe_tags (
        recipe_id INTEGER NOT NULL,
        tag_id INTEGER NOT NULL,
        PRIMARY KEY (recipe_id, tag_id),
        FOREIGN KEY (recipe_id) REFERENCES recipes(id) ON DELETE CASCADE,
        FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
      )
    `);

    // Create categories table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS categories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        color TEXT DEFAULT '#4CAF50'
      )
    `);

    // Add category_id to recipes
    try {
      this.db.exec(
        `ALTER TABLE recipes ADD COLUMN category_id INTEGER REFERENCES categories(id)`
      );
    } catch (e) {
      // Column might already exist
    }

    // Create indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_recipes_title ON recipes(title);
      CREATE INDEX IF NOT EXISTS idx_recipes_date ON recipes(date_added);
      CREATE INDEX IF NOT EXISTS idx_ingredients_recipe ON ingredients(recipe_id);
      CREATE INDEX IF NOT EXISTS idx_instructions_recipe ON instructions(recipe_id);
    `);
  }

  // Imperial to metric conversion tables
  static conversionTable = {
    // Volume conversions to ml
    volume: {
      cup: 240,
      cups: 240,
      pint: 473,
      pints: 473,
      quart: 946,
      quarts: 946,
      gallon: 3785,
      gallons: 3785,
      tablespoon: 15,
      tablespoons: 15,
      tbsp: 15,
      teaspoon: 5,
      teaspoons: 5,
      tsp: 5,
      'fluid ounce': 30,
      'fluid ounces': 30,
      'fl oz': 30,
      oz: 30, // assuming fluid oz for liquid ingredients
    },
    // Weight conversions to grams
    weight: {
      pound: 454,
      pounds: 454,
      lb: 454,
      lbs: 454,
      ounce: 28,
      ounces: 28,
      oz: 28, // assuming weight oz for dry ingredients
    },
    // Temperature conversions
    temperature: {
      fahrenheit: f => Math.round(((f - 32) * 5) / 9),
      f: f => Math.round(((f - 32) * 5) / 9),
    },
  };

  // Convert imperial measurements to metric
  convertToMetric(quantity, unit, ingredient) {
    if (!quantity || !unit) return { quantity, unit, converted: false };

    const unitLower = unit.toLowerCase();

    // Check if it's likely a liquid ingredient for oz disambiguation
    const isLiquid =
      /\b(water|milk|oil|juice|broth|stock|wine|vinegar|cream|butter)\b/i.test(
        ingredient
      );

    // Volume conversions
    if (RecipeDatabase.conversionTable.volume[unitLower]) {
      const mlAmount =
        quantity * RecipeDatabase.conversionTable.volume[unitLower];

      if (mlAmount >= 1000) {
        return {
          quantity: Math.round((mlAmount / 1000) * 10) / 10,
          unit: 'L',
          originalQuantity: quantity,
          originalUnit: unit,
          converted: true,
        };
      } else {
        return {
          quantity: Math.round(mlAmount),
          unit: 'ml',
          originalQuantity: quantity,
          originalUnit: unit,
          converted: true,
        };
      }
    }

    // Weight conversions (for oz, prefer weight if not liquid)
    if (
      RecipeDatabase.conversionTable.weight[unitLower] &&
      (!unitLower.includes('oz') || !isLiquid)
    ) {
      const gAmount =
        quantity * RecipeDatabase.conversionTable.weight[unitLower];

      if (gAmount >= 1000) {
        return {
          quantity: Math.round((gAmount / 1000) * 10) / 10,
          unit: 'kg',
          originalQuantity: quantity,
          originalUnit: unit,
          converted: true,
        };
      } else {
        return {
          quantity: Math.round(gAmount),
          unit: 'g',
          originalQuantity: quantity,
          originalUnit: unit,
          converted: true,
        };
      }
    }

    return { quantity, unit, converted: false };
  }

  // Format converted measurement for display
  formatMeasurement(convertedData) {
    if (!convertedData.converted) {
      return convertedData.quantity + ' ' + convertedData.unit;
    }

    const metric = convertedData.quantity + ' ' + convertedData.unit;
    const imperial =
      convertedData.originalQuantity + ' ' + convertedData.originalUnit;
    return `${metric} (${imperial})`;
  }

  // Parse ingredient line into structured data
  parseIngredient(ingredientLine) {
    const regex = /^([\d\/\.\s-]+)?\s*([a-zA-Z\s]+)?\s*(.+)$/;
    const match = ingredientLine.match(regex);

    if (match) {
      const [_, quantity, unit, rest] = match;
      const parsedQuantity = this.parseQuantity(quantity);
      const cleanUnit = unit ? unit.trim() : '';
      const ingredientName = rest || ingredientLine;

      // Convert to metric if applicable
      const converted = this.convertToMetric(
        parsedQuantity,
        cleanUnit,
        ingredientName
      );

      return {
        quantity: converted.quantity,
        unit: converted.unit,
        ingredient_name: ingredientName,
        original_text: ingredientLine,
        original_quantity: converted.originalQuantity || parsedQuantity,
        original_unit: converted.originalUnit || cleanUnit,
        converted: converted.converted,
        display_text: converted.converted
          ? `${this.formatQuantityForDisplay(converted.quantity)} ${
              converted.unit
            } ${ingredientName} (${this.formatQuantityForDisplay(
              converted.originalQuantity
            )} ${converted.originalUnit})`
          : ingredientLine,
      };
    }

    return {
      quantity: null,
      unit: '',
      ingredient_name: ingredientLine,
      original_text: ingredientLine,
      original_quantity: null,
      original_unit: '',
      converted: false,
      display_text: ingredientLine,
    };
  }

  // Format quantity for better display
  formatQuantityForDisplay(quantity) {
    if (!quantity) return '';

    // Convert decimal to fraction if it's a common fraction
    const fraction = this.decimalToFraction(quantity);
    return fraction || quantity.toString();
  }

  parseQuantity(quantityStr) {
    if (!quantityStr) return null;

    // Handle fractions
    if (quantityStr.includes('/')) {
      const parts = quantityStr.split(/[\s-]+/);
      let total = 0;

      for (const part of parts) {
        if (part.includes('/')) {
          const [num, den] = part.split('/').map(Number);
          total += num / den;
        } else {
          total += Number(part) || 0;
        }
      }

      return total;
    }

    return parseFloat(quantityStr) || null;
  }

  // Save a recipe from extracted data
  async saveRecipe(recipeData, markdownContent) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO recipes (
        title, cuisine, course, servings, prep_time, cook_time,
        source_url, markdown_content, date_modified
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    const info = stmt.run(
      recipeData.title,
      recipeData.cuisine || null,
      recipeData.course || null,
      recipeData.servings || null,
      recipeData.prepTime || null,
      recipeData.cookTime || null,
      recipeData.sourceUrl || null,
      markdownContent
    );

    const recipeId = info.lastInsertRowid;

    // Save ingredients
    const deleteIngredients = this.db.prepare(
      'DELETE FROM ingredients WHERE recipe_id = ?'
    );
    deleteIngredients.run(recipeId);

    const insertIngredient = this.db.prepare(`
      INSERT INTO ingredients (
        recipe_id, original_text, ingredient_name, quantity, unit,
        original_quantity, original_unit, converted, display_text, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    recipeData.ingredients.forEach((ingredient, index) => {
      const parsed = this.parseIngredient(ingredient);
      insertIngredient.run(
        recipeId,
        ingredient,
        parsed.ingredient_name,
        parsed.quantity,
        parsed.unit,
        parsed.original_quantity,
        parsed.original_unit,
        parsed.converted ? 1 : 0,
        parsed.display_text,
        index
      );
    });

    // Save instructions
    const deleteInstructions = this.db.prepare(
      'DELETE FROM instructions WHERE recipe_id = ?'
    );
    deleteInstructions.run(recipeId);

    const insertInstruction = this.db.prepare(`
      INSERT INTO instructions (recipe_id, step_number, instruction) VALUES (?, ?, ?)
    `);

    recipeData.instructions.forEach((instruction, index) => {
      insertInstruction.run(
        recipeId,
        index + 1,
        instruction.replace(/^\d+\.\s*/, '')
      );
    });

    return recipeId;
  }

  // Get all recipes with basic info
  getAllRecipes() {
    const stmt = this.db.prepare(`
      SELECT r.*, c.name as category_name, c.color as category_color,
        GROUP_CONCAT(t.name) as tags
      FROM recipes r
      LEFT JOIN categories c ON r.category_id = c.id
      LEFT JOIN recipe_tags rt ON r.id = rt.recipe_id
      LEFT JOIN tags t ON rt.tag_id = t.id
      GROUP BY r.id
      ORDER BY r.date_added DESC
    `);

    return stmt.all();
  }

  // Get single recipe with all details
  getRecipe(id) {
    const recipe = this.db
      .prepare('SELECT * FROM recipes WHERE id = ?')
      .get(id);

    if (!recipe) return null;

    recipe.ingredients = this.db
      .prepare(
        `
      SELECT * FROM ingredients WHERE recipe_id = ? ORDER BY sort_order
    `
      )
      .all(id);

    recipe.instructions = this.db
      .prepare(
        `
      SELECT * FROM instructions WHERE recipe_id = ? ORDER BY step_number
    `
      )
      .all(id);

    recipe.tags = this.db
      .prepare(
        `
      SELECT t.* FROM tags t
      JOIN recipe_tags rt ON t.id = rt.tag_id
      WHERE rt.recipe_id = ?
    `
      )
      .all(id);

    return recipe;
  }

  // Parse servings to extract numeric value
  parseServings(servingsText) {
    if (!servingsText) return null;

    // Try to extract number from various formats like "14 servings", "Serves 6", "Makes 12 cookies", etc.
    const match = servingsText.match(/(\d+(?:\.\d+)?)/);
    return match ? parseFloat(match[1]) : null;
  }

  // Scale ingredients for a recipe
  scaleIngredients(recipeId, scaleFactor) {
    const ingredients = this.db
      .prepare(
        `
      SELECT * FROM ingredients WHERE recipe_id = ? ORDER BY sort_order
    `
      )
      .all(recipeId);

    return ingredients.map(ing => {
      if (ing.quantity) {
        const scaledQuantity = ing.quantity * scaleFactor;
        // Format the quantity nicely
        let displayQuantity;

        if (scaledQuantity % 1 === 0) {
          displayQuantity = scaledQuantity.toString();
        } else {
          // Convert to fraction if possible
          const fraction = this.decimalToFraction(scaledQuantity);
          displayQuantity = fraction || scaledQuantity.toFixed(2);
        }

        const scaledText =
          `${displayQuantity} ${ing.unit} ${ing.ingredient_name}`.trim();

        return {
          ...ing,
          scaled_quantity: scaledQuantity,
          display_quantity: displayQuantity,
          scaled_text: scaledText,
        };
      }

      return ing;
    });
  }

  // Scale ingredients based on desired servings
  scaleIngredientsToServings(recipeId, desiredServings) {
    const recipe = this.db
      .prepare('SELECT servings FROM recipes WHERE id = ?')
      .get(recipeId);

    if (!recipe) return null;

    const originalServings = this.parseServings(recipe.servings);
    if (!originalServings || !desiredServings) return null;

    const scaleFactor = desiredServings / originalServings;
    return {
      scaleFactor,
      originalServings,
      desiredServings,
      ingredients: this.scaleIngredients(recipeId, scaleFactor),
    };
  }

  decimalToFraction(decimal) {
    const tolerance = 1.0e-6;
    let h1 = 1,
      h2 = 0,
      k1 = 0,
      k2 = 1;
    let b = decimal;

    do {
      const a = Math.floor(b);
      let aux = h1;
      h1 = a * h1 + h2;
      h2 = aux;
      aux = k1;
      k1 = a * k1 + k2;
      k2 = aux;
      b = 1 / (b - a);
    } while (Math.abs(decimal - h1 / k1) > decimal * tolerance);

    // Return common fractions
    if (k1 <= 8) {
      const whole = Math.floor(h1 / k1);
      const remainder = h1 % k1;

      if (whole > 0 && remainder > 0) {
        return `${whole} ${remainder}/${k1}`;
      } else if (remainder > 0) {
        return `${remainder}/${k1}`;
      }
    }

    return null;
  }

  // Category management
  createCategory(name, color = '#4CAF50') {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO categories (name, color) VALUES (?, ?)'
    );
    return stmt.run(name, color);
  }

  getAllCategories() {
    return this.db.prepare('SELECT * FROM categories ORDER BY name').all();
  }

  updateRecipeCategory(recipeId, categoryId) {
    const stmt = this.db.prepare(
      'UPDATE recipes SET category_id = ? WHERE id = ?'
    );
    return stmt.run(categoryId, recipeId);
  }

  // Tag management
  createTag(name) {
    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO tags (name) VALUES (?)'
    );
    return stmt.run(name);
  }

  addTagToRecipe(recipeId, tagName) {
    this.createTag(tagName);
    const tagId = this.db
      .prepare('SELECT id FROM tags WHERE name = ?')
      .get(tagName).id;

    const stmt = this.db.prepare(
      'INSERT OR IGNORE INTO recipe_tags (recipe_id, tag_id) VALUES (?, ?)'
    );
    return stmt.run(recipeId, tagId);
  }

  removeTagFromRecipe(recipeId, tagId) {
    const stmt = this.db.prepare(
      'DELETE FROM recipe_tags WHERE recipe_id = ? AND tag_id = ?'
    );
    return stmt.run(recipeId, tagId);
  }

  // Search recipes
  searchRecipes(query) {
    const stmt = this.db.prepare(`
      SELECT DISTINCT r.*, c.name as category_name, c.color as category_color
      FROM recipes r
      LEFT JOIN categories c ON r.category_id = c.id
      LEFT JOIN ingredients i ON r.id = i.recipe_id
      WHERE r.title LIKE ? OR i.ingredient_name LIKE ?
      ORDER BY r.date_added DESC
    `);

    const searchTerm = `%${query}%`;
    return stmt.all(searchTerm, searchTerm);
  }

  // Export to markdown
  exportToMarkdown(recipeId) {
    const recipe = this.getRecipe(recipeId);
    if (!recipe) return null;

    return recipe.markdown_content;
  }

  // Delete recipe
  deleteRecipe(recipeId) {
    const stmt = this.db.prepare('DELETE FROM recipes WHERE id = ?');
    return stmt.run(recipeId);
  }

  close() {
    this.db.close();
  }
}

module.exports = RecipeDatabase;

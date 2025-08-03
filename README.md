# Recipe Extractor for Obsidian

A web-based recipe extractor that replicates JustTheRecipe.com functionality, extracting recipe information from URLs and formatting them for Obsidian markdown.

## Features

- Extract recipes from URLs and format as Obsidian markdown
- Web UI with password protection
- Docker deployment ready
- Command-line scripts for direct usage
- Ingredients listed without measurements in frontmatter
- Full recipe details preserved in content

## Quick Start

### Web UI (Recommended)

```bash
# Clone and install
git clone <your-repo-url>
cd onlyrecipe
npm install

# Run locally
node server.js

# Access at http://localhost:3000
# Default password: recipe123
```

### Docker Deployment

```bash
# Using docker-compose
docker-compose up -d

# Or using Docker directly
docker build -t recipe-extractor .
docker run -d -p 3000:3000 -v $(pwd)/recipes:/recipes recipe-extractor
```

### Environment Variables

- `APP_PASSWORD` - Web UI password (default: recipe123)
- `SAVE_PATH` - Recipe save directory (default: ./recipes)
- `PORT` - Server port (default: 3000)
- `SESSION_SECRET` - Session encryption key (auto-generated)

## Command Line Usage

### Basic Script

```bash
node extract-recipe.js https://www.allrecipes.com/recipe/23600/worlds-best-lasagna/
```

### Advanced Script (with HTML fallback)

```bash
npm install jsdom
node extract-recipe-advanced.js https://www.example.com/recipe
```

## Output Format

Creates markdown files with Obsidian-compatible frontmatter:

```markdown
---
title: 'Recipe Title'
date: 2025-01-08
cuisine: Italian
course: Main Course
servings: 8 servings
prep_time: 30 minutes
cook_time: 2 hours 30 minutes
tags:
  - recipe
ingredients:
  - Ground Beef
  - Onion
  - Garlic
---

## Ingredients

- 1 pound ground beef
- 1 medium onion, chopped
- 2 cloves garlic, minced

## Directions

1. Brown the ground beef...
2. Add onion and garlic...

## Notes

Source: https://www.example.com/recipe
```

## Supported Websites

Works best with sites using schema.org Recipe structured data:

- AllRecipes
- Food Network
- Serious Eats
- BBC Good Food
- Simply Recipes
- Bon Appétit
- And many more...

## Troubleshooting

- **"No recipe structured data found"** - Use the advanced script or check "Use advanced extractor" in the web UI
- **Network errors** - Verify the URL is accessible
- **Docker issues** - Ensure the recipes directory has proper permissions

## License

MIT

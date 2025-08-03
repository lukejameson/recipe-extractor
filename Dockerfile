FROM node:18-alpine

# Install dependencies for jsdom
RUN apk add --no-cache \
  python3 \
  make \
  g++ \
  cairo-dev \
  jpeg-dev \
  pango-dev \
  giflib-dev

# Create app directory
WORKDIR /app

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci --only=production

# Copy app source
COPY . .

# Create recipes directory
RUN mkdir -p /recipes

# Expose port
EXPOSE 3000

# Run the application
CMD ["node", "server.js"]

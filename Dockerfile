FROM node:18-alpine

# Install dependencies for jsdom and better-sqlite3
RUN apk add --no-cache \
  python3 \
  python3-dev \
  py3-pip \
  make \
  g++ \
  cairo-dev \
  jpeg-dev \
  pango-dev \
  giflib-dev \
  sqlite-dev

# Install distutils for node-gyp
RUN pip3 install setuptools

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

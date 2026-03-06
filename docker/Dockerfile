FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --production
COPY dist/ ./dist/
COPY migrations/ ./migrations/
RUN mkdir -p /app/data
VOLUME /app/data
ENV NODE_ENV=production
CMD ["node", "dist/index.js"]

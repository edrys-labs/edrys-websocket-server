FROM node:22-alpine

RUN mkdir -p /home/node/app && chown -R node:node /home/node/app
WORKDIR /home/node/app

# Copy only the dist folder and package files
COPY --chown=node:node ./dist ./dist
COPY --chown=node:node package*.json ./

USER node
# Install only production dependencies
RUN npm ci --only=production

# Heroku dynamically assigns a port, so we use the $PORT environment variable
ENV PORT=1234
ENV HOST="0.0.0.0"
ENV NODE_ENV="production"

# Use PORT environment variable but default to 1234 if not set
EXPOSE $PORT

# Start the application using the compiled server.cjs in the dist folder
CMD [ "sh", "-c", "node dist/server.cjs --host=0.0.0.0 --port=${PORT}" ]
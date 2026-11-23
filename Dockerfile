FROM node:22-alpine

RUN mkdir -p /home/node/app && chown -R node:node /home/node/app
WORKDIR /home/node/app
USER node

# Production dependencies only (yjs comes in as a peer dependency)
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Node runs the ES module sources as they are; dist/ is only for require()
COPY --chown=node:node src ./src

# The server reads PORT and HOST itself; Heroku sets PORT at runtime.
ENV PORT=1234
ENV HOST="0.0.0.0"
ENV NODE_ENV="production"
EXPOSE 1234

# Exec form: node is PID 1 and gets SIGTERM directly (docker stop, Heroku).
CMD [ "node", "src/server.js" ]

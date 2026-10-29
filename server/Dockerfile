FROM node:22-alpine
WORKDIR /app
COPY *.mjs dashboard.html ./
RUN mkdir -p /app/data && chown node:node /app/data
USER node
VOLUME ["/app/data"]
CMD ["node", "dashboard.mjs", "--no-announce"]

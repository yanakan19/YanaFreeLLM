FROM node:20-slim
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
ENV PORT=4000
EXPOSE 4000
CMD ["node", "server/index.js"]

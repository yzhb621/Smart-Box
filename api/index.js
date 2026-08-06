// Top-level Vercel API entrypoint.
// This mirrors common Vercel layouts where an /api/index.js exports an Express
// app. It delegates to the existing server Express app so local development
// behavior is preserved while making Vercel routing simpler.
const app = require('../server/src/index.js');

// Optional simple CORS handling similar to the StackOverflow example.
const whitelist = ['*'];
app.use((req, res, next) => {
  const origin = req.get('referer') || req.get('origin');
  const isWhitelisted = whitelist.find((w) => origin && origin.includes(w));
  if (isWhitelisted) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
    res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,Content-Type,Authorization');
    res.setHeader('Access-Control-Allow-Credentials', true);
  }
  if (req.method === 'OPTIONS') res.sendStatus(200);
  else next();
});

module.exports = app;

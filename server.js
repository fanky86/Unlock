const express = require('express');
const path = require('path');
const unlockHandler = require('./api/unlock').default;

const app = express();
app.use(express.json());

// Endpoint API
app.post('/api/unlock', async (req, res) => {
  await unlockHandler(req, res);
});

// Serve static files dari folder public
app.use(express.static(path.join(__dirname, 'public')));

// Fallback ke index.html untuk SPA (opsional)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
  console.log(`🌐 Akses: http://localhost:${PORT}`);
});

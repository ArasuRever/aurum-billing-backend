const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Mount Routes (Feature-based)
app.use('/api/vendors', require('./routes/vendors'));
app.use('/api/inventory', require('./routes/inventory'));
app.use('/api/billing', require('./routes/billing'));
// app.use('/api/billing', require('./routes/billing')); // Uncomment when ready

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
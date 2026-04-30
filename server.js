import express from 'express';
import sql from 'mssql';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const app = express();
app.use(express.json());
app.use(express.static('.'));

const DB_CONFIG = {
  server: process.env.DB_SERVER,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true
  }
};

const USAGE_THRESHOLD = parseFloat(process.env.APIFY_LIMIT_THRESHOLD) || 4.9;

// ============ TOKEN FUNCTIONS ============

async function checkTokenLimit(token) {
  try {
    const response = await fetch(`https://api.apify.com/v2/users/me/limits?token=${token}`);
    const data = await response.json();
    const usage = data?.data?.current?.monthlyUsageUsd || 0;
    const isActive = usage < USAGE_THRESHOLD;
    return { usage, isActive };
  } catch (err) {
    return { usage: 0, isActive: false };
  }
}

async function getAllTokens() {
  const pool = await sql.connect(DB_CONFIG);
  const result = await pool.request().query('SELECT id, token, is_active, last_used FROM luma_tokens ORDER BY id DESC');
  await pool.close();
  return result.recordset;
}

async function addTokenToDB(tokenValue) {
  const pool = await sql.connect(DB_CONFIG);
  const { usage, isActive } = await checkTokenLimit(tokenValue);
  const result = await pool.request()
    .input('token', sql.NVarChar, tokenValue)
    .input('is_active', sql.Bit, isActive ? 1 : 0)
    .query(`INSERT INTO luma_tokens (token, is_active) VALUES (@token, @is_active) SELECT SCOPE_IDENTITY() as id`);
  await pool.close();
  return result.recordset[0].id;
}

async function updateTokenStatus(id, tokenValue) {
  const pool = await sql.connect(DB_CONFIG);
  const { usage, isActive } = await checkTokenLimit(tokenValue);
  await pool.request()
    .input('id', sql.Int, id)
    .input('is_active', sql.Bit, isActive ? 1 : 0)
    .input('last_used', sql.DateTime, isActive ? null : new Date())
    .query(`UPDATE luma_tokens SET is_active = @is_active, last_used = @last_used WHERE id = @id`);
  await pool.close();
  return { usage, isActive };
}

async function deleteToken(id) {
  const pool = await sql.connect(DB_CONFIG);
  await pool.request().input('id', sql.Int, id).query('DELETE FROM luma_tokens WHERE id = @id');
  await pool.close();
}

// ============ CITY FUNCTIONS ============

async function getAllCities() {
  const pool = await sql.connect(DB_CONFIG);
  const result = await pool.request().query('SELECT city_slug, is_active FROM luma_city ORDER BY city_slug ASC');
  await pool.close();
  return result.recordset;
}

async function updateCityStatus(citySlug, isActive) {
  const pool = await sql.connect(DB_CONFIG);
  await pool.request()
    .input('city_slug', sql.NVarChar, citySlug)
    .input('is_active', sql.Bit, isActive ? 1 : 0)
    .query(`UPDATE luma_city SET is_active = @is_active WHERE city_slug = @city_slug`);
  await pool.close();
  return { citySlug, isActive };
}

async function updateAllCitiesStatus(isActive) {
  const pool = await sql.connect(DB_CONFIG);
  await pool.request()
    .input('is_active', sql.Bit, isActive ? 1 : 0)
    .query(`UPDATE luma_city SET is_active = @is_active`);
  await pool.close();
  return { success: true, isActive };
}

// ============ AUTO CHECK TOKENS ============

async function checkAndUpdateAllTokens() {
  console.log('🔄 Checking tokens...');
  const tokens = await getAllTokens();
  for (const token of tokens) {
    const { usage, isActive } = await updateTokenStatus(token.id, token.token);
    console.log(`   Token ${token.id}: ${isActive ? 'ACTIVE' : 'INACTIVE'} ($${usage.toFixed(6)})`);
  }
  console.log('✅ Done');
}

setInterval(checkAndUpdateAllTokens, 5 * 60 * 1000);

// ============ TOKEN API ENDPOINTS ============

app.get('/api/tokens', async (req, res) => {
  try {
    const tokens = await getAllTokens();
    const tokensWithUsage = await Promise.all(tokens.map(async (token) => {
      const { usage, isActive } = await checkTokenLimit(token.token);
      return { ...token, current_usage: usage, is_limit_exceeded: !isActive };
    }));
    res.json({ success: true, data: tokensWithUsage });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/tokens', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ success: false, error: 'Token required' });
    const id = await addTokenToDB(token);
    res.json({ success: true, data: { id, message: 'Token added' } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/tokens/check-all', async (req, res) => {
  try {
    await checkAndUpdateAllTokens();
    res.json({ success: true, message: 'All tokens checked' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/tokens/:id', async (req, res) => {
  try {
    await deleteToken(parseInt(req.params.id));
    res.json({ success: true, message: 'Token deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ============ CITY API ENDPOINTS ============

app.get('/api/cities', async (req, res) => {
  try {
    const cities = await getAllCities();
    res.json({ success: true, data: cities });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/cities/:slug/toggle', async (req, res) => {
  try {
    const { slug } = req.params;
    const { is_active } = req.body;
    await updateCityStatus(slug, is_active);
    res.json({ success: true, message: `City ${is_active ? 'enabled' : 'disabled'}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post('/api/cities/toggle-all', async (req, res) => {
  try {
    const { is_active } = req.body;
    await updateAllCitiesStatus(is_active);
    res.json({ success: true, message: `All cities ${is_active ? 'enabled' : 'disabled'}` });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// AMERICAN CITIES TOGGLE - WORKS IN ONE QUERY
app.post('/api/cities/toggle-american', async (req, res) => {
  try {
    const { is_active } = req.body;
    const newStatus = is_active ? 1 : 0;

    const pool = await sql.connect(DB_CONFIG);

    const result = await pool.request()
      .input('is_active', sql.Bit, newStatus)
      .query(`
        UPDATE luma_city 
        SET is_active = @is_active 
        WHERE city_slug IN (
          'atlanta', 'austin', 'boston', 'calgary', 'chicago', 'dallas', 'denver',
          'houston', 'la', 'las-vegas', 'mexico-city', 'miami', 'minneapolis',
          'montreal', 'nyc', 'philadelphia', 'phoenix', 'portland', 'salt-lake-city',
          'san-diego', 'seattle', 'sf', 'toronto', 'vancouver', 'washington-dc',
          'waterloo', 'buenos-aires', 'medellin', 'rio-de-janeiro', 'sao-paulo'
        )
      `);

    await pool.close();

    const updatedCount = result.rowsAffected ? result.rowsAffected[0] : 0;
    res.json({ success: true, message: `${updatedCount} American cities ${is_active ? 'enabled' : 'disabled'}` });
  } catch (err) {
    console.error('Error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ADD NEW CITY
app.post('/api/cities', async (req, res) => {
  try {
    const { city_slug } = req.body;
    if (!city_slug) return res.status(400).json({ success: false, error: 'City slug required' });

    const pool = await sql.connect(DB_CONFIG);

    // Check if city already exists
    const check = await pool.request()
      .input('city_slug', sql.NVarChar, city_slug)
      .query('SELECT * FROM luma_city WHERE city_slug = @city_slug');

    if (check.recordset.length > 0) {
      await pool.close();
      return res.status(400).json({ success: false, error: 'City already exists' });
    }

    // Insert new city (default inactive)
    await pool.request()
      .input('city_slug', sql.NVarChar, city_slug)
      .input('is_active', sql.Bit, 0)
      .query('INSERT INTO luma_city (city_slug, is_active) VALUES (@city_slug, @is_active)');

    await pool.close();
    res.json({ success: true, message: 'City added successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});



// ============ SERVE HTML FILES ============

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'token.html'));
});





app.get('/token.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'token.html'));
});

app.get('/cities.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'cities.html'));
});





// ============ START SERVER ============

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n🚀 Server running on http://localhost:${PORT}`);
  console.log(`📊 Tables: luma_tokens | luma_city`);
  console.log(`🌎 American cities checkbox enabled - 30 cities`);
});

import sql from 'mssql';
import dotenv from 'dotenv';
dotenv.config();

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

// IMPORTANT: Get tokens from .env file - NO HARDCODED TOKENS!
const DEFAULT_TOKENS = [
  process.env.APIFY_TOKEN1,
  process.env.APIFY_TOKEN2
].filter(token => token && token.trim() !== '');

async function setup() {
  try {
    console.log('🔧 Connecting to database...');
    const pool = await sql.connect(DB_CONFIG);

    // Drop existing table if exists
    console.log('🗑️ Dropping existing table...');
    await pool.request().query(`
      IF EXISTS (SELECT * FROM sysobjects WHERE name='api_tokens' AND xtype='U')
      DROP TABLE api_tokens
    `);
    console.log('✅ Old table dropped');

    // Create fresh table
    console.log('📋 Creating api_tokens table...');
    await pool.request().query(`
      CREATE TABLE api_tokens (
        id INT IDENTITY(1,1) PRIMARY KEY,
        token NVARCHAR(255) NOT NULL UNIQUE,
        is_active BIT DEFAULT 1,
        usage_usd DECIMAL(10,6) DEFAULT 0,
        last_used DATETIME NULL,
        created_at DATETIME DEFAULT GETDATE()
      )
    `);
    console.log('✅ Table created successfully');

    // Insert default tokens from .env (NOT hardcoded)
    if (DEFAULT_TOKENS.length > 0) {
      console.log('🔑 Inserting default tokens from .env...');
      for (const token of DEFAULT_TOKENS) {
        await pool.request()
          .input('token', sql.NVarChar, token)
          .query('INSERT INTO api_tokens (token) VALUES (@token)');
        console.log(`   ✅ Inserted: ${token.substring(0, 45)}...`);
      }
    } else {
      console.log('⚠️ No tokens found in .env file');
      console.log('   Add APIFY_TOKEN1 and APIFY_TOKEN2 to your .env file');
    }

    await pool.close();

    console.log('\n🎉 SETUP COMPLETE!');
    console.log(`📊 Total tokens inserted: ${DEFAULT_TOKENS.length}`);

  } catch (err) {
    console.error('❌ Setup failed:', err.message);
  }
}

setup();
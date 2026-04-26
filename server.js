import sql from 'mssql';
import express from 'express';
import fetch from 'node-fetch';

const app = express();
app.use(express.json());

// Database Configuration
const DB_CONFIG = {
  server: 'SQL5075.site4now.net',
  user: 'db_ac7ded_eventbrite_admin',
  password: 'Abbas1001',
  database: 'db_ac7ded_eventbrite',
  options: {
    encrypt: false,
    trustServerCertificate: true,
    enableArithAbort: true
  }
};

// ============ APIFY LIMIT CHECK FUNCTION ============

async function checkTokenLimit(token) {
  try {
    const response = await fetch(`https://api.apify.com/v2/users/me/limits?token=${token}`);
    const data = await response.json();

    // Correct path: data.data.current.monthlyUsageUsd
    const usage = data?.data?.current?.monthlyUsageUsd || 0;
    const startAt = data?.data?.monthlyUsageCycle?.startAt || null;
    const endAt = data?.data?.monthlyUsageCycle?.endAt || null;
    const maxLimit = 4.9;

    return {
      usage,
      startAt,
      endAt,
      isExceeded: usage >= maxLimit,
      usageData: data
    };
  } catch (err) {
    console.error(`Error checking token limit:`, err.message);
    return {
      usage: 0,
      startAt: null,
      endAt: null,
      isExceeded: false,
      error: err.message
    };
  }
}

// ============ HELPER FUNCTIONS ============

async function getAllTokens() {
  const pool = await sql.connect(DB_CONFIG);
  const result = await pool.request().query(`
    SELECT id, token, is_active, last_used, created_at 
    FROM api_tokens 
    ORDER BY id DESC
  `);
  await pool.close();
  return result.recordset;
}

async function addToken(tokenValue) {
  const pool = await sql.connect(DB_CONFIG);

  // Check token limit before adding
  const { usage, startAt, endAt, isExceeded } = await checkTokenLimit(tokenValue);

  const result = await pool.request()
    .input('token', sql.NVarChar, tokenValue)
    .input('is_active', sql.Bit, isExceeded ? 0 : 1)
    .input('created_at', sql.DateTime, startAt ? new Date(startAt) : new Date())
    .input('last_used', sql.DateTime, endAt ? new Date(endAt) : null)
    .query(`
      INSERT INTO api_tokens (token, is_active, created_at, last_used) 
      VALUES (@token, @is_active, @created_at, @last_used)
      SELECT SCOPE_IDENTITY() as id
    `);

  await pool.close();
  return result.recordset[0].id;
}

async function updateTokenWithApifyData(id, tokenValue) {
  const pool = await sql.connect(DB_CONFIG);

  // Get latest data from Apify
  const { usage, startAt, endAt, isExceeded } = await checkTokenLimit(tokenValue);

  await pool.request()
    .input('id', sql.Int, id)
    .input('is_active', sql.Bit, isExceeded ? 0 : 1)
    .input('created_at', sql.DateTime, startAt ? new Date(startAt) : new Date())
    .input('last_used', sql.DateTime, endAt ? new Date(endAt) : null)
    .query(`
      UPDATE api_tokens 
      SET is_active = @is_active,
          created_at = @created_at,
          last_used = @last_used
      WHERE id = @id
    `);

  await pool.close();
  return { usage, isExceeded, startAt, endAt };
}

async function deleteToken(id) {
  const pool = await sql.connect(DB_CONFIG);
  await pool.request()
    .input('id', sql.Int, id)
    .query(`DELETE FROM api_tokens WHERE id = @id`);
  await pool.close();
}

async function getTokenStats() {
  const pool = await sql.connect(DB_CONFIG);
  const result = await pool.request().query(`
    SELECT 
      COUNT(*) as total,
      SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN is_active = 0 THEN 1 ELSE 0 END) as inactive
    FROM api_tokens
  `);
  await pool.close();
  return result.recordset[0];
}

// ============ AUTO CHECK ALL TOKENS ============

async function checkAndUpdateAllTokens() {
  console.log('🔄 Checking all tokens against Apify API...');
  const tokens = await getAllTokens();

  for (const token of tokens) {
    const { usage, isExceeded, startAt, endAt } = await checkTokenLimit(token.token);
    const newStatus = isExceeded ? 0 : 1;

    if (newStatus !== token.is_active) {
      await updateTokenWithApifyData(token.id, token.token);
      console.log(`   Token ${token.id}: ${isExceeded ? 'DEACTIVATED' : 'ACTIVATED'} (Usage: $${usage.toFixed(6)})`);
    } else {
      // Still update the cycle dates even if status same
      await updateTokenWithApifyData(token.id, token.token);
      console.log(`   Token ${token.id}: Updated (Usage: $${usage.toFixed(6)})`);
    }
  }

  console.log('✅ Token check completed');
}

// Run auto-check every 5 minutes
setInterval(checkAndUpdateAllTokens, 5 * 60 * 1000);

// ============ API ENDPOINTS ============

// Get all tokens with real-time usage
app.get('/api/tokens', async (req, res) => {
  try {
    const tokens = await getAllTokens();

    // Get real-time usage for each token
    const tokensWithUsage = await Promise.all(
      tokens.map(async (token) => {
        const { usage, startAt, endAt, isExceeded } = await checkTokenLimit(token.token);
        return {
          ...token,
          current_usage: usage,
          cycle_start: startAt,
          cycle_end: endAt,
          is_limit_exceeded: isExceeded
        };
      })
    );

    res.json({ success: true, data: tokensWithUsage });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Add new token
app.post('/api/tokens', async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) {
      return res.status(400).json({ success: false, error: 'Token is required' });
    }
    const id = await addToken(token);
    res.json({ success: true, data: { id, message: 'Token added successfully' } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Force check all tokens
app.post('/api/tokens/check-all', async (req, res) => {
  try {
    await checkAndUpdateAllTokens();
    res.json({ success: true, message: 'All tokens checked and updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete token
app.delete('/api/tokens/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await deleteToken(parseInt(id));
    res.json({ success: true, message: 'Token deleted successfully' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Get stats
app.get('/api/tokens/stats', async (req, res) => {
  try {
    const stats = await getTokenStats();
    const allTokens = await getAllTokens();

    // Calculate average usage
    let totalUsage = 0;
    for (const token of allTokens) {
      const { usage } = await checkTokenLimit(token.token);
      totalUsage += usage;
    }
    const avgUsage = allTokens.length > 0 ? totalUsage / allTokens.length : 0;

    res.json({
      success: true,
      data: {
        ...stats,
        avg_usage: avgUsage
      }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ success: true, status: 'running', timestamp: new Date().toISOString() });
});

// ============ SERVE UI ============

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Apify Token Manager</title>
      <style>
        * {
          margin: 0;
          padding: 0;
          box-sizing: border-box;
        }
        
        body {
          font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
          background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
          min-height: 100vh;
          padding: 20px;
        }
        
        .container {
          max-width: 1400px;
          margin: 0 auto;
        }
        
        /* Header */
        .header {
          background: linear-gradient(135deg, #0f3460 0%, #1a1a2e 100%);
          border-radius: 15px;
          padding: 30px;
          margin-bottom: 25px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.3);
          border: 1px solid rgba(255,255,255,0.1);
        }
        
        h1 {
          color: #00d4ff;
          font-size: 28px;
          margin-bottom: 10px;
        }
        
        .subtitle {
          color: #a0a0a0;
          font-size: 14px;
        }
        
        /* Stats Cards */
        .stats-grid {
          display: grid;
          grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
          gap: 20px;
          margin-bottom: 25px;
        }
        
        .stat-card {
          background: linear-gradient(135deg, #0f3460 0%, #1a1a2e 100%);
          border-radius: 15px;
          padding: 20px;
          text-align: center;
          box-shadow: 0 10px 30px rgba(0,0,0,0.3);
          border: 1px solid rgba(255,255,255,0.1);
          transition: transform 0.3s;
        }
        
        .stat-card:hover {
          transform: translateY(-5px);
        }
        
        .stat-value {
          font-size: 36px;
          font-weight: bold;
          color: #00d4ff;
        }
        
        .stat-label {
          color: #a0a0a0;
          margin-top: 10px;
          font-size: 14px;
        }
        
        /* Add Section */
        .add-section {
          background: linear-gradient(135deg, #0f3460 0%, #1a1a2e 100%);
          border-radius: 15px;
          padding: 25px;
          margin-bottom: 25px;
          border: 1px solid rgba(255,255,255,0.1);
        }
        
        .section-title {
          font-size: 20px;
          margin-bottom: 20px;
          color: #00d4ff;
          border-left: 4px solid #00d4ff;
          padding-left: 15px;
        }
        
        .input-group {
          display: flex;
          gap: 15px;
          flex-wrap: wrap;
        }
        
        .input-group input {
          flex: 1;
          padding: 12px 15px;
          border: 1px solid #2a2a4a;
          border-radius: 10px;
          font-size: 14px;
          background: #1a1a2e;
          color: white;
        }
        
        .input-group input:focus {
          outline: none;
          border-color: #00d4ff;
        }
        
        button {
          background: linear-gradient(135deg, #00d4ff 0%, #0099cc 100%);
          color: white;
          border: none;
          padding: 12px 25px;
          border-radius: 10px;
          cursor: pointer;
          font-size: 14px;
          font-weight: 600;
          transition: transform 0.2s;
        }
        
        button:hover {
          transform: translateY(-2px);
        }
        
        button.danger {
          background: linear-gradient(135deg, #ff4757 0%, #cc0033 100%);
        }
        
        button.warning {
          background: linear-gradient(135deg, #ffa502 0%, #cc7b00 100%);
        }
        
        button.success {
          background: linear-gradient(135deg, #00d4ff 0%, #0099cc 100%);
        }
        
        /* Table */
        .table-container {
          background: linear-gradient(135deg, #0f3460 0%, #1a1a2e 100%);
          border-radius: 15px;
          padding: 25px;
          overflow-x: auto;
          border: 1px solid rgba(255,255,255,0.1);
        }
        
        table {
          width: 100%;
          border-collapse: collapse;
        }
        
        th {
          text-align: left;
          padding: 15px;
          background: rgba(0,212,255,0.1);
          color: #00d4ff;
          font-weight: 600;
        }
        
        td {
          padding: 15px;
          border-bottom: 1px solid rgba(255,255,255,0.1);
          color: #e0e0e0;
        }
        
        .token-cell {
          font-family: monospace;
          font-size: 12px;
          max-width: 250px;
          word-break: break-all;
        }
        
        .badge {
          display: inline-block;
          padding: 5px 12px;
          border-radius: 20px;
          font-size: 12px;
          font-weight: 600;
        }
        
        .badge.active {
          background: rgba(0,255,0,0.2);
          color: #00ff00;
        }
        
        .badge.inactive {
          background: rgba(255,0,0,0.2);
          color: #ff4444;
        }
        
        .badge.warning {
          background: rgba(255,165,0,0.2);
          color: #ffa502;
        }
        
        .usage-bar-container {
          background: #1a1a2e;
          border-radius: 10px;
          height: 8px;
          width: 100px;
          overflow: hidden;
        }
        
        .usage-bar-fill {
          background: #00d4ff;
          height: 100%;
          border-radius: 10px;
          transition: width 0.3s;
        }
        
        .usage-bar-fill.warning {
          background: #ffa502;
        }
        
        .usage-bar-fill.danger {
          background: #ff4757;
        }
        
        .delete-btn {
          background: #ff4757;
          padding: 5px 10px;
          font-size: 11px;
        }
        
        .delete-btn:hover {
          background: #cc0033;
        }
        
        .toast {
          position: fixed;
          bottom: 20px;
          right: 20px;
          padding: 12px 20px;
          border-radius: 10px;
          z-index: 1000;
          animation: slideIn 0.3s ease;
        }
        
        @keyframes slideIn {
          from {
            transform: translateX(100%);
            opacity: 0;
          }
          to {
            transform: translateX(0);
            opacity: 1;
          }
        }
        
        .refresh-info {
          text-align: right;
          font-size: 12px;
          color: #a0a0a0;
          margin-bottom: 15px;
        }
        
        @media (max-width: 768px) {
          .stats-grid {
            grid-template-columns: repeat(2, 1fr);
          }
          td, th {
            font-size: 12px;
            padding: 10px;
          }
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1>🔑 Apify Token Manager</h1>
          <p class="subtitle">Auto-deactivates tokens at 4.90 USD | Syncs with Apify monthly cycles</p>
        </div>
        
        <div class="stats-grid" id="statsGrid">
          <div class="stat-card">
            <div class="stat-value" id="totalTokens">-</div>
            <div class="stat-label">Total Tokens</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" id="activeTokens">-</div>
            <div class="stat-label">Active Tokens</div>
          </div>
          <div class="stat-card">
            <div class="stat-value" id="inactiveTokens">-</div>
            <div class="stat-label">Inactive Tokens</div>
          </div>
         
        </div>
        
        <div class="add-section">
          <h3 class="section-title">➕ Add New Token</h3>
          <div class="input-group">
            <input type="text" id="newTokenInput" placeholder="Enter Apify API token..." />
            <button onclick="addToken()">Add Token</button>
            <button onclick="checkAllTokens()" class="warning">🔍 Check All Tokens</button>
          </div>
        </div>
        
        <div class="table-container">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; flex-wrap: wrap; gap: 10px;">
            <h3 class="section-title" style="margin-bottom: 0;">📋 Token List</h3>
            <div style="display: flex; gap: 10px;">
              <button onclick="refreshData()" class="success">🔄 Refresh</button>
            </div>
          </div>
          <div class="refresh-info" id="lastUpdateTime">Last updated: --</div>
          <div id="tokensTable">
            <div style="text-align: center; padding: 40px;">Loading tokens...</div>
          </div>
        </div>
      </div>
      
      <script>
        let autoRefreshInterval;
        
        async function loadStats() {
          try {
            const res = await fetch('/api/tokens/stats');
            const result = await res.json();
            if (result.success) {
              document.getElementById('totalTokens').textContent = result.data.total || 0;
              document.getElementById('activeTokens').textContent = result.data.active || 0;
              document.getElementById('inactiveTokens').textContent = result.data.inactive || 0;
              document.getElementById('avgUsage').textContent = (result.data.avg_usage || 0).toFixed(4);
            }
          } catch (err) {
            console.error('Error loading stats:', err);
          }
        }
        
        async function loadTokens() {
          try {
            const res = await fetch('/api/tokens');
            const result = await res.json();
            if (result.success) {
              renderTable(result.data);
              document.getElementById('lastUpdateTime').innerHTML = \`Last updated: \${new Date().toLocaleString()}\`;
            }
          } catch (err) {
            console.error('Error loading tokens:', err);
            document.getElementById('tokensTable').innerHTML = '<div style="text-align:center;padding:40px;">Error loading tokens. Make sure server is running.</div>';
          }
        }
        
        function renderTable(tokens) {
          if (!tokens || tokens.length === 0) {
            document.getElementById('tokensTable').innerHTML = '<div style="text-align:center;padding:40px;">No tokens found. Add your first token!</div>';
            return;
          }
          
          const html = \`
            <table>
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Token</th>
                  <th>Status</th>
                  <th>Usage (USD)</th>
                  <th>Cycle Start</th>
                  <th>Cycle End</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                \${tokens.map(t => {
                  const usagePercent = (t.current_usage / 4.9) * 100;
                  let fillClass = '';
                  let statusBadge = '';
                  
                  if (usagePercent >= 100 || t.is_limit_exceeded) {
                    statusBadge = '<span class="badge inactive">INACTIVE</span>';
                    fillClass = 'danger';
                  } else if (usagePercent >= 90) {
                    statusBadge = '<span class="badge warning">⚠️ NEAR LIMIT</span>';
                    fillClass = 'danger';
                  } else if (usagePercent >= 70) {
                    statusBadge = '<span class="badge warning">⚠️ HIGH USAGE</span>';
                    fillClass = 'warning';
                  } else {
                    statusBadge = '<span class="badge active">ACTIVE</span>';
                    fillClass = '';
                  }
                  
                  const cycleStart = t.cycle_start ? new Date(t.cycle_start).toLocaleDateString() : 'N/A';
                  const cycleEnd = t.cycle_end ? new Date(t.cycle_end).toLocaleDateString() : 'N/A';
                  
                  return \`
                    <tr>
                      <td>\${t.id}</td>
                      <td class="token-cell">\${maskToken(t.token)}</td>
                      <td>\${statusBadge}</td>
                      <td>
                        <div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">
                          <span style="font-weight:bold;min-width:80px;">\${t.current_usage?.toFixed(6)} / 4.90</span>
                          <div class="usage-bar-container">
                            <div class="usage-bar-fill \${fillClass}" style="width: \${Math.min(usagePercent, 100)}%"></div>
                          </div>
                        </div>
                      </td>
                      <td>\${cycleStart}</td>
                      <td>\${cycleEnd}</td>
                      <td>
                        <button class="delete-btn" onclick="deleteToken(\${t.id})">Delete</button>
                      </td>
                    </tr>
                  \`;
                }).join('')}
              </tbody>
            </table>
          \`;
          
          document.getElementById('tokensTable').innerHTML = html;
        }
        
        function maskToken(token) {
          if (!token) return 'N/A';
          if (token.length <= 40) return token;
          return token.substring(0, 25) + '...' + token.substring(token.length - 15);
        }
        
        async function addToken() {
          const token = document.getElementById('newTokenInput').value.trim();
          if (!token) {
            showToast('Please enter a token', 'error');
            return;
          }
          
          showToast('Adding token...', 'info');
          
          try {
            const res = await fetch('/api/tokens', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token })
            });
            const result = await res.json();
            
            if (result.success) {
              showToast('Token added successfully!', 'success');
              document.getElementById('newTokenInput').value = '';
              refreshData();
            } else {
              showToast(result.error || 'Failed to add token', 'error');
            }
          } catch (err) {
            showToast('Error adding token', 'error');
          }
        }
        
        async function checkAllTokens() {
          showToast('Checking all tokens against Apify API...', 'info');
          
          try {
            const res = await fetch('/api/tokens/check-all', { method: 'POST' });
            const result = await res.json();
            
            if (result.success) {
              showToast('All tokens checked and updated!', 'success');
              refreshData();
            } else {
              showToast(result.error || 'Check failed', 'error');
            }
          } catch (err) {
            showToast('Error checking tokens', 'error');
          }
        }
        
        async function deleteToken(id) {
          if (!confirm('Are you sure you want to delete this token?')) return;
          
          try {
            const res = await fetch(\`/api/tokens/\${id}\`, { method: 'DELETE' });
            const result = await res.json();
            
            if (result.success) {
              showToast('Token deleted!', 'success');
              refreshData();
            } else {
              showToast(result.error || 'Delete failed', 'error');
            }
          } catch (err) {
            showToast('Error deleting token', 'error');
          }
        }
        
        async function refreshData() {
          await loadStats();
          await loadTokens();
        }
        
        function showToast(message, type) {
          const toast = document.createElement('div');
          toast.className = 'toast';
          toast.textContent = message;
          
          if (type === 'success') toast.style.background = '#00d4ff';
          else if (type === 'error') toast.style.background = '#ff4757';
          else toast.style.background = '#ffa502';
          
          document.body.appendChild(toast);
          setTimeout(() => {
            toast.remove();
          }, 3000);
        }
        
        // Initial load
        refreshData();
        
        // Auto refresh every 30 seconds
        autoRefreshInterval = setInterval(refreshData, 30000);
      </script>
    </body>
    </html>
  `);
});

// ============ START SERVER ============

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════════╗
║            🚀 Apify Token Manager Server Started              ║
╠═══════════════════════════════════════════════════════════════╣
║                                                               ║
║   📍 URL: http://localhost:${PORT}                             ║
║                                                               ║
║   ⚙️  Features:                                               ║
║      • Auto-checks tokens every 5 minutes                    ║
║      • Deactivates tokens at 4.90 USD                        ║
║      • Syncs cycle dates from Apify API                      ║
║      • Real-time usage display                               ║
║                                                               ║
║   📡 API Endpoints:                                           ║
║      GET  /api/tokens        - List all tokens               ║
║      POST /api/tokens        - Add new token                 ║
║      POST /api/tokens/check-all - Force check all            ║
║      DELETE /api/tokens/:id  - Delete token                  ║
║      GET  /api/tokens/stats  - Statistics                    ║
║      GET  /api/health        - Health check                  ║
║                                                               ║
╚═══════════════════════════════════════════════════════════════╝
  `);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🛑 Shutting down server...');
  process.exit(0);
});
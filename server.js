const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http');
const https = require('https');
const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const app = express();
const PORT = 3001;
const DATA_DIR = path.join(__dirname, 'data');
const VENDORS_FILE = path.join(DATA_DIR, 'vendors.json');
const GATEWAY_CONFIG_FILE = path.join(DATA_DIR, 'gateway.json');

const DEFAULT_GATEWAY_KEY = 'cs-sk-c8046f4c-41c7-4b89-b1e7-fdf19eb3e75e';
const DEFAULT_GATEWAY_CONFIG = {
  apiKeys: [DEFAULT_GATEWAY_KEY],
  users: [{ username: 'admin', password: 'admin123' }]
};
const REQUEST_TIMEOUT = 60000;
const KEEP_ALIVE_OPTIONS = {
  keepAlive: true,
  maxSockets: 100,
  maxFreeSockets: 20
};
const httpKeepAliveAgent = new http.Agent(KEEP_ALIVE_OPTIONS);
const httpsKeepAliveAgent = new https.Agent(KEEP_ALIVE_OPTIONS);

app.use(cors());
app.use('/v1', express.raw({ type: '*/*', limit: '100mb' }));
app.use((req, res, next) => {
  if (req.path.startsWith('/v1/')) return next();
  return bodyParser.json({ limit: '100mb' })(req, res, next);
});
app.use((req, res, next) => {
  if (req.path.startsWith('/v1/')) return next();
  return bodyParser.urlencoded({ limit: '100mb', extended: true })(req, res, next);
});

const sessions = new Map();
const SESSION_COOKIE_NAME = 'sessionToken';
let vendorsCache = [];
let vendorsCacheReady = false;
let vendorByIdCache = new Map();
let enabledVendorsCache = [];
let modelVendorCache = new Map();
let gatewayConfigCache = DEFAULT_GATEWAY_CONFIG;
let gatewayConfigReady = false;
let gatewayApiKeySet = new Set(DEFAULT_GATEWAY_CONFIG.apiKeys);

function cloneJsonData(data) {
  return data == null ? data : JSON.parse(JSON.stringify(data));
}

function setVendorsCache(vendors = []) {
  vendorsCache = Array.isArray(vendors) ? vendors : [];
  vendorsCacheReady = true;
  vendorByIdCache = new Map();
  enabledVendorsCache = [];
  modelVendorCache = new Map();

  vendorsCache.forEach(vendor => {
    const vendorId = String(vendor.id || '');
    if (vendorId) {
      vendorByIdCache.set(vendorId, vendor);
    }

    if (vendor.enabled === false || !vendor.apiKey || !vendor.apiUrl) {
      return;
    }

    enabledVendorsCache.push(vendor);
    (vendor.models || []).forEach(model => {
      const modelName = String(model?.name || '').trim();
      if (modelName && !modelVendorCache.has(modelName)) {
        modelVendorCache.set(modelName, vendor);
      }
    });
  });
}

function setGatewayConfigCache(config = DEFAULT_GATEWAY_CONFIG) {
  const apiKeys = Array.isArray(config?.apiKeys) && config.apiKeys.length ? config.apiKeys : DEFAULT_GATEWAY_CONFIG.apiKeys;
  const users = Array.isArray(config?.users) ? config.users : DEFAULT_GATEWAY_CONFIG.users;
  gatewayConfigCache = { apiKeys, users };
  gatewayConfigReady = true;
  gatewayApiKeySet = new Set(apiKeys);
}

function selectProxyVendor(requestBody = {}) {
  const modelName = String(requestBody?.model || '').trim();
  if (modelName) {
    const matchedVendor = modelVendorCache.get(modelName);
    if (matchedVendor) {
      return matchedVendor;
    }
  }

  return enabledVendorsCache[0] || null;
}

function getProxyRequestBody(req) {
  if (req.proxyRequestBody) {
    return req.proxyRequestBody;
  }

  if (Buffer.isBuffer(req.body)) {
    req.rawBody = req.body;
    const bodyText = req.body.length ? req.body.toString('utf8') : '';
    req.proxyRequestBody = bodyText ? JSON.parse(bodyText) : {};
    return req.proxyRequestBody;
  }

  if (Buffer.isBuffer(req.rawBody)) {
    const bodyText = req.rawBody.length ? req.rawBody.toString('utf8') : '';
    req.proxyRequestBody = bodyText ? JSON.parse(bodyText) : {};
    return req.proxyRequestBody;
  }

  req.proxyRequestBody = req.body || {};
  return req.proxyRequestBody;
}

function parseCookies(cookieHeader = '') {
  return cookieHeader
    .split(';')
    .map(part => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf('=');
      if (separatorIndex === -1) return cookies;
      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      if (key) {
        cookies[key] = decodeURIComponent(value);
      }
      return cookies;
    }, {});
}

function getTokenFromRequest(req) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.replace('Bearer ', '').trim();
  }

  if (req.query.token) {
    return String(req.query.token).trim();
  }

  const cookies = parseCookies(req.headers.cookie || '');
  return cookies[SESSION_COOKIE_NAME] || null;
}

function getValidSession(token) {
  if (!token) return null;

  const session = sessions.get(token);
  if (!session) return null;

  if (session.expiresAt <= Date.now()) {
    sessions.delete(token);
    return null;
  }

  return session;
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000;

async function init() {
  try {
    await fs.access(DATA_DIR);
  } catch {
    await fs.mkdir(DATA_DIR, { recursive: true });
  }
  
  try {
    await fs.access(GATEWAY_CONFIG_FILE);
  } catch {
    await fs.writeFile(GATEWAY_CONFIG_FILE, JSON.stringify(DEFAULT_GATEWAY_CONFIG, null, 2));
  }
  
  try {
    await fs.access(VENDORS_FILE);
  } catch {
    await fs.writeFile(VENDORS_FILE, JSON.stringify([], null, 2));
  }

  await readFile(GATEWAY_CONFIG_FILE, DEFAULT_GATEWAY_CONFIG);
  await readFile(VENDORS_FILE, []);
}

async function readFile(filePath, defaultValue) {
  if (filePath === VENDORS_FILE && vendorsCacheReady) {
    return cloneJsonData(vendorsCache);
  }

  if (filePath === GATEWAY_CONFIG_FILE && gatewayConfigReady) {
    return cloneJsonData(gatewayConfigCache);
  }

  try {
    const data = await fs.readFile(filePath, 'utf8');
    const parsed = JSON.parse(data);

    if (filePath === VENDORS_FILE) {
      setVendorsCache(parsed);
    } else if (filePath === GATEWAY_CONFIG_FILE) {
      setGatewayConfigCache(parsed);
    }

    return cloneJsonData(parsed);
  } catch {
    if (filePath === VENDORS_FILE) {
      setVendorsCache(defaultValue);
    } else if (filePath === GATEWAY_CONFIG_FILE) {
      setGatewayConfigCache(defaultValue);
    }

    return cloneJsonData(defaultValue);
  }
}

async function writeFile(filePath, data) {
  try {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf8');

    if (filePath === VENDORS_FILE) {
      setVendorsCache(cloneJsonData(data));
    } else if (filePath === GATEWAY_CONFIG_FILE) {
      setGatewayConfigCache(cloneJsonData(data));
    }

    return true;
  } catch (error) {
    console.error('Write error:', error);
    return false;
  }
}

function normalizeProviderType(providerType, apiUrl = '') {
  if (providerType) return providerType;
  const safeUrl = String(apiUrl || '').toLowerCase();
  if (safeUrl.includes('/zen') || safeUrl.includes('/responses')) return 'OpenAI-Response';
  return 'OpenAI';
}

function normalizeEndpointPath(endpointPath = '') {
  const safePath = String(endpointPath || '').trim();
  if (!safePath) return '';
  const withLeadingSlash = safePath.startsWith('/') ? safePath : `/${safePath}`;
  return withLeadingSlash.replace(/^\/v\d+(?=\/)/i, '');
}

function buildVendorEndpoint(apiUrl, endpointPath) {
  const safe = String(apiUrl || '').replace(/\/+$/, '');
  const safePath = normalizeEndpointPath(endpointPath);
  if (!safe) return '';
  if (safe.endsWith(safePath)) return safe;
  if (/\/v\d+$/i.test(safe)) return `${safe}${safePath}`;
  return `${safe}/v1${safePath}`;
}

function getTransportForUrl(targetUrl) {
  const parsedUrl = new URL(targetUrl);
  const isHttps = parsedUrl.protocol === 'https:';
  return {
    parsedUrl,
    transport: isHttps ? https : http,
    agent: isHttps ? httpsKeepAliveAgent : httpKeepAliveAgent
  };
}

function buildForwardHeaders(protocol, apiKey, incomingHeaders = {}) {
  if (protocol === 'messages') {
    const headers = {
      'x-api-key': apiKey,
      'anthropic-version': incomingHeaders['anthropic-version'] || '2023-06-01',
      'Content-Type': 'application/json'
    };

    if (incomingHeaders['anthropic-beta']) {
      headers['anthropic-beta'] = incomingHeaders['anthropic-beta'];
    }

    return headers;
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json'
  };

  if (incomingHeaders.accept) {
    headers.Accept = incomingHeaders.accept;
  }

  if (incomingHeaders['openai-beta']) {
    headers['OpenAI-Beta'] = incomingHeaders['openai-beta'];
  }

  return headers;
}

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade'
]);

function isStreamingRequest(body = {}) {
  return body?.stream === true;
}

function applyUpstreamHeaders(res, headers = {}, isStream = false) {
  Object.entries(headers).forEach(([headerName, headerValue]) => {
    const normalizedName = String(headerName || '').toLowerCase();
    if (!normalizedName || headerValue == null) return;
    if (HOP_BY_HOP_RESPONSE_HEADERS.has(normalizedName)) return;
    if (isStream && normalizedName === 'content-length') return;
    res.setHeader(headerName, headerValue);
  });
}

function normalizeResponseHeaders(headers = {}) {
  const normalizedHeaders = {};

  Object.entries(headers).forEach(([headerName, headerValue]) => {
    const normalizedName = String(headerName || '').toLowerCase();
    if (!normalizedName || headerValue == null) return;
    if (HOP_BY_HOP_RESPONSE_HEADERS.has(normalizedName)) return;
    normalizedHeaders[headerName] = headerValue;
  });

  return normalizedHeaders;
}

async function readResponseBuffer(responseStream) {
  const chunks = [];

  await new Promise((resolve, reject) => {
    responseStream.on('data', chunk => chunks.push(chunk));
    responseStream.on('end', resolve);
    responseStream.on('error', reject);
  });

  return Buffer.concat(chunks);
}

function sendProxyError(res, message, status = 500) {
  if (res.headersSent) {
    res.end();
    return;
  }

  res.status(status).json({
    error: {
      message,
      type: 'api_error'
    }
  });
}

async function proxyHttpRequest({ endpoint, method = 'POST', headers, body, stream, signal }) {
  const { parsedUrl, transport, agent } = getTransportForUrl(endpoint);

  return new Promise((resolve, reject) => {
    const requestOptions = {
      protocol: parsedUrl.protocol,
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
      path: `${parsedUrl.pathname}${parsedUrl.search}`,
      method,
      headers,
      agent
    };

    const upstreamRequest = transport.request(requestOptions, async upstreamResponse => {
      const responseHeaders = normalizeResponseHeaders(upstreamResponse.headers);
      if (stream) {
        resolve({
          status: upstreamResponse.statusCode || 500,
          headers: responseHeaders,
          data: upstreamResponse
        });
        return;
      }

      try {
        const responseBuffer = await readResponseBuffer(upstreamResponse);
        resolve({
          status: upstreamResponse.statusCode || 500,
          headers: responseHeaders,
          data: responseBuffer
        });
      } catch (error) {
        reject(error);
      }
    });

    upstreamRequest.setTimeout(REQUEST_TIMEOUT, () => {
      upstreamRequest.destroy(new Error('Upstream request timeout'));
    });

    upstreamRequest.on('error', reject);

    const abortRequest = () => {
      upstreamRequest.destroy(new Error('Client request aborted'));
    };

    if (signal) {
      if (signal.aborted) {
        abortRequest();
      } else {
        signal.addEventListener('abort', abortRequest, { once: true });
      }
    }

    if (body == null) {
      upstreamRequest.end();
      return;
    }

    if (Buffer.isBuffer(body) || typeof body === 'string') {
      upstreamRequest.end(body);
      return;
    }

    upstreamRequest.end(JSON.stringify(body));
  });
}

async function sendUpstreamResponse(res, upstreamResponse, isStream = false) {
  res.status(upstreamResponse.status);
  applyUpstreamHeaders(res, upstreamResponse.headers, isStream);

  if (!isStream) {
    res.send(upstreamResponse.data);
    return;
  }

  if (typeof res.flushHeaders === 'function') {
    res.flushHeaders();
  }

  await new Promise((resolve, reject) => {
    const upstreamStream = upstreamResponse.data;

    upstreamStream.on('error', reject);
    res.on('error', reject);
    upstreamStream.on('end', resolve);
    res.on('close', resolve);

    upstreamStream.pipe(res);
  });
}

function getPrimaryEnabledVendor(vendors = []) {
  return vendors.find(v => v.enabled !== false && v.apiKey && v.apiUrl) || null;
}

async function proxyVendorRequest(req, res, endpointPath, protocol) {
  const isValidKey = verifyApiKey(req);
  if (!isValidKey) {
    return res.status(401).json({ error: { message: 'Invalid API Key', type: 'invalid_request_error' } });
  }

  const requestBody = getProxyRequestBody(req);
  const vendor = selectProxyVendor(requestBody);

  if (!vendor) {
    return res.status(500).json({ error: { message: 'No enabled vendors configured', type: 'api_error' } });
  }

  const stream = isStreamingRequest(requestBody);
  const endpoint = buildVendorEndpoint(vendor.apiUrl, endpointPath);
  const abortController = new AbortController();
  const abortUpstream = () => {
    if (!abortController.signal.aborted) {
      abortController.abort();
    }
  };
  const abortIfClientClosedEarly = () => {
    if (!res.writableEnded) {
      abortUpstream();
    }
  };

  req.on('aborted', abortUpstream);
  res.on('close', abortIfClientClosedEarly);

  try {
    const upstreamBody = Buffer.isBuffer(req.rawBody)
      ? req.rawBody
      : Buffer.isBuffer(req.body)
        ? req.body
        : requestBody;
    const upstreamResponse = await proxyHttpRequest({
      endpoint,
      method: 'POST',
      headers: buildForwardHeaders(protocol, vendor.apiKey, req.headers),
      body: upstreamBody,
      stream,
      signal: abortController.signal
    });

    await sendUpstreamResponse(res, upstreamResponse, stream);
  } finally {
    req.off('aborted', abortUpstream);
    res.off('close', abortIfClientClosedEarly);
  }
}

// 添加日志中间件
app.use((req, res, next) => {
  if (req.path.startsWith('/v1/') || req.path === '/health') {
    return next();
  }
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ============== 根路径和兼容性端点（最优先） ==============
app.get('/', async (req, res, next) => {
  const accept = req.headers.accept || '';
  if (accept.includes('application/json') || accept.includes('*/*')) {
    res.json({
      object: 'list',
      data: []
    });
  } else {
    next();
  }
});

app.use((req, res, next) => {
  if (req.method === 'OPTIONS') {
    res.status(204).end();
  } else {
    next();
  }
});

// ============== 开放 API 端点（无需认证） ==============
app.post('/api/login', async (req, res) => {
  console.log('Login request received:', req.body);
  try {
    const { username, password, rememberMe } = req.body;
    
    if (!username || !password) {
      console.log('Missing username or password');
      return res.status(400).json({ success: false, error: '用户名和密码必填' });
    }
    
    // 简化逻辑，直接检查默认账户
    if (username === 'admin' && password === 'admin123') {
      const token = generateToken();
      const persistentLogin = rememberMe !== false;
      const expiresAt = persistentLogin ? Date.now() + SEVEN_DAYS : Date.now() + 24 * 60 * 60 * 1000;
      
      sessions.set(token, {
        username: 'admin',
        expiresAt,
        persistentLogin
      });
      
      console.log('Login successful for:', username);
      if (persistentLogin) {
        res.cookie(SESSION_COOKIE_NAME, token, {
          httpOnly: true,
          sameSite: 'lax',
          maxAge: SEVEN_DAYS,
          path: '/'
        });
      } else {
        res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
      }
      res.json({ success: true, token, expiresAt });
    } else {
      console.log('Login failed for:', username);
      res.status(401).json({ success: false, error: '用户名或密码错误' });
    }
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ success: false, error: '服务器错误' });
  }
});

app.post('/api/logout', (req, res) => {
  const token = getTokenFromRequest(req);
  if (token) {
    sessions.delete(token);
  }
  res.clearCookie(SESSION_COOKIE_NAME, { path: '/' });
  res.json({ success: true });
});

app.get('/api/session', (req, res) => {
  const token = getTokenFromRequest(req);
  const session = getValidSession(token);

  if (session) {
    return res.json({ valid: true, username: session.username });
  }
  
  res.json({ valid: false });
});

// OpenAI 兼容的 models 端点
app.get('/v1/models', async (req, res) => {
  try {
    const vendors = await readFile(VENDORS_FILE, []);
    const allModels = [];
    
    vendors.forEach(vendor => {
      if (vendor.enabled !== false && vendor.models) {
        vendor.models.forEach(model => {
          allModels.push({
            id: model.name,
            object: 'model',
            created: Math.floor(Date.now() / 1000),
            owned_by: vendor.name
          });
        });
      }
    });
    
    return res.json({ object: 'list', data: allModels });
  } catch (error) {
    console.error('Models error:', error);
    res.status(500).json({ error: { message: 'Failed to get models' } });
  }
});



app.get('/v1/health', async (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/health', async (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

function verifyApiKey(req) {
  const token = getTokenFromRequest(req);
  if (!token) return false;

  return gatewayApiKeySet.has(token);
}

// OpenAI 兼容的 chat completions 端点
app.post('/v1/chat/completions', async (req, res) => {
  try {
    await proxyVendorRequest(req, res, '/chat/completions', 'chat');
  } catch (error) {
    console.error('Chat completions error:', error.message);
    sendProxyError(res, error.message);
  }
});

// OpenAI 兼容的 responses 端点
app.post('/v1/responses', async (req, res) => {
  try {
    await proxyVendorRequest(req, res, '/responses', 'responses');
  } catch (error) {
    console.error('Responses error:', error.message);
    sendProxyError(res, error.message);
  }
});

// Anthropic Messages 协议端点
app.post('/v1/messages', async (req, res) => {
  try {
    await proxyVendorRequest(req, res, '/messages', 'messages');
  } catch (error) {
    console.error('Messages error:', error.message);
    sendProxyError(res, error.message);
  }
});

// ============== Session 认证中间件 ==============
function verifySession(req, res, next) {
  const pathname = req.path;
  
  // 已经处理过的端点直接跳过
  if (pathname.startsWith('/v1/') ||
      pathname === '/health' ||
      pathname === '/login.html' ||
      pathname === '/api/login' ||
      pathname === '/api/logout' ||
      pathname === '/api/session') {
    return next();
  }
  
  const token = getTokenFromRequest(req);
  const session = getValidSession(token);
  const isValidSession = Boolean(session);

  if (session) {
    req.session = session;
  }
  
  if (pathname.startsWith('/api/')) {
    if (!isValidSession) {
      if (req.accepts('html')) {
        return res.redirect('/login.html');
      } else {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }
  }
  
  next();
}

app.use(verifySession);

// ============== 受保护的 API 端点 ==============
app.get('/api/vendors', async (req, res) => {
  const vendors = await readFile(VENDORS_FILE, []);
  res.json({ vendors });
});

app.post('/api/vendors', async (req, res) => {
  const vendors = await readFile(VENDORS_FILE, []);
  const newVendor = {
    id: Date.now().toString(),
    name: req.body.name,
    icon: req.body.icon || req.body.name.charAt(0).toUpperCase(),
    enabled: req.body.enabled !== false,
    providerType: req.body.providerType || 'OpenAI',
    apiKey: req.body.apiKey || '',
    apiUrl: req.body.apiUrl || '',
    models: [],
    createdAt: new Date().toISOString()
  };
  vendors.push(newVendor);
  await writeFile(VENDORS_FILE, vendors);
  res.json({ vendor: newVendor });
});

app.put('/api/vendors/:id', async (req, res) => {
  const vendors = await readFile(VENDORS_FILE, []);
  const index = vendors.findIndex(v => v.id === req.params.id);
  if (index === -1) {
    return res.status(404).json({ error: 'Vendor not found' });
  }
  vendors[index] = { ...vendors[index], ...req.body, id: req.params.id, updatedAt: new Date().toISOString() };
  await writeFile(VENDORS_FILE, vendors);
  res.json({ vendor: vendors[index] });
});

app.delete('/api/vendors/:id', async (req, res) => {
  const vendors = await readFile(VENDORS_FILE, []);
  const filtered = vendors.filter(v => v.id !== req.params.id);
  await writeFile(VENDORS_FILE, filtered);
  res.json({ success: true });
});

app.get('/api/vendors/:vendorId/models', async (req, res) => {
  const vendors = await readFile(VENDORS_FILE, []);
  const vendor = vendors.find(v => v.id === req.params.vendorId);
  if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
  res.json({ models: vendor.models || [] });
});

app.post('/api/vendors/:vendorId/fetch-all-models', async (req, res) => {
  try {
    const vendors = await readFile(VENDORS_FILE, []);
    const vendor = vendors.find(v => v.id === req.params.vendorId);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    const apiUrl = req.body.apiUrl || vendor.apiUrl;
    if (!apiUrl) return res.status(400).json({ error: 'API URL not configured' });
    
    const apiKey = req.body.apiKey || vendor.apiKey;
    if (!apiKey) return res.status(400).json({ error: 'API Key is required' });
    
    const response = await axios.get(buildVendorEndpoint(apiUrl, '/models'), {
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      timeout: 15000
    });
    
    let models = [];
    if (response.data.data) {
      models = response.data.data.map(m => ({ group: m.owned_by || 'default', name: m.id, tags: [] }));
    } else if (response.data.models) {
      models = response.data.models.map(m => ({ group: m.owned_by || 'default', name: m.id || m.name, tags: [] }));
    } else if (Array.isArray(response.data)) {
      models = response.data.map(m => ({ group: m.owned_by || 'default', name: m.id || m.name, tags: [] }));
    }
    
    res.json({ success: true, models, count: models.length });
  } catch (error) {
    console.error('Fetch all models error:', error);
    res.status(500).json({ error: error.message, details: error.response?.data });
  }
});

app.post('/api/vendors/:vendorId/test-model', async (req, res) => {
  try {
    const vendors = await readFile(VENDORS_FILE, []);
    const vendor = vendors.find(v => v.id === req.params.vendorId);
    if (!vendor) return res.status(404).json({ error: 'Vendor not found' });
    const apiUrl = req.body.apiUrl || vendor.apiUrl;
    if (!apiUrl) return res.status(400).json({ error: 'API URL not configured' });

    const apiKey = req.body.apiKey || vendor.apiKey;
    if (!apiKey) return res.status(400).json({ error: 'API Key is required' });

    const model = String(req.body.model || '').trim();
    if (!model) return res.status(400).json({ error: 'Model is required' });

    const providerType = normalizeProviderType(vendor.providerType, apiUrl);
    const endpointPath = providerType === 'Anthropic' ? '/messages' : providerType === 'OpenAI-Response' ? '/responses' : '/chat/completions';
    const payload = providerType === 'Anthropic'
      ? {
          model,
          max_tokens: 10,
          messages: [{ role: 'user', content: 'hello' }]
        }
      : {
          model,
          messages: [{ role: 'user', content: 'hello' }],
          max_tokens: 10
        };

    const response = await axios.post(buildVendorEndpoint(apiUrl, endpointPath), payload, {
      headers: buildForwardHeaders(providerType === 'Anthropic' ? 'messages' : 'chat', apiKey),
      timeout: 15000
    });

    res.json({ success: true, providerType, endpointPath, data: response.data });
  } catch (error) {
    console.error('Test model error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      error: error.response?.data?.error?.message || error.response?.data?.error || error.message,
      details: error.response?.data || null
    });
  }
});

app.post('/api/vendors/:vendorId/models', async (req, res) => {
  const vendors = await readFile(VENDORS_FILE, []);
  const vendorIndex = vendors.findIndex(v => v.id === req.params.vendorId);
  if (vendorIndex === -1) return res.status(404).json({ error: 'Vendor not found' });
  const newModel = { group: req.body.group || 'custom', name: req.body.name, tags: req.body.tags || [] };
  if (!vendors[vendorIndex].models) vendors[vendorIndex].models = [];
  const exists = vendors[vendorIndex].models.some(m => m.name === newModel.name);
  if (!exists) {
    vendors[vendorIndex].models.push(newModel);
    await writeFile(VENDORS_FILE, vendors);
  }
  res.json({ model: newModel, existed: exists });
});

app.post('/api/vendors/:vendorId/models/batch', async (req, res) => {
  const vendors = await readFile(VENDORS_FILE, []);
  const vendorIndex = vendors.findIndex(v => v.id === req.params.vendorId);
  if (vendorIndex === -1) return res.status(404).json({ error: 'Vendor not found' });
  const models = req.body.models || [];
  if (!vendors[vendorIndex].models) vendors[vendorIndex].models = [];
  let addedCount = 0;
  models.forEach(newModel => {
    const exists = vendors[vendorIndex].models.some(m => m.name === newModel.name);
    if (!exists) {
      vendors[vendorIndex].models.push({
        group: newModel.group || 'custom',
        name: newModel.name,
        tags: newModel.tags || []
      });
      addedCount++;
    }
  });
  await writeFile(VENDORS_FILE, vendors);
  res.json({ success: true, added: addedCount, total: models.length });
});

app.put('/api/vendors/:vendorId/models/:modelIndex', async (req, res) => {
  const vendors = await readFile(VENDORS_FILE, []);
  const vendorIndex = vendors.findIndex(v => v.id === req.params.vendorId);
  if (vendorIndex === -1) return res.status(404).json({ error: 'Vendor not found' });

  const modelIndex = parseInt(req.params.modelIndex, 10);
  if (!vendors[vendorIndex].models || !vendors[vendorIndex].models[modelIndex]) {
    return res.status(404).json({ error: 'Model not found' });
  }

  const currentModel = vendors[vendorIndex].models[modelIndex];
  const updatedModel = {
    ...currentModel,
    group: req.body.group || currentModel.group || 'custom',
    name: req.body.name || currentModel.name,
    tags: Array.isArray(req.body.tags) ? req.body.tags : currentModel.tags || []
  };

  vendors[vendorIndex].models[modelIndex] = updatedModel;
  await writeFile(VENDORS_FILE, vendors);
  res.json({ success: true, model: updatedModel });
});

app.delete('/api/vendors/:vendorId/models/:modelIndex', async (req, res) => {
  const vendors = await readFile(VENDORS_FILE, []);
  const vendorIndex = vendors.findIndex(v => v.id === req.params.vendorId);
  if (vendorIndex === -1) return res.status(404).json({ error: 'Vendor not found' });
  const modelIndex = parseInt(req.params.modelIndex);
  if (!vendors[vendorIndex].models || !vendors[vendorIndex].models[modelIndex]) {
    return res.status(404).json({ error: 'Model not found' });
  }
  vendors[vendorIndex].models.splice(modelIndex, 1);
  await writeFile(VENDORS_FILE, vendors);
  res.json({ success: true });
});

app.get('/api/gateway/keys', async (req, res) => {
  try {
    const config = await readFile(GATEWAY_CONFIG_FILE, { apiKeys: [DEFAULT_GATEWAY_KEY] });
    res.json({ apiKeys: config.apiKeys || [DEFAULT_GATEWAY_KEY] });
  } catch (error) {
    console.error('Get keys error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/gateway/keys', async (req, res) => {
  try {
    const config = await readFile(GATEWAY_CONFIG_FILE, { apiKeys: [DEFAULT_GATEWAY_KEY] });
    const newKey = req.body.apiKey;
    
    if (!newKey) {
      return res.status(400).json({ error: 'API Key is required' });
    }
    
    if (!config.apiKeys.includes(newKey)) {
      config.apiKeys.push(newKey);
      await writeFile(GATEWAY_CONFIG_FILE, config);
    }
    
    res.json({ success: true, apiKeys: config.apiKeys });
  } catch (error) {
    console.error('Save key error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.delete('/api/gateway/keys/:index', async (req, res) => {
  try {
    const config = await readFile(GATEWAY_CONFIG_FILE, { apiKeys: [DEFAULT_GATEWAY_KEY] });
    const index = parseInt(req.params.index);
    
    if (index < 0 || index >= config.apiKeys.length) {
      return res.status(404).json({ error: 'API Key not found' });
    }
    
    if (config.apiKeys.length <= 1) {
      return res.status(400).json({ error: 'Cannot delete the last API Key' });
    }
    
    config.apiKeys.splice(index, 1);
    await writeFile(GATEWAY_CONFIG_FILE, config);
    res.json({ success: true, apiKeys: config.apiKeys });
  } catch (error) {
    console.error('Delete key error:', error);
    res.status(500).json({ error: error.message });
  }
});

// ============== 静态文件服务（所有路由之后） ==============
app.use(express.static(__dirname));

init().then(() => {
  app.listen(PORT, () => {
    console.log('AI API Gateway Started!');
    console.log(`Server:         http://localhost:${PORT}`);
    console.log('Vendor Manager: http://localhost:3001/api-manager-ui.html');
    console.log('Key Manager:    http://localhost:3001/api-server-ui.html');
    console.log('Diagnose:       http://localhost:3001/diagnose.html');
  });
});

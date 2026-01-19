import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';

const app = express();
app.use(cors());
app.use(express.json());

const PORT = 3000;

// Product catalog (prices in cents)
const PRODUCTS = [
  { id: '1', name: 'Red Roses', price: 299, stock: 100 },
  { id: '2', name: 'Pink Tulips', price: 199, stock: 80 },
  { id: '3', name: 'White Lilies', price: 399, stock: 60 }
];

const checkouts = new Map();
const processedRequests = new Map();
let lineItemCounter = 0;

// ============================================
// MIDDLEWARE
// ============================================

// UCP Headers Middleware
app.use((req, res, next) => {
  const ucpAgent = req.get('UCP-Agent');
  const requestId = req.get('request-id');
  const idempotencyKey = req.get('idempotency-key');
  
  req.ucpHeaders = {
    agent: ucpAgent,
    requestId: requestId,
    idempotencyKey: idempotencyKey
  };
  
  next();
});

// Rate Limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // limit each IP to 100 requests per windowMs
  message: 'Too many requests, please try again later'
});

app.use('/api/', limiter);

// Idempotency Middleware
function handleIdempotency(req, res, next) {
  const idempotencyKey = req.get('idempotency-key');
  
  if (idempotencyKey && processedRequests.has(idempotencyKey)) {
    return res.json(processedRequests.get(idempotencyKey));
  }
  
  req.idempotencyKey = idempotencyKey;
  next();
}

// ============================================
// HELPER FUNCTIONS
// ============================================

function createUcpMetadata() {
  return {
    version: '2026-01-11',
    capabilities: [{ name: 'dev.ucp.shopping.checkout', version: '2026-01-11' }]
  };
}

function calculateTotals(lineItems) {
  const subtotal = lineItems.reduce((sum, item) => sum + (item.item.price * item.quantity), 0);
  const tax = Math.round(subtotal * 0.08);
  const total = subtotal + tax;
  
  return [
    { type: 'subtotal', amount: subtotal, display_text: 'Subtotal' },
    { type: 'tax', amount: tax, display_text: 'Tax (8%)' },
    { type: 'total', amount: total, display_text: 'Total' }
  ];
}

function createLineItem(productId, quantity) {
  const product = PRODUCTS.find(p => p.id === productId);
  if (!product) return null;
  
  lineItemCounter++;
  return {
    id: `li_${lineItemCounter}_${Date.now()}`,
    item: { id: product.id, title: product.name, price: product.price },
    quantity: quantity,
    totals: [{ type: 'subtotal', amount: product.price * quantity }]
  };
}

function determineStatus(checkout) {
  if (!checkout.buyer?.email || !checkout.buyer?.full_name) return 'incomplete';
  if (checkout.line_items.length === 0) return 'incomplete';
  return 'ready_for_complete';
}

function validateCheckout(checkout) {
  const messages = [];
  
  if (!checkout.buyer?.email) {
    messages.push({
      type: 'error',
      code: 'missing_buyer_email',
      severity: 'recoverable',
      content: 'Buyer email is required',
      path: '$.buyer.email'
    });
  }
  
  if (!checkout.buyer?.full_name) {
    messages.push({
      type: 'error',
      code: 'missing_buyer_name',
      severity: 'recoverable',
      content: 'Buyer name is required',
      path: '$.buyer.full_name'
    });
  }
  
  return messages;
}

function validateLineItems(lineItems) {
  if (!Array.isArray(lineItems) || lineItems.length === 0) {
    throw new Error('line_items must be a non-empty array');
  }
  
  lineItems.forEach(item => {
    if (!item.item?.id || !item.quantity) {
      throw new Error('Each line item must have item.id and quantity');
    }
    if (item.quantity < 1 || item.quantity > 100) {
      throw new Error('Quantity must be between 1 and 100');
    }
  });
}

function sanitizeEmail(email) {
  if (!email) return null;
  const trimmed = email.trim().toLowerCase();
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(trimmed) ? trimmed : null;
}

function sanitizeName(name) {
  if (!name) return null;
  return name.trim().slice(0, 100); // Limit name length
}

function ucpError(code, message, severity = 'requires_buyer_input') {
  return {
    ucp: createUcpMetadata(),
    status: 'canceled',
    messages: [{
      type: 'error',
      code: code,
      severity: severity,
      content: message
    }]
  };
}

// ============================================
// UCP DISCOVERY (Required by UCP)
// ============================================
app.get('/.well-known/ucp', (req, res) => {
  res.json({
    ucp: {
      version: '2026-01-11',
      services: {
        'dev.ucp.shopping': {
          version: '2026-01-11',
          spec: 'https://ucp.dev/specification/overview',
          rest: {
            schema: 'https://ucp.dev/services/shopping/rest.openapi.json',
            endpoint: `http://localhost:${PORT}/api`
          }
        }
      },
      capabilities: [
        {
          name: 'dev.ucp.shopping.checkout',
          version: '2026-01-11',
          spec: 'https://ucp.dev/specification/checkout',
          schema: 'https://ucp.dev/schemas/shopping/checkout.json'
        }
      ]
    },
    payment: {
      handlers: [
        {
          id: 'demo_payment',
          name: 'dev.ucp.demo_tokenizer',
          version: '2026-01-11',
          spec: 'https://ucp.dev/specification/examples/business-tokenizer-payment-handler',
          config_schema: 'https://ucp.dev/schemas/payments/business-tokenizer.json',
          instrument_schemas: ['https://ucp.dev/schemas/shopping/types/card_payment_instrument.json'],
          config: { 
            type: 'CARD', 
            demo_mode: true,
            environment: 'sandbox'
          }
        }
      ]
    },
    signing_keys: []
  });
});

// ============================================
// API ENDPOINTS
// ============================================

// List products
app.get('/api/products', (req, res) => {
  res.json({ products: PRODUCTS });
});

// Create checkout
app.post('/api/checkout-sessions', handleIdempotency, (req, res) => {
  try {
    const { line_items, buyer, currency } = req.body;
    
    // Validate line items
    if (line_items && line_items.length > 0) {
      validateLineItems(line_items);
    }
    
    const checkoutId = `chk_${Date.now()}`;
    const lineItemsResponse = (line_items || [])
      .map(li => createLineItem(li.item.id, li.quantity))
      .filter(li => li !== null);
    
    // Sanitize buyer data
    const sanitizedBuyer = {};
    if (buyer?.email) {
      const cleanEmail = sanitizeEmail(buyer.email);
      if (cleanEmail) sanitizedBuyer.email = cleanEmail;
    }
    if (buyer?.full_name) {
      const cleanName = sanitizeName(buyer.full_name);
      if (cleanName) sanitizedBuyer.full_name = cleanName;
    }
    
    const checkout = {
      id: checkoutId,
      line_items: lineItemsResponse,
      buyer: sanitizedBuyer,
      currency: currency || 'USD',
      totals: calculateTotals(lineItemsResponse),
      messages: [],
      links: [
        { type: 'privacy_policy', url: `http://localhost:${PORT}/privacy`, title: 'Privacy Policy' },
        { type: 'terms_of_service', url: `http://localhost:${PORT}/terms`, title: 'Terms of Service' }
      ],
      expires_at: new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString(),
      payment: {
        handlers: [
          {
            id: 'demo_payment',
            name: 'dev.ucp.demo_tokenizer',
            version: '2026-01-11',
            spec: 'https://ucp.dev/specification/examples/business-tokenizer-payment-handler',
            config_schema: 'https://ucp.dev/schemas/payments/business-tokenizer.json',
            instrument_schemas: ['https://ucp.dev/schemas/shopping/types/card_payment_instrument.json'],
            config: { 
              type: 'CARD',
              environment: 'sandbox'
            }
          }
        ],
        instruments: []
      }
    };
    
    checkout.messages = validateCheckout(checkout);
    checkout.status = determineStatus(checkout);
    
    checkouts.set(checkoutId, checkout);
    
    const responseData = {
      ucp: createUcpMetadata(),
      ...checkout
    };
    
    // Store for idempotency
    if (req.idempotencyKey) {
      processedRequests.set(req.idempotencyKey, responseData);
    }
    
    res.status(201).json(responseData);
  } catch (error) {
    res.status(400).json(ucpError('invalid_request', error.message));
  }
});

// Get checkout
app.get('/api/checkout-sessions/:id', (req, res) => {
  const checkout = checkouts.get(req.params.id);
  
  if (!checkout) {
    return res.status(404).json(ucpError('not_found', 'Checkout not found'));
  }
  
  // Check if expired
  if (new Date(checkout.expires_at) < new Date()) {
    checkouts.delete(req.params.id);
    return res.status(404).json(ucpError('expired', 'Checkout session has expired'));
  }
  
  res.json({ ucp: createUcpMetadata(), ...checkout });
});

// Update checkout
app.put('/api/checkout-sessions/:id', handleIdempotency, (req, res) => {
  try {
    const checkout = checkouts.get(req.params.id);
    
    if (!checkout) {
      return res.status(404).json(ucpError('not_found', 'Checkout not found'));
    }
    
    // Check if expired
    if (new Date(checkout.expires_at) < new Date()) {
      checkouts.delete(req.params.id);
      return res.status(404).json(ucpError('expired', 'Checkout session has expired'));
    }
    
    const { line_items, buyer } = req.body;
    
    if (line_items) {
      validateLineItems(line_items);
      const lineItemsResponse = line_items.map(li => createLineItem(li.item.id, li.quantity)).filter(li => li !== null);
      checkout.line_items = lineItemsResponse;
      checkout.totals = calculateTotals(lineItemsResponse);
    }
    
    if (buyer) {
      // Sanitize buyer data
      if (buyer.email) {
        const cleanEmail = sanitizeEmail(buyer.email);
        if (cleanEmail) checkout.buyer.email = cleanEmail;
      }
      if (buyer.full_name) {
        const cleanName = sanitizeName(buyer.full_name);
        if (cleanName) checkout.buyer.full_name = cleanName;
      }
    }
    
    checkout.messages = validateCheckout(checkout);
    checkout.status = determineStatus(checkout);
    
    checkouts.set(req.params.id, checkout);
    
    const responseData = {
      ucp: createUcpMetadata(),
      ...checkout
    };
    
    // Store for idempotency
    if (req.idempotencyKey) {
      processedRequests.set(req.idempotencyKey, responseData);
    }
    
    res.json(responseData);
  } catch (error) {
    res.status(400).json(ucpError('invalid_request', error.message));
  }
});

// Complete checkout
app.post('/api/checkout-sessions/:id/complete', handleIdempotency, (req, res) => {
  try {
    const checkout = checkouts.get(req.params.id);
    
    if (!checkout) {
      return res.status(404).json(ucpError('not_found', 'Checkout not found'));
    }
    
    // Check if expired
    if (new Date(checkout.expires_at) < new Date()) {
      checkouts.delete(req.params.id);
      return res.status(404).json(ucpError('expired', 'Checkout session has expired'));
    }
    
    if (checkout.status !== 'ready_for_complete') {
      return res.status(400).json({
        ucp: createUcpMetadata(),
        ...checkout,
        messages: [{ 
          type: 'error', 
          code: 'not_ready', 
          severity: 'requires_buyer_input', 
          content: 'Please add email and full name first' 
        }]
      });
    }
    
    const orderId = `ORD_${Date.now()}`;
    checkout.order = {
      id: orderId,
      permalink_url: `http://localhost:${PORT}/orders/${orderId}`
    };
    
    checkout.status = 'completed';
    checkout.messages = [{ 
      type: 'info', 
      content: 'Order placed successfully!', 
      code: 'order_confirmed' 
    }];
    
    checkouts.set(req.params.id, checkout);
    
    const responseData = {
      ucp: createUcpMetadata(),
      ...checkout
    };
    
    // Store for idempotency
    if (req.idempotencyKey) {
      processedRequests.set(req.idempotencyKey, responseData);
    }
    
    res.json(responseData);
  } catch (error) {
    res.status(400).json(ucpError('invalid_request', error.message));
  }
});

// ============================================
// SESSION CLEANUP
// ============================================

// Clean up expired sessions every minute
setInterval(() => {
  const now = new Date();
  for (const [id, checkout] of checkouts.entries()) {
    if (new Date(checkout.expires_at) < now) {
      checkouts.delete(id);
    }
  }
}, 60000);

// Clean up old idempotency records every hour
setInterval(() => {
  processedRequests.clear();
}, 3600000);

// ============================================
// START SERVER
// ============================================

app.listen(PORT, () => {
  console.log('\n🌸 UCP Flower Shop Server');
  console.log('========================');
  console.log(`✅ Running: http://localhost:${PORT}`);
  console.log(`✅ Discovery: http://localhost:${PORT}/.well-known/ucp`);
  console.log(`✅ Products: http://localhost:${PORT}/api/products`);
  console.log('\n📋 UCP Compliant: YES');
  console.log('🔒 Security: Rate limiting enabled');
  console.log('♻️  Cleanup: Auto-expiring sessions');
  console.log('\n⚠️  POC/DEMO ONLY - NOT PRODUCTION READY\n');
});

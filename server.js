import express from 'express';
import cors from 'cors';

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
let lineItemCounter = 0;

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
          config: { type: 'CARD', demo_mode: true }
        }
      ]
    },
    signing_keys: []
  });
});

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
  if (!checkout.buyer?.email) return 'incomplete';
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
  return messages;
}

// ============================================
// API ENDPOINTS
// ============================================

// List products
app.get('/api/products', (req, res) => {
  res.json({ products: PRODUCTS });
});

// Create checkout
app.post('/api/checkout-sessions', (req, res) => {
  const { line_items, buyer, currency } = req.body;
  
  const checkoutId = `chk_${Date.now()}`;
  const lineItemsResponse = (line_items || [])
    .map(li => createLineItem(li.item.id, li.quantity))
    .filter(li => li !== null);
  
  const checkout = {
    id: checkoutId,
    line_items: lineItemsResponse,
    buyer: buyer || {},
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
          config: { type: 'CARD' }
        }
      ],
      instruments: []
    }
  };
  
  checkout.messages = validateCheckout(checkout);
  checkout.status = determineStatus(checkout);
  
  checkouts.set(checkoutId, checkout);
  
  res.status(201).json({
    ucp: createUcpMetadata(),
    ...checkout
  });
});

// Get checkout
app.get('/api/checkout-sessions/:id', (req, res) => {
  const checkout = checkouts.get(req.params.id);
  
  if (!checkout) {
    return res.status(404).json({
      ucp: createUcpMetadata(),
      status: 'canceled',
      messages: [{ type: 'error', code: 'not_found', severity: 'requires_buyer_input', content: 'Checkout not found' }]
    });
  }
  
  res.json({ ucp: createUcpMetadata(), ...checkout });
});

// Update checkout
app.put('/api/checkout-sessions/:id', (req, res) => {
  const checkout = checkouts.get(req.params.id);
  
  if (!checkout) {
    return res.status(404).json({
      ucp: createUcpMetadata(),
      status: 'canceled',
      messages: [{ type: 'error', code: 'not_found', severity: 'requires_buyer_input', content: 'Checkout not found' }]
    });
  }
  
  const { line_items, buyer } = req.body;
  
  if (line_items) {
    const lineItemsResponse = line_items.map(li => createLineItem(li.item.id, li.quantity)).filter(li => li !== null);
    checkout.line_items = lineItemsResponse;
    checkout.totals = calculateTotals(lineItemsResponse);
  }
  
  if (buyer) {
    checkout.buyer = { ...checkout.buyer, ...buyer };
  }
  
  checkout.messages = validateCheckout(checkout);
  checkout.status = determineStatus(checkout);
  
  checkouts.set(req.params.id, checkout);
  
  res.json({ ucp: createUcpMetadata(), ...checkout });
});

// Complete checkout
app.post('/api/checkout-sessions/:id/complete', (req, res) => {
  const checkout = checkouts.get(req.params.id);
  
  if (!checkout) {
    return res.status(404).json({
      ucp: createUcpMetadata(),
      status: 'canceled',
      messages: [{ type: 'error', code: 'not_found', severity: 'requires_buyer_input', content: 'Checkout not found' }]
    });
  }
  
  if (checkout.status !== 'ready_for_complete') {
    return res.status(400).json({
      ucp: createUcpMetadata(),
      ...checkout,
      messages: [{ type: 'error', code: 'not_ready', severity: 'requires_buyer_input', content: 'Please add email first' }]
    });
  }
  
  const orderId = `ORD_${Date.now()}`;
  checkout.order = {
    id: orderId,
    permalink_url: `http://localhost:${PORT}/orders/${orderId}`
  };
  
  checkout.status = 'completed';
  checkout.messages = [{ type: 'info', content: 'Order placed successfully!', code: 'order_confirmed' }];
  
  checkouts.set(req.params.id, checkout);
  
  res.json({ ucp: createUcpMetadata(), ...checkout });
});

// Start server
app.listen(PORT, () => {
  console.log('\n🌸 UCP Flower Shop Server');
  console.log('========================');
  console.log(`✅ Running: http://localhost:${PORT}`);
  console.log(`✅ Discovery: http://localhost:${PORT}/.well-known/ucp`);
  console.log(`✅ Products: http://localhost:${PORT}/api/products`);
  console.log('\n📋 UCP Compliant: YES\n');
});
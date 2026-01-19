import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const SHOP_URL = 'http://localhost:3000';

const server = new Server(
  { name: 'ucp-flower-shop', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

// Helper function to make API requests
async function apiCall(endpoint, method = 'GET', body = null) {
  const options = {
    method,
    headers: { 'Content-Type': 'application/json' }
  };
  if (body) options.body = JSON.stringify(body);
  
  const response = await fetch(`${SHOP_URL}${endpoint}`, options);
  return response.json();
}

// Helper to convert product name to ID
function getProductId(nameOrId) {
  const input = String(nameOrId).toLowerCase().trim();
  
  // Direct ID match
  if (input === '1' || input === '2' || input === '3') return input;
  
  // Product name matching
  if (input.includes('rose')) return '1';
  if (input.includes('tulip')) return '2';
  if (input.includes('lily') || input.includes('lilies')) return '3';
  
  return '1'; // Default to roses if unclear
}

// Define tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'browse_products',
        description: 'Browse available flowers',
        inputSchema: { type: 'object', properties: {} }
      },
      {
        name: 'create_checkout',
        description: 'Create checkout with flowers',
        inputSchema: {
          type: 'object',
          properties: {
            line_items: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  product_id: { type: 'string', description: 'Product ID or name (e.g., "1" or "Red Roses")' },
                  quantity: { type: 'number' }
                },
                required: ['product_id', 'quantity']
              }
            },
            buyer_email: { type: 'string' }
          },
          required: ['line_items']
        }
      },
      {
        name: 'update_checkout',
        description: 'Update checkout (add email or change items)',
        inputSchema: {
          type: 'object',
          properties: {
            checkout_id: { type: 'string' },
            buyer_email: { type: 'string' },
            line_items: { 
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  product_id: { type: 'string' },
                  quantity: { type: 'number' }
                }
              }
            }
          },
          required: ['checkout_id']
        }
      },
      {
        name: 'get_checkout',
        description: 'View current checkout',
        inputSchema: {
          type: 'object',
          properties: {
            checkout_id: { type: 'string' }
          },
          required: ['checkout_id']
        }
      },
      {
        name: 'complete_checkout',
        description: 'Complete the order',
        inputSchema: {
          type: 'object',
          properties: {
            checkout_id: { type: 'string' }
          },
          required: ['checkout_id']
        }
      }
    ]
  };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    if (name === 'browse_products') {
      const data = await apiCall('/api/products');
      let text = '🌸 Available Flowers:\n\n';
      data.products.forEach(p => {
        text += `${p.id}. ${p.name} - $${(p.price / 100).toFixed(2)} (${p.stock} available)\n`;
      });
      return { content: [{ type: 'text', text }] };
    }

    if (name === 'create_checkout') {
      const body = {
        line_items: args.line_items.map(item => ({
          item: { id: getProductId(item.product_id) },
          quantity: item.quantity
        })),
        currency: 'USD'
      };
      
      if (args.buyer_email) {
        body.buyer = { email: args.buyer_email };
      }
      
      const checkout = await apiCall('/api/checkout-sessions', 'POST', body);
      
      let text = `✅ Checkout Created!\n\nID: ${checkout.id}\nStatus: ${checkout.status}\n\n`;
      text += '🛒 Cart:\n';
      checkout.line_items.forEach(item => {
        text += `  ${item.quantity}x ${item.item.title} - $${(item.item.price * item.quantity / 100).toFixed(2)}\n`;
      });
      text += `\n💰 Total: $${(checkout.totals.find(t => t.type === 'total').amount / 100).toFixed(2)}\n`;
      
      if (checkout.messages.length > 0) {
        text += '\n⚠️ ' + checkout.messages[0].content;
      }
      
      return { content: [{ type: 'text', text }] };
    }

    if (name === 'update_checkout') {
      const body = { currency: 'USD' };
      
      if (args.buyer_email) {
        body.buyer = { email: args.buyer_email };
      }
      
      if (args.line_items) {
        body.line_items = args.line_items.map(item => ({
          item: { id: getProductId(item.product_id) },
          quantity: item.quantity
        }));
      }
      
      const checkout = await apiCall(`/api/checkout-sessions/${args.checkout_id}`, 'PUT', body);
      
      let text = `✅ Checkout Updated!\n\nStatus: ${checkout.status}\n\n`;
      if (checkout.buyer?.email) {
        text += `📧 Email: ${checkout.buyer.email}\n\n`;
      }
      text += '🛒 Cart:\n';
      checkout.line_items.forEach(item => {
        text += `  ${item.quantity}x ${item.item.title} - $${(item.item.price * item.quantity / 100).toFixed(2)}\n`;
      });
      text += `\n💰 Total: $${(checkout.totals.find(t => t.type === 'total').amount / 100).toFixed(2)}\n`;
      
      if (checkout.status === 'ready_for_complete') {
        text += '\n✨ Ready to complete!';
      }
      
      return { content: [{ type: 'text', text }] };
    }

    if (name === 'get_checkout') {
      const checkout = await apiCall(`/api/checkout-sessions/${args.checkout_id}`);
      
      let text = `📋 Checkout: ${checkout.id}\n\nStatus: ${checkout.status}\n\n`;
      if (checkout.buyer?.email) {
        text += `📧 Email: ${checkout.buyer.email}\n\n`;
      }
      text += '🛒 Cart:\n';
      checkout.line_items.forEach(item => {
        text += `  ${item.quantity}x ${item.item.title} - $${(item.item.price * item.quantity / 100).toFixed(2)}\n`;
      });
      text += `\n💰 Total: $${(checkout.totals.find(t => t.type === 'total').amount / 100).toFixed(2)}\n`;
      
      return { content: [{ type: 'text', text }] };
    }

    if (name === 'complete_checkout') {
      const body = {
        payment_data: {
          id: 'pm_demo',
          handler_id: 'demo_payment',
          type: 'card',
          brand: 'visa',
          last_digits: '4242',
          credential: { type: 'token', token: 'tok_demo' }
        }
      };
      
      const checkout = await apiCall(`/api/checkout-sessions/${args.checkout_id}/complete`, 'POST', body);
      
      let text = `🎉 ORDER CONFIRMED!\n\n`;
      text += `Order ID: ${checkout.order.id}\n`;
      text += `Total: $${(checkout.totals.find(t => t.type === 'total').amount / 100).toFixed(2)}\n\n`;
      text += checkout.messages[0].content;
      
      return { content: [{ type: 'text', text }] };
    }

    throw new Error(`Unknown tool: ${name}`);
    
  } catch (error) {
    return {
      content: [{ type: 'text', text: `❌ Error: ${error.message}` }],
      isError: true
    };
  }
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('🌸 MCP Server Ready\n');
}

main().catch(console.error);

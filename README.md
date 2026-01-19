# UCP Flower Shop Demo

A UCP-compliant flower shop that works with Claude Desktop.

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Start the Server

```bash
npm start
```

Server runs on http://localhost:3000

### 3. Test It Works

Open browser: http://localhost:3000/.well-known/ucp

You should see UCP discovery data.

## Claude Desktop Setup

### Find Your Config File

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`  
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

### Add This Configuration

```json
{
  "mcpServers": {
    "flower-shop": {
      "command": "node",
      "args": [
        "/FULL/PATH/TO/ucp-flower-shop/mcp-server.js"
      ]
    }
  }
}
```

**Important**: Replace `/FULL/PATH/TO/` with the actual path to this folder!

### Restart Claude Desktop

Completely quit and restart Claude Desktop.

## Try It Out

In Claude Desktop, try:

```
"What flowers are available?"

"I want to buy 12 red roses with email: test@example.com"

"Complete my order"
```

## API Endpoints

- `GET /.well-known/ucp` - UCP discovery
- `GET /api/products` - List flowers
- `POST /api/checkout-sessions` - Create checkout
- `PUT /api/checkout-sessions/:id` - Update checkout
- `POST /api/checkout-sessions/:id/complete` - Complete order

## Products

1. Red Roses - $2.99
2. Pink Tulips - $1.99
3. White Lilies - $3.99

## UCP Compliance

✅ Discovery endpoint  
✅ UCP metadata in responses  
✅ Status lifecycle  
✅ Messages array  
✅ Links array  
✅ Payment handlers  
✅ Totals as array  

## License

MIT

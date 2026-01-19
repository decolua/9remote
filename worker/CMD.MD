# Worker Commands

## Development
```bash
# Run local dev server
npm run dev

# Run with specific port
wrangler dev --port 8787
```

## Deploy
```bash
# Deploy to Cloudflare
npm run deploy

# Deploy with specific env
wrangler deploy --env production
```

## KV Storage
```bash
# List all KV namespaces
wrangler kv namespace list

# List keys in KV
wrangler kv key list --namespace-id=bab4e68389474897a73e10509c084b02

# Get value by key
wrangler kv key get "KEY_NAME" --namespace-id=bab4e68389474897a73e10509c084b02

# Put value
wrangler kv key put "KEY_NAME" "VALUE" --namespace-id=bab4e68389474897a73e10509c084b02

# Delete key
wrangler kv key delete "KEY_NAME" --namespace-id=bab4e68389474897a73e10509c084b02
```

## Logs
```bash
# Tail real-time logs
wrangler tail

# Tail with filter
wrangler tail --format=pretty
```

## Secrets
```bash
# List secrets
wrangler secret list

# Add secret
wrangler secret put SECRET_NAME

# Delete secret
wrangler secret delete SECRET_NAME
```

## Other
```bash
# Check worker status
wrangler whoami

# Login to Cloudflare
wrangler login

# Logout
wrangler logout
```


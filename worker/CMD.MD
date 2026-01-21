# Cloudflare Worker Commands

## Database Migration

### Apply schema changes to D1 database

```bash
# Development
npx wrangler d1 execute 9remote-db --local --file=./schema.sql

# Production
npx wrangler d1 execute 9remote-db --remote --file=./schema.sql
```

## Deploy Worker

```bash
# Deploy to production
npx wrangler deploy

# Deploy with live logs
npx wrangler deploy --watch
```

## View Logs

```bash
# Tail production logs
npx wrangler tail

# Tail with filters
npx wrangler tail --format=pretty
```

## Database Management

```bash
# Query database (local)
npx wrangler d1 execute 9remote-db --local --command="SELECT * FROM temp_keys"

# Query database (production)
npx wrangler d1 execute 9remote-db --remote --command="SELECT * FROM temp_keys"

# Clear expired temp keys manually
npx wrangler d1 execute 9remote-db --remote --command="DELETE FROM temp_keys WHERE expires_at < $(date +%s)000"
```

## Test Locally

```bash
# Start local dev server
npx wrangler dev

# Test with local D1
npx wrangler dev --local
```

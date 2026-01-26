# 9Remote Documentation

Deploy to Cloudflare Pages: https://docs.9router.com

## Local Development

```bash
npm run dev
```

Visit: http://localhost:3001

## Build

```bash
npm run build
```

Output: `out/` folder (static files)

## Deploy to Cloudflare Pages

### First Time Setup

1. Login to Cloudflare:
```bash
npx wrangler login
```

2. Create Pages project:
```bash
npx wrangler pages project create 9remote-docs
```

3. Deploy:
```bash
npm run build
npx wrangler pages deploy out --project-name=9remote-docs
```

### Subsequent Deploys

From root directory:
```bash
npm run deploy:docs
```

Or from gitbook directory:
```bash
npm run build
npx wrangler pages deploy out --project-name=9remote-docs
```

## Custom Domain

1. Go to Cloudflare Dashboard
2. Pages → 9remote-docs → Custom domains
3. Add: `docs.9router.com`
4. DNS will be configured automatically

## Environment

- **Production**: https://docs.9router.com
- **Preview**: https://9remote-docs.pages.dev

## Structure

```
gitbook/
├── app/           # Next.js pages
├── components/    # React components
├── content/       # Markdown docs
├── constants/     # Config
├── utils/         # Utilities
└── out/           # Build output (gitignored)
```

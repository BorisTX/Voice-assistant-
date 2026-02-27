# Voice Assistant

## Run

```bash
npm install
npm run dev
```

## Smoke check

1. Start server (`npm run dev`).
2. Health check:
   ```bash
   curl -i http://127.0.0.1:10000/
   ```
3. Available slots check without business id:
   ```bash
   curl -i "http://127.0.0.1:10000/api/available-slots"
   ```
4. Available slots check with business id (replace value):
   ```bash
   curl -i "http://127.0.0.1:10000/api/available-slots?business_id=<business_id>"
   ```

Or run the helper script:

```bash
node scripts/smoke.js
# optional:
# SMOKE_BUSINESS_ID=<business_id> node scripts/smoke.js
```

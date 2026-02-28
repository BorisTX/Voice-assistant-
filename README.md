## Booking concurrency test

Run the deterministic parallel booking check (10 requests to the same slot):

```bash
BASE_URL=http://127.0.0.1:10000 \
BUSINESS_ID=<your_business_id> \
START_LOCAL=2026-03-01T10:00:00 \
DURATION_MIN=60 \
node scripts/book_concurrency_test.js
```

Expected result: `success (200)` is at most `1`.

## Create booking API

```bash
curl -X POST http://127.0.0.1:10000/api/bookings \
  -H "Content-Type: application/json" \
  -d '{
    "businessId": "<business-id>",
    "startLocal": "2026-02-28T14:00:00",
    "timezone": "America/Chicago",
    "durationMins": 120,
    "bufferMins": 15,
    "service": "repair",
    "customer": {
      "name": "John Doe",
      "phone": "+14690000000",
      "email": "john@example.com",
      "address": "123 Main St"
    },
    "notes": "Call on arrival"
  }'
```

## Booking concurrency test

Run the deterministic parallel booking check (10 requests to the same slot):

```bash
BASE_URL=http://127.0.0.1:10000 \
BUSINESS_ID=<your_business_id> \
START_LOCAL=2026-03-01T10:00:00 \
TIMEZONE=America/Chicago \
DURATION_MIN=60 \
node scripts/book_concurrency_test.js
```

Expected result: `success (200)` is at most `1`.

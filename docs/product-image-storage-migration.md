# Product Image Storage Migration

Production product images used to be stored as base64 strings inside the
`settings.products` JSON value. This migration moves product images to public
Supabase Storage URLs while keeping the app backward-compatible with existing
base64 values.

## Safety Rules

- Back up `settings.products` and `settings.productCosts` before migration.
- Run dry-run before migration.
- The migration uploads and verifies each image before it writes product JSON.
- Only products with verified uploaded images are changed.
- If any upload or verification fails, the endpoint stops and does not persist
  migrated product JSON.
- Rollback restores the backed-up product settings and does not delete Storage
  objects.

## Endpoints

All endpoints require an authenticated Owner/Admin session.

- `GET /api/products/image-storage/dry-run`
- `POST /api/products/image-storage/migrate`
- `GET /api/products/image-storage/verify`
- `POST /api/products/image-storage/rollback`

Rollback body:

```json
{
  "confirm": "ROLLBACK_PRODUCT_IMAGES",
  "products": [],
  "productCosts": []
}
```

## Production Procedure

1. Back up the authenticated `/api/state` response and save at least:
   `settings.products` and `settings.productCosts`.
2. Call dry-run and record product count, migrate count, skipped count, and
   total base64 bytes.
3. Call migrate.
4. If migrate returns `ok: false`, stop. Do not report success. Use rollback
   with the backup if any product settings were changed.
5. Call verify. It must return `ok: true` and zero failed images.
6. Fetch `/api/state` again and compare product identities, image presence,
   package data, and product costs against the backup.
7. Test Add Product, Edit Product without image change, Edit Product with new
   image, refresh, logout/login, desktop, and mobile.
8. Restore any temporary test product changes with rollback from the clean
   post-migration backup.

## Storage

Default bucket: `product-images`

Object path:

```text
products/{productId}/{sha256}.{extension}
```

The hash is calculated from the original image bytes, so the migration is
idempotent and resumable. Uploads use upsert, and products already using Storage
URLs are skipped.

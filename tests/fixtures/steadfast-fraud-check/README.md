# Steadfast fraud-check fixture

`documented-shape.json` is the **example response shown in the README of Steadfast's own published client package**
(Packagist `steadfast-courier/steadfast-laravel-package` 2.0.0, endpoint `GET /fraud_check/{phone}`).

It is **not** a captured live response: no live call has ever been made from this project. It exists only so the tests exercise the documented
field names. If the first real call on staging returns a different shape, the adapter reports `invalid_response` (never a guess) and this fixture
and `src/lib/courier-intelligence/steadfast-map.ts` must be corrected together.

The earlier fixtures (`delivered_count`, `delivery_ratio`, `volume_band`) came from third-party descriptions and do not match that documentation;
they were removed in P6.

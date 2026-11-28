/** Format of the per-attempt checkout idempotency key (random, generated in the browser). Shared by the checkout schema and the tests. */
export const CHECKOUT_KEY_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

import { test } from "node:test";
import assert from "node:assert/strict";
import { addKeywords, keywordsForMetadata, normalizeKeywords, parseKeywordInput, MAX_KEYWORDS } from "@/lib/seo-keywords";

test("comma-separated paste becomes separate trimmed tags", () => {
  assert.deepEqual(parseKeywordInput("handmade gifts, clay crafts, gift box, Bangladesh"), ["handmade gifts", "clay crafts", "gift box", "Bangladesh"]);
});
test("empties are ignored and duplicates removed case-insensitively (first spelling wins)", () => {
  assert.deepEqual(parseKeywordInput(" a ,, A,b ,  ,B "), ["a", "b"]);
  assert.deepEqual(addKeywords(["Gift Box"], "gift box, new"), ["Gift Box", "new"]);
});
test("length and count are capped; metadata is undefined when empty", () => {
  assert.equal(parseKeywordInput("x".repeat(200))[0].length, 60);
  assert.equal(normalizeKeywords(Array.from({ length: 50 }, (_, i) => `k${i}`)).length, MAX_KEYWORDS);
  assert.equal(keywordsForMetadata([]), undefined);
  assert.equal(keywordsForMetadata(null), undefined);
});

-- Keep only the newest result for each answer/category before enforcing idempotent analysis updates.
DELETE FROM "AnalysisResult" older
USING "AnalysisResult" newer
WHERE older."answerId" = newer."answerId"
  AND older."kind" = newer."kind"
  AND (
    older."createdAt" < newer."createdAt"
    OR (older."createdAt" = newer."createdAt" AND older."id" < newer."id")
  );

DROP INDEX IF EXISTS "AnalysisResult_answerId_kind_idx";
CREATE UNIQUE INDEX "AnalysisResult_answerId_kind_key" ON "AnalysisResult"("answerId", "kind");

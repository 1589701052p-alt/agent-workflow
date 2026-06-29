-- RFC-126 — un-abandon legacy cross-clarify rounds (hand-written; data-only;
-- registered in meta/_journal.json). CR-1 was RETIRED: it abandoned
-- answered-but-unconsumed cross rounds on a FAILED task, which silently DROPPED the
-- human's answer when the task was later RESUMED (buildExternalFeedbackContext skips
-- 'abandoned' rounds). Flip any pre-RFC-126 'abandoned' rows back to 'answered'
-- (clear abandoned_at) so a resumed designer rerun re-consumes the feedback, and so
-- no 'abandoned' rows linger after the closed-phase removal. No schema change.
-- Open CR-1 lifecycle alerts auto-resolve on the next invariant scan (CR-1 stays
-- registered in INVARIANT_RULES but produces no findings). The two statements are
-- separated by the breakpoint marker below — REQUIRED, or only the first applies.
UPDATE `cross_clarify_sessions` SET `status` = 'answered', `abandoned_at` = NULL WHERE `status` = 'abandoned';
--> statement-breakpoint
UPDATE `clarify_rounds` SET `status` = 'answered', `abandoned_at` = NULL WHERE `status` = 'abandoned';

-- RFC-140 W2 — auto-serial redispatch marker for auto-split-deferred task questions.
-- Set in the dispatch stamp tx on entries deferred by the RFC-128 §5.2.13 cause auto-split;
-- read by the scheduler tick auto-redispatch (marker + undispatched + still staged).
ALTER TABLE `task_questions` ADD `auto_dispatch_deferred_at` integer;
